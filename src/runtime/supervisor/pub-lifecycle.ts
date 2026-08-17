/**
 * Pub-server process lifecycle: launch, track, kill.
 *
 * The supervisor owns this layer. It uses Node's `child_process.spawn`
 * to launch `openpub-server` (from `@openpub-ai/pub-server`) for each
 * pub registered on this 2200 instance. Per Epic 3 [[03-local-pub-integration]],
 * a pub IS the conversation; multi-pub is supported via N supervised
 * children rather than a multi-channel mode in OpenPub itself.
 *
 * Why a separate module from `lifecycle.ts`: the env contract differs
 * (PUB_MD_PATH, PORT, OPENPUB_ISSUER) and the process binary differs
 * (openpub-server, not the in-tree Agent bootstrap). Sharing one
 * launcher would require either a parameterized hairball or an
 * abstract base, both of which are heavier than two small modules.
 *
 * State-on-disk discipline (upgrade-readiness #2): the live PID map
 * here is a cache. The source of truth is `supervisor.json`, which
 * the supervisor updates on every state change.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLogger, type Logger } from '../util/logger.js'
import { pubPaths } from '../storage/layout.js'

export interface StartedPub {
  /** The pub's name (matches its record key in supervisor.json). */
  readonly name: string
  /** The OS process ID of the started pub-server. */
  readonly pid: number
  /** Resolves when the process exits. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  /** Send SIGTERM and wait for exit. Resolves when the process is gone. */
  stop(timeoutMs?: number): Promise<void>
}

class StartedPubImpl implements StartedPub {
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>

  constructor(
    public readonly name: string,
    public readonly pid: number,
    private readonly child: ChildProcess,
    private readonly log: Logger,
  ) {
    this.exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        resolve({ code, signal })
      })
    })
  }

  async stop(timeoutMs = 5000): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return
    }
    this.log.debug('sending SIGTERM', { name: this.name, pid: this.pid })
    this.child.kill('SIGTERM')
    const timeout = new Promise<void>((resolve) =>
      setTimeout(() => {
        if (this.child.exitCode === null && this.child.signalCode === null) {
          this.log.warn('timed out on SIGTERM, sending SIGKILL', {
            name: this.name,
            pid: this.pid,
          })
          this.child.kill('SIGKILL')
        }
        resolve()
      }, timeoutMs),
    )
    await Promise.race([this.exited.then(() => undefined), timeout])
    await this.exited
  }
}

export interface StartPubOptions {
  /** Pub name (slug). Used for log labeling and PID file naming. */
  name: string
  /** 2200_HOME root. Per-pub state lives at `<home>/state/openpub/<name>/`. */
  home: string
  /** Port the pub-server should listen on. */
  port: number
  /** Issuer mode for pub-server's identity layer. Defaults to 'local' per Doug's Flag B call. */
  issuer?: 'local' | 'hub'
  /** Hub URL when `issuer === 'hub'`. Ignored otherwise. */
  hubUrl?: string
  /** Admin secret used to gate POST /admin/register-agent in LOCAL mode. Required when issuer is 'local'. */
  adminSecret?: string
  /** Pub's own signing keypair (Ed25519, base64url scalars). Required by openpub-server v0.3.x. */
  signingPrivateKey?: string
  signingPublicKey?: string
  /** Pre-assigned pub_id (UUID v7). Optional; pub-server derives one from the pub name when absent. */
  pubId?: string
  /** Override the openpub-server executable path. Defaults to looking up `openpub-server` on PATH or the local `node_modules/.bin`. */
  executablePath?: string
  /** Extra env vars to merge into the pub-server process env. */
  env?: Record<string, string>
}

/**
 * Launch an `openpub-server` child for a pub. Returns once the process
 * is started; does NOT wait for the pub-server to bind its port or
 * report ready. Callers that need ready-state should poll the
 * pub-server's `/info` endpoint after launch.
 *
 * The child's stdout and stderr are piped to `<home>/state/openpub/<name>/pub.log`
 * for post-mortem inspection without bloating the supervisor's own log.
 */
