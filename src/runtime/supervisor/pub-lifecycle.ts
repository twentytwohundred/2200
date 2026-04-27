/**
 * Pub-server process lifecycle: spawn, track, kill.
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
 * spawner would require either a parameterized hairball or an
 * abstract base, both of which are heavier than two small modules.
 *
 * State-on-disk discipline (upgrade-readiness #2): the live PID map
 * here is a cache. The source of truth is `supervisor.json`, which
 * the supervisor updates on every state change.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLogger, type Logger } from '../util/logger.js'
import { pubPaths } from '../storage/layout.js'

export interface SpawnedPub {
  /** The pub's name (matches its record key in supervisor.json). */
  readonly name: string
  /** The OS process ID of the spawned pub-server. */
  readonly pid: number
  /** Resolves when the process exits. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  /** Send SIGTERM and wait for exit. Resolves when the process is gone. */
  stop(timeoutMs?: number): Promise<void>
}

class SpawnedPubImpl implements SpawnedPub {
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

export interface SpawnPubOptions {
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
  /** Override the openpub-server executable path. Defaults to looking up `openpub-server` on PATH or the local `node_modules/.bin`. */
  executablePath?: string
  /** Extra env vars to merge into the pub-server process env. */
  env?: Record<string, string>
}

/**
 * Spawn an `openpub-server` child for a pub. Returns once the process
 * is launched (spawned); does NOT wait for the pub-server to bind its
 * port or report ready. Callers that need ready-state should poll the
 * pub-server's `/info` endpoint after spawn.
 *
 * The child's stdout and stderr are piped to `<home>/state/openpub/<name>/pub.log`
 * for post-mortem inspection without bloating the supervisor's own log.
 */
export function spawnPub(opts: SpawnPubOptions, log?: Logger): SpawnedPub {
  const componentLog = log ?? createLogger('pub-lifecycle')
  const executable = opts.executablePath ?? defaultPubServerExecutable()
  const paths = pubPaths(opts.home, opts.name)

  // Pub-server reads its config from PUB_MD_PATH and listens on PORT.
  // OPENPUB_TRUST_MODE selects the local vs hub trust mode per
  // @openpub-ai/pub-server v0.3.2's pluggable-issuer contract; 'local'
  // is the default per Doug's call (Flag B, 2026-04-26). OPENPUB_HUB_URL
  // is only consulted when trust mode is 'hub'. v0.3.1 ignores
  // OPENPUB_TRUST_MODE entirely (always hub-mediated); the variable is
  // forward-compatible with v0.3.2.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...opts.env,
    PUB_MD_PATH: paths.pubMd,
    PORT: String(opts.port),
    OPENPUB_TRUST_MODE: opts.issuer ?? 'local',
    ...(opts.issuer === 'hub' && opts.hubUrl ? { OPENPUB_HUB_URL: opts.hubUrl } : {}),
    OPENPUB_DATA_DIR: paths.data,
  }

  const child = spawn(executable, [], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  })

  if (child.pid === undefined) {
    throw new Error(
      `failed to spawn pub-server for ${opts.name}: no pid (executable: ${executable})`,
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

  componentLog.info('pub-server spawned', {
    name: opts.name,
    pid: child.pid,
    port: opts.port,
    executable,
    trust_mode: opts.issuer ?? 'local',
  })

  return new SpawnedPubImpl(opts.name, child.pid, child, componentLog.child(opts.name))
}

/**
 * Resolve the openpub-server executable path. v1 strategy:
 *   1. If the local `node_modules/.bin/openpub-server` exists, use it.
 *   2. Otherwise, fall back to bare `openpub-server` and let PATH lookup
 *      do its job (or fail with a clear error at spawn time).
 *
 * The dependency is `@openpub-ai/pub-server`; installing it places the
 * binary at `node_modules/.bin/openpub-server`. PR A pins to v0.3.1.
 *
 * tsup bundles imports into entry files, so this module's
 * `import.meta.url` reports the entry file's URL. We probe the
 * conventional local `node_modules/.bin` first (covering both the
 * dist-bundled CLI case and the unbundled src layout used by tests).
 */
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
  // Fall back to PATH lookup. Spawn will fail with ENOENT if the binary
  // is not installed, with a message clear enough to point the user at
  // `pnpm add @openpub-ai/pub-server`.
  return 'openpub-server'
}

// ---------------------------------------------------------------------------
// PUB.md content (the pub-server config file)
// ---------------------------------------------------------------------------

export interface PubMdOptions {
  name: string
  description?: string
  capacity?: number
  /** Owner identifier. Per Epic 3 spec: the user's pub identity at v1. */
  owner?: string
}

/**
 * Compose the PUB.md content for a new pub. Format mirrors what
 * `@openpub-ai/pub-server` reads from PUB_MD_PATH: YAML frontmatter
 * with the pub's identity and config, then optional human-readable
 * body.
 *
 * Per [[2026-04-26-schema-version-format]], `schema_version` is an
 * integer. Per Poe's contract reply (April 26), the canonical
 * source of truth for pub-server's PUB.md format is the Zod schema
 * in `@openpub-ai/types`; this composer writes a v0.3-compatible
 * shape and will adjust as Poe ships v0.3.1.x with the
 * pluggable-issuer changes.
 */
export function composePubMd(opts: PubMdOptions): string {
  const lines: string[] = ['---']
  lines.push('schema_version: 1')
  lines.push(`name: ${quoteIfNeeded(opts.name)}`)
  if (opts.description) {
    lines.push(`description: ${quoteIfNeeded(opts.description)}`)
  }
  if (opts.capacity !== undefined) {
    lines.push(`capacity: ${String(opts.capacity)}`)
  }
  if (opts.owner) {
    lines.push(`owner: ${quoteIfNeeded(opts.owner)}`)
  }
  lines.push('entry: open')
  lines.push('---')
  lines.push('')
  lines.push(`# ${opts.name}`)
  lines.push('')
  if (opts.description) {
    lines.push(opts.description)
    lines.push('')
  }
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
