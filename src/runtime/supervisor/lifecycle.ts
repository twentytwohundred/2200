/**
 * Agent process lifecycle: spawn, adopt, track, kill.
 *
 * The supervisor owns this layer. Two ways an Agent process can be tracked:
 *
 *   - **Spawned**: the supervisor launched it via `child_process.spawn`. We
 *     hold the ChildProcess reference and signal via it directly.
 *   - **Adopted**: the supervisor restarted (preserveChildren) and found a
 *     surviving Agent process running from a prior supervisor lifetime. We
 *     don't have a ChildProcess reference, so we signal by PID (via
 *     `process.kill`) and poll for exit (no `exit` event available).
 *
 * Both kinds expose the same `TrackedAgent` interface so the supervisor can
 * treat them uniformly: `stop()` works in both cases, `exited` resolves in
 * both cases.
 *
 * State-on-disk discipline (upgrade-readiness #2): the live tracker map in
 * the supervisor is a cache. The source of truth is `supervisor.json`,
 * which the supervisor updates on every state change.
 *
 * Bootstrap-path validation: adopted processes can be running stale code
 * if the supervisor restarted onto a new dist while the Agent kept its
 * old in-memory code. `validateAdoptedProcessArgv` reads the process's
 * argv via `ps` and confirms the bootstrap path matches the current dist.
 * The supervisor refuses to adopt processes that fail validation and
 * kills + respawns them instead.
 */
import { execFileSync } from 'node:child_process'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createLogger, type Logger } from '../util/logger.js'

export interface TrackedAgent {
  /** The Agent's name (matches its record key in supervisor.json). */
  readonly name: string
  /** The OS process ID. */
  readonly pid: number
  /** Whether this process was adopted (true) or spawned by us (false). */
  readonly adopted: boolean
  /** Resolves when the process exits. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  /** Send SIGTERM and wait for exit; escalate to SIGKILL after timeoutMs. */
  stop(timeoutMs?: number): Promise<void>
}

/** Back-compat alias. */
export type SpawnedAgent = TrackedAgent

class SpawnedAgentImpl implements TrackedAgent {
  readonly adopted = false
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

class AdoptedAgentImpl implements TrackedAgent {
  readonly adopted = true
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>

  constructor(
    public readonly name: string,
    public readonly pid: number,
    private readonly log: Logger,
  ) {
    this.exited = this.watchForExit()
  }

  /**
   * Poll for process death every 100ms. Adopted processes have no
   * `exit` event so this is how the supervisor's handleAgentExit
   * eventually fires; tight poll cadence keeps the gap between
   * stop() returning and `exited` resolving short enough that
   * follow-up startAgent calls do not race `this.spawned.delete`.
   */
  private watchForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return new Promise((resolve) => {
      const tick = (): void => {
        if (!isPidAlive(this.pid)) {
          resolve({ code: null, signal: null })
          return
        }
        setTimeout(tick, 100)
      }
      tick()
    })
  }

  async stop(timeoutMs = 5000): Promise<void> {
    if (!isPidAlive(this.pid)) {
      // Already dead. `exited` may have fired or be about to fire.
      // Wait briefly so the supervisor's handleAgentExit can run
      // before stop() returns; otherwise stopAgent + startAgent
      // racing through this in <1ms triggers "already running".
      await Promise.race([this.exited, new Promise((r) => setTimeout(r, 250))])
      return
    }
    this.log.debug('sending SIGTERM to adopted process', { name: this.name, pid: this.pid })
    try {
      process.kill(this.pid, 'SIGTERM')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
        await Promise.race([this.exited, new Promise((r) => setTimeout(r, 250))])
        return
      }
      throw err
    }
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (!isPidAlive(this.pid)) {
        // Wait for the supervisor's exit handler to drain before
        // returning. See the comment above; same invariant applies
        // post-SIGTERM as pre-stop.
        await Promise.race([this.exited, new Promise((r) => setTimeout(r, 250))])
        return
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    this.log.warn('adopted process did not respond to SIGTERM, sending SIGKILL', {
      name: this.name,
      pid: this.pid,
    })
    try {
      process.kill(this.pid, 'SIGKILL')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
        await Promise.race([this.exited, new Promise((r) => setTimeout(r, 250))])
        return
      }
      throw err
    }
    for (let i = 0; i < 30; i++) {
      if (!isPidAlive(this.pid)) {
        await Promise.race([this.exited, new Promise((r) => setTimeout(r, 250))])
        return
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(
      `adopted process ${this.name} (pid ${String(this.pid)}) did not die after SIGKILL`,
    )
  }
}

/** Check whether a PID is alive on this machine. Returns false on ESRCH. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Read a process's command-line argv via `ps`. Returns null if the process
 * is gone or `ps` is unavailable. Used for adopt-time bootstrap-path
 * validation.
 *
 * macOS + Linux: `ps -o command= -p <pid>` returns the joined command line.
 * The output is the same string the OS reports for the process, including
 * the node binary path and the bootstrap script path.
 */
export function getProcessArgv(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const trimmed = out.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

/**
 * Confirm a surviving process is running the currently-deployed Agent
 * bootstrap script. Returns true if the process's argv contains the
 * expected bootstrap path, false otherwise.
 *
 * Used at adopt-on-restart to refuse stale-dist processes. The supervisor
 * kills + respawns mismatched processes rather than adopting them.
 */
export function validateAdoptedProcessArgv(pid: number, expectedBootstrapPath: string): boolean {
  const argv = getProcessArgv(pid)
  if (!argv) return false
  return argv.includes(expectedBootstrapPath)
}

/**
 * Adopt a surviving Agent process by PID. Returns a TrackedAgent that the
 * supervisor can `stop()` and `await exited` on. The caller is responsible
 * for argv validation (via `validateAdoptedProcessArgv`) before adopting.
 */
export function adoptAgent(name: string, pid: number, log?: Logger): TrackedAgent {
  const componentLog = log ?? createLogger('lifecycle')
  componentLog.info('Agent process adopted', { name, pid })
  return new AdoptedAgentImpl(name, pid, componentLog.child(name))
}

export interface SpawnAgentOptions {
  name: string
  identityPath: string
  socketPath: string
  /** 2200_HOME root, propagated to the Agent process so its loop can
   *  resolve virtual paths and read its task store. */
  home: string
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
export function spawnAgent(opts: SpawnAgentOptions, log?: Logger): TrackedAgent {
  const componentLog = log ?? createLogger('lifecycle')
  const bootstrapPath = opts.bootstrapPath ?? defaultBootstrapPath()
  const nodePath = opts.nodePath ?? process.execPath

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...opts.env,
    TWENTYTWOHUNDRED_AGENT_NAME: opts.name,
    TWENTYTWOHUNDRED_IDENTITY_PATH: opts.identityPath,
    TWENTYTWOHUNDRED_SOCKET_PATH: opts.socketPath,
    TWENTYTWOHUNDRED_HOME: opts.home,
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
export function defaultBootstrapPath(): string {
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