export function launchPubProcess(opts: StartPubOptions, log?: Logger): StartedPub {
  const componentLog = log ?? createLogger('pub-lifecycle')
  // npm-installed users get an unpatched pub-server (pnpm patches don't carry
  // through npm); overlay the shipped patch before launch so the keepalive +
  // bartender-off behavior is present everywhere, not just in the dev repo.
  ensurePubServerPatched(componentLog)
  const executable = opts.executablePath ?? defaultPubServerExecutable()
  const paths = pubPaths(opts.home, opts.name)

  // Pub-server v0.3.3 contract (read from inspecting the binary, not
  // documented elsewhere):
  //   PUB_MD_PATH               — required; path to the pub's PUB.md config
  //   PORT                      — required; HTTP+WS listen port
  //   OPENPUB_TRUST_MODE        — 'local' | 'hub' (default 'hub')
  //   OPENPUB_STATE_DIR         — where pub-server keeps its issuer key + agents.json (LOCAL mode)
  //   OPENPUB_ADMIN_SECRET      — required in LOCAL mode; gates /admin/register-agent
  //   PUB_SIGNING_PRIVATE_KEY   — required; the pub's own Ed25519 signing key (base64url)
  //   PUB_SIGNING_PUBLIC_KEY    — required; the pub's own public key
  //   PUB_ID                    — optional; deterministic hash of pub name when omitted
  //   HUB_URL                   — only used in HUB mode
  //
  // Per Doug's Flag B call (2026-04-26), 'local' is the default. The
  // supervisor generates the admin secret + signing keypair at
  // cli.pub.create time and persists them into the pub's state dir.
  const issuer = opts.issuer ?? 'local'
  if (issuer === 'local' && !opts.adminSecret) {
    throw new Error(
      `launchPubProcess: adminSecret is required when issuer === 'local' (pub: ${opts.name})`,
    )
  }
  if (!opts.signingPrivateKey || !opts.signingPublicKey) {
    throw new Error(
      `launchPubProcess: signingPrivateKey and signingPublicKey are required (pub: ${opts.name})`,
    )
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...opts.env,
    PUB_MD_PATH: paths.pubMd,
    PORT: String(opts.port),
    OPENPUB_TRUST_MODE: issuer,
    OPENPUB_STATE_DIR: paths.data,
    PUB_SIGNING_PRIVATE_KEY: opts.signingPrivateKey,
    PUB_SIGNING_PUBLIC_KEY: opts.signingPublicKey,
    ...(opts.adminSecret ? { OPENPUB_ADMIN_SECRET: opts.adminSecret } : {}),
    ...(opts.pubId ? { PUB_ID: opts.pubId } : {}),
    ...(issuer === 'hub' && opts.hubUrl ? { HUB_URL: opts.hubUrl } : {}),
  }

  const child = spawn(executable, [], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  })

  if (child.pid === undefined) {
    throw new Error(
      `failed to launch pub-server for ${opts.name}: no pid (executable: ${executable})`,
    )
  }

  // Pipe stdio to the per-pub log file rather than the supervisor's
  // own log. Pub-servers are chatty (every WebSocket ping, every
  // checkin) and conflating their output with supervisor events
  // makes both harder to read.
  const logStream = createWriteStream(paths.log, { flags: 'a' })
  // stdio: ['ignore', 'pipe', 'pipe'] above guarantees stdout/stderr
  // are present pipes. The TS type permits null because the runtime
  // shape depends on the stdio config; we always pipe.
  child.stdout.on('data', (chunk: Buffer) => {
    logStream.write(`[stdout] ${chunk.toString()}`)
  })
  child.stderr.on('data', (chunk: Buffer) => {
    logStream.write(`[stderr] ${chunk.toString()}`)
  })
  child.once('exit', () => {
    logStream.end()
  })

  componentLog.info('pub-server started', {
    name: opts.name,
    pid: child.pid,
    port: opts.port,
    executable,
    trust_mode: opts.issuer ?? 'local',
  })

  return new StartedPubImpl(opts.name, child.pid, child, componentLog.child(opts.name))
}

/**
 * Resolve the openpub-server executable path. v1 strategy:
 *   1. If the local `node_modules/.bin/openpub-server` exists, use it.
 *   2. Otherwise, fall back to bare `openpub-server` and let PATH lookup
 *      do its job (or fail with a clear error at launch time).
 *
 * The dependency is `@openpub-ai/pub-server`; installing it places the
 * binary at `node_modules/.bin/openpub-server`. PR A pins to v0.3.1.
 *
 * tsup bundles imports into entry files, so this module's
 * `import.meta.url` reports the entry file's URL. We probe the
 * conventional local `node_modules/.bin` first (covering both the
 * dist-bundled CLI case and the unbundled src layout used by tests).
 */
export const PUB_SERVER_PATCH_MARKER = '2200 patch'

/**
 * Candidate paths for the INSTALLED pub-server `server.js`, relative to this
 * module's directory. tsup bundles this code into a varying entry file, so the
 * `node_modules` depth differs by bundle ... probe each.
 */
