/**
 * Extension / Skill install source resolution.
 *
 * `2200 extension install <source>` and the web-driven skill install
 * path both accept:
 *
 *   - **Local directory**: an absolute or `~`-relative path to a
 *     directory containing a manifest.json (Extension) or SKILL.md
 *     (Skill). This is the authoritative path during local
 *     development.
 *
 *   - **GitHub URL**: an `https://github.com/<owner>/<repo>` URL or
 *     the shorthand `github:<owner>/<repo>`. The runtime shallow-
 *     clones the repo to a temp directory and treats the clone root
 *     as the local-directory case from then on.
 *
 *   - **Single SKILL.md URL**: an http(s) URL whose path ends in
 *     `/skill.md` (case-insensitive, query string allowed). The
 *     resolver fetches the file, writes it as `SKILL.md` into a
 *     temp directory, and returns that as the root. This is how
 *     vanity-published skill files like `https://openpub.ai/skill.md`
 *     install in one paste.
 *
 *   - **(future)** npm package identifier, marketplace slug,
 *     pre-built tarball URL. None at v1; the resolver throws
 *     `UnsupportedSourceError` so the surface is clean for the next
 *     sub-phase to extend.
 *
 * `resolveSource` always returns a working directory plus a cleanup
 * function. The orchestrator validates the contents, copies the
 * directory into place, then calls cleanup which is a no-op for local
 * dirs and an `rm -rf` for cloned or fetched temp dirs.
 *
 * No git or fetch authentication at v1: only public sources work.
 * Private repos and authed URLs wait until OAuth + per-source token
 * storage lands alongside the marketplace work.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export type ResolvedSourceKind = 'local' | 'github' | 'skill_url'

export interface ResolvedSource {
  /** Where the manifest.json + bundled files live. */
  rootDir: string
  /** Where the input came from (for telemetry / install prompt). */
  kind: ResolvedSourceKind
  /** The original source string the user passed, normalized. */
  origin: string
  /**
   * Cleanup callback. No-op for local; `rm -rf <tempdir>` for cloned
   * sources. The caller MUST call this once it has fully copied the
   * Extension into place (or aborted).
   */
  cleanup: () => Promise<void>
}

export class UnsupportedSourceError extends Error {
  constructor(source: string) {
    super(`Unsupported install source "${source}". Local path or github URL required at v1.`)
    this.name = 'UnsupportedSourceError'
  }
}

export class SourceResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SourceResolutionError'
  }
}

/**
 * GitHub URL shape detection. Accepts both the canonical
 * https://github.com/<owner>/<repo>(.git)? URL and the shorthand
 * github:<owner>/<repo>. Strict: must be a public github source,
 * exactly two path segments after the host.
 */
const GITHUB_URL_RE = /^https?:\/\/github\.com\/([^\s/]+)\/([^\s/]+?)(?:\.git)?\/?$/
const GITHUB_SHORTHAND_RE = /^github:([^\s/]+)\/([^\s/]+)$/

/**
 * Match an http(s) URL whose path component ends in `/skill.md`
 * (case-insensitive). Optional trailing query string allowed. Fragment
 * not allowed (rare in practice, ambiguous semantics). GitHub URLs are
 * filtered out separately so the github resolver wins on raw.github
 * URLs that happen to end in /SKILL.md.
 */
