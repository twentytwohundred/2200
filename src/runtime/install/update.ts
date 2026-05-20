/**
 * Self-upgrade logic for `2200 update`.
 *
 * The update command queries the npm registry for the latest published
 * version of `@twentytwohundred/2200`, compares it to the version
 * embedded in this CLI, and (unless `--check` was passed) drops the
 * daemon, runs `npm install -g <package>@latest` in the user's shell,
 * and restarts the daemon.
 *
 * The user's 2200_HOME is never touched: it lives at the configured
 * data dir (e.g., `~/.local/share/2200/`); the upgrade only touches
 * the globally-installed package binary.
 *
 * Detection guarantees:
 *   - If the CLI is running from a source checkout (no `node_modules/`
 *     in the resolved path), we refuse to self-upgrade and tell the
 *     user to `git pull && pnpm build` instead. Auto-installing on top
 *     of a dev checkout would shadow the in-repo binary unpredictably.
 *   - If the registry query fails (offline, registry down, package
 *     not yet published), we report cleanly and exit non-zero.
 *
 * The actual `npm install` is shelled out to the user's `npm` binary
 * so global-permission flakiness, sudo prompts, and pnpm vs npm
 * differences land in the user's shell (where they can act) instead
 * of being papered over here.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Package name as published on the npm registry. */
export const PACKAGE_NAME = '@twentytwohundred/2200'

/** Stable URL for `npm view <pkg> dist-tags`-equivalent metadata. */
const REGISTRY_URL = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}`

/** Shape of the upstream `package.json` view we read from the registry. */
interface RegistryPackument {
  'dist-tags'?: { latest?: string }
  versions?: Record<string, unknown>
}

/** Outcome of the version-compare step. */
export type VersionCheck =
  | { kind: 'up-to-date'; current: string; latest: string }
  | { kind: 'update-available'; current: string; latest: string }
  | { kind: 'ahead'; current: string; latest: string }
  | { kind: 'registry-error'; current: string; message: string }

/**
 * Fetch the latest published version of the package and compare to the
 * one bundled into this CLI.
 */
export async function checkLatestVersion(
  current: string,
  opts: { registryUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<VersionCheck> {
  const url = opts.registryUrl ?? REGISTRY_URL
  const fetchImpl = opts.fetchImpl ?? fetch
  let res
  try {
    res = await fetchImpl(url, { headers: { Accept: 'application/json' } })
  } catch (err) {
    return {
      kind: 'registry-error',
      current,
      message: `network error: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (!res.ok) {
    return {
      kind: 'registry-error',
      current,
      message: `HTTP ${String(res.status)} from ${url}`,
    }
  }
  let body: RegistryPackument
  try {
    body = (await res.json()) as RegistryPackument
  } catch (err) {
    return {
      kind: 'registry-error',
      current,
      message: `malformed JSON from registry: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  const latest = body['dist-tags']?.latest
  if (typeof latest !== 'string' || latest.length === 0) {
    return {
      kind: 'registry-error',
      current,
      message: 'registry returned no dist-tags.latest (package not yet published?)',
    }
  }
  const cmp = compareSemver(current, latest)
  if (cmp === 0) return { kind: 'up-to-date', current, latest }
  if (cmp < 0) return { kind: 'update-available', current, latest }
  return { kind: 'ahead', current, latest }
}

/** Outcome of the "where did this CLI come from" detection. */
export type InstallSource =
  | { kind: 'npm-global'; path: string }
  | { kind: 'source-checkout'; path: string }

/**
 * Look at where this module was loaded from to decide whether the
 * CLI is running from an npm/pnpm global install (which we can
 * upgrade) or a source checkout (which we cannot).
 *
 * Source-checkout signal: the resolved module path contains no
 * `node_modules` segment. Anything else is treated as a managed
 * install ... npm-global, pnpm-global, or a project-local install
 * (`npm install @twentytwohundred/2200` then `npx 2200`).
 */
export function detectInstallSource(modulePath: string): InstallSource {
  const hasNodeModules = modulePath.split(/[\\/]/).includes('node_modules')
  if (!hasNodeModules) return { kind: 'source-checkout', path: modulePath }
  return { kind: 'npm-global', path: modulePath }
}

/** Re-export of the running module's path for the default detection. */
export function currentModulePath(meta: { url: string }): string {
  return fileURLToPath(meta.url)
}

/**
 * Spawn `npm install -g <pkg>@<version>` in the user's shell.
 *
 * Returns the exit code. stdout/stderr are forwarded to the parent
 * process so global-permission prompts and progress bars land where
 * the user expects them.
 */
export async function runNpmGlobalInstall(opts: {
  packageName: string
  version: string
  npmBin?: string
}): Promise<number> {
  const cmd = opts.npmBin ?? 'npm'
  const args = ['install', '-g', `${opts.packageName}@${opts.version}`]
  return new Promise<number>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => {
      resolve(code ?? 1)
    })
  })
}

/**
 * Compare two semver strings. Returns -1 if a < b, 0 if equal, 1 if a > b.
 *
 * Handles the subset of semver we care about: `MAJOR.MINOR.PATCH` with
 * optional `-prerelease` (which sorts below the same MAJOR.MINOR.PATCH
 * without prerelease). Build metadata (`+...`) is ignored.
 *
 * Not a full RFC 5234 semver implementation. It is intentionally small
 * and dependency-free; the registry-supplied `dist-tags.latest` is
 * always a clean semver, and our publishing pipeline never produces
 * exotic ranges, so this is sufficient.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  for (let i = 0; i < 3; i++) {
    const da = pa.parts[i] ?? 0
    const db = pb.parts[i] ?? 0
    if (da < db) return -1
    if (da > db) return 1
  }
  // Equal MAJOR.MINOR.PATCH: prerelease sorts below release.
  if (pa.pre === null && pb.pre === null) return 0
  if (pa.pre === null) return 1
  if (pb.pre === null) return -1
  if (pa.pre < pb.pre) return -1
  if (pa.pre > pb.pre) return 1
  return 0
}

function parseSemver(v: string): { parts: number[]; pre: string | null } {
  // Strip build metadata.
  const noBuild = v.split('+', 1)[0] ?? v
  const [coreRaw, ...preRest] = noBuild.split('-')
  const core = coreRaw ?? '0.0.0'
  const pre = preRest.length > 0 ? preRest.join('-') : null
  const parts = core
    .split('.')
    .map((s) => {
      const n = Number.parseInt(s, 10)
      return Number.isNaN(n) ? 0 : n
    })
    .slice(0, 3)
  while (parts.length < 3) parts.push(0)
  return { parts, pre }
}