export function installedPubServerCandidates(moduleDir: string): string[] {
  return [
    resolve(
      moduleDir,
      '..',
      '..',
      '..',
      'node_modules',
      '@openpub-ai',
      'pub-server',
      'dist',
      'server.js',
    ),
    resolve(
      moduleDir,
      '..',
      '..',
      'node_modules',
      '@openpub-ai',
      'pub-server',
      'dist',
      'server.js',
    ),
    resolve(process.cwd(), 'node_modules', '@openpub-ai', 'pub-server', 'dist', 'server.js'),
  ]
}

/**
 * Candidate paths for the SHIPPED (patched) copy at
 * `<dist>/vendor/openpub-pub-server/server.js`. The bundled entry that contains
 * this code varies (`dist/cli/main.js` -> up 1; `dist/runtime/supervisor/
 * bootstrap.js` -> up 2), so probe each depth. Getting this depth wrong is the
 * bug that shipped twice (2026.617.327 + .342) before it found the file ...
 * hence the dedicated test on `planPubServerPatch`.
 */
export function shippedPatchCandidates(moduleDir: string): string[] {
  return [0, 1, 2, 3].map((up) =>
    resolve(
      moduleDir,
      ...Array<string>(up).fill('..'),
      'vendor',
      'openpub-pub-server',
      'server.js',
    ),
  )
}

/** Filesystem surface the patch planner needs, injectable for tests. */
export interface PatchFs {
  exists(p: string): boolean
  /** File contents, or null if missing/unreadable. */
  read(p: string): string | null
}

export type PubServerPatchPlan =
  | { action: 'no-installed' }
  | { action: 'installed-unreadable'; installed: string }
  | { action: 'already-patched'; installed: string }
  | { action: 'no-shipped'; installed: string }
  | { action: 'shipped-unpatched'; installed: string; shipped: string }
  | { action: 'apply'; installed: string; shipped: string; content: string }

/**
 * Pure decision: given the installed + shipped candidate paths and a
 * filesystem, decide whether to overlay the patch. No side effects ... the
 * executor (`ensurePubServerPatched`) performs the write + logging. This is the
 * path-probing + marker logic that needs to be right; testing it directly is
 * cheaper and more reliable than an end-to-end install.
 */
export function planPubServerPatch(
  installedCandidates: string[],
  shippedCandidates: string[],
  fs: PatchFs,
  marker: string = PUB_SERVER_PATCH_MARKER,
): PubServerPatchPlan {
  const installed = installedCandidates.find((p) => fs.exists(p))
  if (!installed) return { action: 'no-installed' }
  const current = fs.read(installed)
  if (current === null) return { action: 'installed-unreadable', installed }
  if (current.includes(marker)) return { action: 'already-patched', installed } // dev pnpm, or a prior overlay
  const shipped = shippedCandidates.find((p) => fs.exists(p))
  if (!shipped) return { action: 'no-shipped', installed }
  const patched = fs.read(shipped)
  // Never overwrite the installed file with a shipped copy that isn't itself
  // patched (or is unreadable) ... that would be a no-op at best, a corruption
  // at worst.
  if (!patched?.includes(marker)) {
    return { action: 'shipped-unpatched', installed, shipped }
  }
  return { action: 'apply', installed, shipped, content: patched }
}

/**
 * Ensure the installed OpenPub pub-server carries 2200's patches before we
 * launch it: the empty-key Bartender/fragment guards (so the Bartender stays
 * OFF in the Studio when no LLM_API_KEY is set ... which is always, by design)
 * AND the WebSocket keepalive `pong` handler (without which OpenPub terminates
 * an Agent's socket ~60s after it joins, dropping the Agent from the room).
 *
 * The patch is applied in the dev repo via pnpm `patchedDependencies`, but an
 * `npm install` of the published package ignores pnpm patches and gets an
 * UNPATCHED pub-server. We ship the patched `server.js` in
 * `dist/vendor/openpub-pub-server/` (scripts/bundle-pub-server-patch.mjs) and
 * overlay it here, idempotently. Best-effort: any failure logs and continues
 * (worst case is the prior unpatched behavior, never a crash). The decision is
 * `planPubServerPatch` (pure, tested); this function is the thin I/O executor.
 */