const SKILL_MD_URL_RE = /^https?:\/\/[^\s]+\/skill\.md(?:\?[^\s#]*)?$/i

export function parseGithubSource(source: string): { owner: string; repo: string } | null {
  const url = GITHUB_URL_RE.exec(source)
  if (url) {
    const [, owner, repo] = url
    if (owner && repo) return { owner, repo }
  }
  const short = GITHUB_SHORTHAND_RE.exec(source)
  if (short) {
    const [, owner, repo] = short
    if (owner && repo) return { owner, repo }
  }
  return null
}

export function isSkillMdUrl(source: string): boolean {
  return SKILL_MD_URL_RE.test(source)
}

/**
 * Expand a user-friendly path: ~ to homedir, relative to absolute via
 * `process.cwd()` (caller can override via the cwd arg for testing).
 */
function expandLocalPath(input: string, cwd: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/')) return join(homedir(), input.slice(2))
  if (isAbsolute(input)) return input
  return resolve(cwd, input)
}

export interface ResolveSourceOptions {
  cwd?: string
  /** Override the temp-dir factory (testing). */
  makeTempDir?: () => Promise<string>
  /** Override git executable location (testing or constrained envs). */
  gitBinary?: string
  /** Override the fetch implementation (testing). */
  fetchImpl?: typeof fetch
}

/**
 * Resolve a source string into a working directory. Throws on
 * unsupported sources, missing local dirs, missing git binary, or
 * clone failure. The caller is responsible for invoking `cleanup`
 * exactly once.
 */
export async function resolveSource(
  source: string,
  options: ResolveSourceOptions = {},
): Promise<ResolvedSource> {
  const cwd = options.cwd ?? process.cwd()
  const trimmed = source.trim()
  if (trimmed.length === 0) {
    throw new SourceResolutionError('install source is empty')
  }

  const github = parseGithubSource(trimmed)
  if (github) {
    return resolveGithubSource(trimmed, github, options)
  }

  if (isSkillMdUrl(trimmed)) {
    return resolveSkillMdUrl(trimmed, options)
  }

  // Anything that looks like an http(s) URL but did not parse as a
  // supported source is rejected at v1. Fail fast rather than treating
  // it as a local path, which would only lead to a confusing "directory
  // does not exist" error.
  if (/^https?:\/\//.test(trimmed)) {
    throw new UnsupportedSourceError(trimmed)
  }

  const localPath = expandLocalPath(trimmed, cwd)
  let st
  try {
    st = await stat(localPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SourceResolutionError(`local source "${trimmed}" does not exist (${localPath})`)
    }
    throw err
  }
  if (!st.isDirectory()) {
    throw new SourceResolutionError(`local source "${trimmed}" is not a directory (${localPath})`)
  }
  return {
    rootDir: localPath,
    kind: 'local',
    origin: trimmed,
    cleanup: async () => {
      // Local sources are user-managed; never delete them on cleanup.
    },
  }
}

async function resolveGithubSource(
  origin: string,
  parsed: { owner: string; repo: string },
  options: ResolveSourceOptions,
): Promise<ResolvedSource> {
  const cloneUrl = `https://github.com/${parsed.owner}/${parsed.repo}.git`
  const makeTempDir = options.makeTempDir ?? (() => mkdtemp(join(tmpdir(), '2200-ext-clone-')))
  const tempDir = await makeTempDir()
  const cloneInto = join(tempDir, 'src')
  const gitBinary = options.gitBinary ?? 'git'
  await runGitClone(gitBinary, cloneUrl, cloneInto, parsed)
  return {
    rootDir: cloneInto,
    kind: 'github',
    origin,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true })
    },
  }
}

async function resolveSkillMdUrl(
  origin: string,
  options: ResolveSourceOptions,
): Promise<ResolvedSource> {
  const makeTempDir = options.makeTempDir ?? (() => mkdtemp(join(tmpdir(), '2200-skill-url-')))
  const fetchImpl = options.fetchImpl ?? fetch
  const tempDir = await makeTempDir()
  let response: Response
  try {
    response = await fetchImpl(origin, {
      headers: { Accept: 'text/markdown, text/plain, */*' },
      redirect: 'follow',
    })
  } catch (err) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    throw new SourceResolutionError(
      `failed to fetch SKILL.md from ${origin}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!response.ok) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    throw new SourceResolutionError(
      `fetch of ${origin} returned ${String(response.status)} ${response.statusText || ''}`.trim(),
    )
  }
  const body = await response.text()
  if (body.trim().length === 0) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    throw new SourceResolutionError(`SKILL.md at ${origin} is empty`)
  }
  try {
    await writeFile(join(tempDir, 'SKILL.md'), body, 'utf8')
  } catch (err) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
  return {
    rootDir: tempDir,
    kind: 'skill_url',
    origin,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true })
    },
  }
}

function runGitClone(
  gitBinary: string,
  cloneUrl: string,
  target: string,
  parsed: { owner: string; repo: string },
): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    let child
    try {
      child = spawn(gitBinary, ['clone', '--depth=1', '--quiet', cloneUrl, target], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      })
    } catch (err) {
      reject(
        new SourceResolutionError(
          `git clone failed to spawn (is git on PATH?): ${err instanceof Error ? err.message : String(err)}`,
        ),
      )
      return
    }
    const stderrChunks: Buffer[] = []
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
    child.on('error', (err) => {
      reject(new SourceResolutionError(`git clone failed: ${err.message}`))
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()
      reject(
        new SourceResolutionError(
          `git clone of ${parsed.owner}/${parsed.repo} exited ${code === null ? 'null' : String(code)}` +
            (stderr ? `:\n${stderr}` : ''),
        ),
      )
    })
  })
}
