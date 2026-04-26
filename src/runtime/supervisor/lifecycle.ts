/**
 * Agent process lifecycle: spawn, track, kill.
 *
 * The supervisor owns this layer. It uses Node's `child_process.spawn` to
 * launch Agent processes with their Identity path and the supervisor's
 * socket path passed in via env vars. Spawned processes inherit no fds
 * besides stdin/stdout/stderr (which the supervisor pipes for log capture).
 *
 * State-on-disk discipline (upgrade-readiness #2): the live PID map here is
 * a cache. The source of truth is `supervisor.json`, which the supervisor
 * updates on every state change.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createLogger, type Logger } from '../util/logger.js'

export interface SpawnedAgent {
  /** The Agent's name (matches its record key in supervisor.json). */
  readonly name: string
  /** The OS process ID of the spawned Agent. */
  readonly pid: number
  /** Resolves when the process exits. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  /** Send SIGTERM and wait for exit. Resolves when the process is gone. */
  stop(timeoutMs?: number): Promise<void>
}

class SpawnedAgentImpl implements SpawnedAgent {
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

export interface SpawnAgentOptions {
  name: string
  identityPath: string
  socketPath: string
  /** Path to the Agent bootstrap script. Defaults to the bundled entrypoint. */
  bootstrapPath?: string
  /** Override the Node binary; defaults to `process.execPath`. */
  nodePath?: string
  /** Extra env vars to merge into the Agent process env. */
  env?: Record<string, string>
}

/**
 * Spawn an Agent process. Returns once the process is launched (spawned);
 * does NOT wait for the Agent to register with the supervisor.
 */
export function spawnAgent(opts: SpawnAgentOptions, log?: Logger): SpawnedAgent {
  const componentLog = log ?? createLogger('lifecycle')
  const bootstrapPath = opts.bootstrapPath ?? defaultBootstrapPath()
  const nodePath = opts.nodePath ?? process.execPath

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...opts.env,
    TWENTYTWOHUNDRED_AGENT_NAME: opts.name,
    TWENTYTWOHUNDRED_IDENTITY_PATH: opts.identityPath,
    TWENTYTWOHUNDRED_SOCKET_PATH: opts.socketPath,
  }

  const child = spawn(nodePath, [bootstrapPath], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  })

  if (child.pid === undefined) {
    throw new Error(`failed to spawn Agent ${opts.name}: no pid`)
  }

  // stdio: ['ignore', 'pipe', 'pipe'] above guarantees stdout and stderr are
  // present pipes. The TypeScript type permits null because the runtime shape
  // depends on the stdio config; we always pipe.
  child.stdout.on('data', (data: Buffer) => {
    process.stderr.write(`[${opts.name}/stdout] ${data.toString()}`)
  })
  child.stderr.on('data', (data: Buffer) => {
    process.stderr.write(`[${opts.name}/stderr] ${data.toString()}`)
  })

  componentLog.info('Agent process spawned', {
    name: opts.name,
    pid: child.pid,
    bootstrapPath,
  })

  return new SpawnedAgentImpl(opts.name, child.pid, child, componentLog.child(opts.name))
}

/**
 * Resolve the path to the bundled Agent bootstrap script.
 *
 * tsup bundles imports into entry files, so this module's `import.meta.url`
 * reports the entry file's URL (typically `dist/cli/main.js` when the CLI
 * spawns an Agent in-process, or `dist/runtime/supervisor/bootstrap.js`
 * when the supervisor daemon spawns one). Try the candidate paths in
 * order; pick the first that exists.
 */
function defaultBootstrapPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    // From dist/runtime/supervisor/bootstrap.js: ../agent/bootstrap.js
    resolve(here, '..', 'agent', 'bootstrap.js'),
    // From dist/cli/main.js: ../runtime/agent/bootstrap.js
    resolve(here, '..', 'runtime', 'agent', 'bootstrap.js'),
    // Dist root sibling case
    resolve(here, 'runtime', 'agent', 'bootstrap.js'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  const fallback = candidates[0]
  if (!fallback) throw new Error('no Agent bootstrap path candidates configured')
  return fallback
}