function ensurePubServerPatched(log: Logger): void {
  const here = dirname(fileURLToPath(import.meta.url))
  const fs: PatchFs = {
    exists: existsSync,
    read: (p) => {
      try {
        return readFileSync(p, 'utf8')
      } catch {
        return null
      }
    },
  }
  const plan = planPubServerPatch(
    installedPubServerCandidates(here),
    shippedPatchCandidates(here),
    fs,
  )
  if (plan.action === 'no-shipped') {
    log.warn(
      'pub-server is unpatched and no shipped patch found; Agents may be dropped from rooms',
      { installed: plan.installed },
    )
    return
  }
  if (plan.action !== 'apply') return // no-installed / installed-unreadable / already-patched / shipped-unpatched
  try {
    writeFileSync(plan.installed, plan.content)
    log.info('applied 2200 pub-server patch (keepalive + bartender guards)', {
      installed: plan.installed,
    })
  } catch (err) {
    log.warn('failed to apply 2200 pub-server patch (continuing unpatched)', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

function defaultPubServerExecutable(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    // From dist/runtime/supervisor/pub-lifecycle.js: ../../../node_modules/.bin/openpub-server
    resolve(here, '..', '..', '..', 'node_modules', '.bin', 'openpub-server'),
    // From dist/cli/main.js: ../../node_modules/.bin/openpub-server
    resolve(here, '..', '..', 'node_modules', '.bin', 'openpub-server'),
    // From the repo root in dev (src case): ./node_modules/.bin/openpub-server
    resolve(process.cwd(), 'node_modules', '.bin', 'openpub-server'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  // Fall back to PATH lookup. The launch will fail with ENOENT if the
  // binary is not installed, with a message clear enough to point the
  // user at `pnpm add @openpub-ai/pub-server`.
  return 'openpub-server'
}

// ---------------------------------------------------------------------------
// PUB.md content (the pub-server config file)
// ---------------------------------------------------------------------------

export interface PubMdOptions {
  name: string
  description?: string
  capacity?: number
  /**
   * Owner identifier. Per Epic 3 spec: the user's pub identity at v1.
   * Required: there is no sensible default at this layer. Supervisor
   * derives it from the operator's user identity when the caller
   * doesn't pass one (see `Supervisor.createPub`).
   */
  owner: string
  /** Bartender LLM model (`<provider>/<model_id>` per the locked format). */
  model?: string
}

/**
 * Compose the PUB.md content for a new pub. Format mirrors what
 * `@openpub-ai/pub-server@0.3.x` reads from PUB_MD_PATH (validated
 * by `PubMdFrontmatter` from `@openpub-ai/types`).
 *
 * Required fields per the v0.3.3 schema: version, name, description,
 * owner, model, capacity, entry. The composer fills in sensible
 * defaults for any field the caller does not provide so the resulting
 * PUB.md always passes pub-server's validation. Note that `version`
 * here refers to PUB.md's schema version (e.g., '0.3'), NOT 2200's
 * internal `schema_version` integer.
 *
 * The bartender model defaults to `anthropic/claude-haiku-4-5`. The
 * bartender is pub-server's friendly conversational presence (an
 * LLM that responds at natural intervals); 2200 doesn't drive it,
 * but pub-server requires the field and may exercise it in real
 * conversations. Tests can override via the `model` opt to point at
 * a stub or unused model.
 */
export function composePubMd(opts: PubMdOptions): string {
  const description = opts.description ?? `${opts.name} pub`
  const owner = opts.owner
  const capacity = opts.capacity ?? 10
  const lines: string[] = ['---']
  // pub-server's PUB.md format version, NOT 2200's schema_version.
  lines.push('version: "0.3"')
  lines.push(`name: ${quoteIfNeeded(opts.name)}`)
  lines.push(`description: ${quoteIfNeeded(description)}`)
  lines.push(`owner: ${quoteIfNeeded(owner)}`)
  // Bartender model. Default to a small, cheap Anthropic model. Users
  // who care about the bartender's voice can edit PUB.md after create.
  lines.push(`model: ${quoteIfNeeded(opts.model ?? 'anthropic/claude-haiku-4-5')}`)
  lines.push(`capacity: ${String(capacity)}`)
  lines.push('entry: open')
  // Reactions on by default. Without this block, pub-server rejects
  // every `pub_react` call with REACTIONS_DISABLED and silently drops
  // the reaction; the agent's tool returns ok: true (the WS frame
  // sent fine) but nothing lands. The bartender / Hobby / Simon
  // persona prompts all assume reactions are available, so the
  // default should match.
  lines.push('reactions:')
  lines.push('  enabled: true')
  lines.push('  set: ["✓", "👍", "👀", "❤️", "🎉", "🤔", "👏", "🙏"]')
  lines.push('---')
  lines.push('')
  lines.push(`# ${opts.name}`)
  lines.push('')
  lines.push(description)
  lines.push('')
  return lines.join('\n')
}

/**
 * Wrap a YAML scalar in double quotes if it contains characters that
 * YAML would otherwise interpret. Lazy heuristic: anything outside
 * `[A-Za-z0-9_-]` triggers quoting. Sufficient for pub names (slugs)
 * and short descriptions.
 */
function quoteIfNeeded(value: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(value)) return value
  // Escape backslashes and double quotes for YAML double-quoted strings.
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `"${escaped}"`
}
