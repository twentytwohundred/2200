/**
 * Daemonize the supervisor.
 *
 * `spawnDaemon(stateDir)` launches the current `2200` binary in `daemon`
 * mode as a detached background process, redirects its stdout/stderr to
 * `<state-dir>/supervisor.log`, writes the PID file, and returns the
 * child's PID. The parent CLI process can then exit immediately; the
 * daemon keeps running.
 *
 * Why this pattern (vs traditional double-fork): cross-platform (works
 * the same on macOS, Linux, and Windows) and dependency-free. The
 * detached child reparents to PID 1 (init/launchd) on POSIX so it
 * survives the parent's exit.
 *
 * Daemon-side bootstrap (`src/runtime/supervisor/bootstrap.ts`) is the
 * entry point spawned here. It instantiates the Supervisor, listens on
 * the UDS, and runs until SIGTERM.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { open, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { writePidFile, readLivePid } from './pidfile.js'
import { homePaths } from '../storage/layout.js'
import { createLogger, type Logger } from '../util/logger.js'

/** Path to the daemon log file under <home>/state/supervisor.log. */
export function logFilePath(home: string): string {
  return homePaths(home).stateSupervisorLog
}

export interface SpawnDaemonOptions {
  /** 2200_HOME root. */
  home: string
  /** Override the bootstrap script (testing). Defaults to bundled entry. */
  bootstrapPath?: string
  /** Override the Node binary. Defaults to `process.execPath`. */
  nodePath?: string
  /** Inject a logger. */
  logger?: Logger
}

/**
 * Launch the supervisor as a detached background process. Returns the
 * child's PID. Throws if a live daemon is already running.
 */
export async function spawnDaemon(opts: SpawnDaemonOptions): Promise<number> {
  const log = opts.logger ?? createLogger('daemon')
  const paths = homePaths(opts.home)
  await mkdir(paths.state, { recursive: true })

  const existing = await readLivePid(opts.home)
  if (existing !== null) {
    throw new Error(`supervisor daemon already running with PID ${String(existing)}`)
  }

  const bootstrapPath = opts.bootstrapPath ?? defaultBootstrapPath()
  const nodePath = opts.nodePath ?? process.execPath
  const logPath = logFilePath(opts.home)

  // Open the log file for append; the child process inherits the FD as
  // its stdout and stderr.
  const logHandle = await open(logPath, 'a')
  try {
    const child = spawn(nodePath, [bootstrapPath, '--home', opts.home], {
      detached: true,
      stdio: ['ignore', logHandle.fd, logHandle.fd],
    })

    if (child.pid === undefined) {
      throw new Error('failed to spawn supervisor daemon: no pid')
    }

    // Detach from the parent so we can exit without leaving the child
    // as a zombie.
    child.unref()

    await writePidFile(opts.home, child.pid)

    log.info('supervisor daemon spawned', {
      pid: child.pid,
      home: opts.home,
      logPath,
    })

    return child.pid
  } finally {
    // The child inherited a duplicate of the FD; closing our handle in
    // the parent does not affect the child.
    await logHandle.close()
  }
}

/**
 * Send SIGTERM to a running daemon and wait for it to exit. Cleans up
 * the PID file when the daemon dies. Returns true if a daemon was
 * stopped; false if no daemon was running.
 *
 * Liveness is polled with a short interval; the timeout defaults to
 * 5000ms before falling back to SIGKILL.
 */
export async function killDaemon(
  home: string,
  options: { timeoutMs?: number; logger?: Logger } = {},
): Promise<boolean> {
  const log = options.logger ?? createLogger('daemon')
  const pid = await readLivePid(home)
  if (pid === null) {
    return false
  }

  log.info('sending SIGTERM to daemon', { pid })
  try {
    process.kill(pid, 'SIGTERM')
  } catch (err) {
    log.warn('failed to send SIGTERM', { pid, error: errMsg(err) })
    return false
  }

  const timeoutMs = options.timeoutMs ?? 5000
  const start = Date.now()
  const pollIntervalMs = 100

  while (Date.now() - start < timeoutMs) {
    if ((await readLivePid(home)) === null) {
      return true
    }
    await sleep(pollIntervalMs)
  }

  // Timed out waiting for clean exit. Escalate.
  log.warn('SIGTERM timed out, sending SIGKILL', { pid })
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // process may have died between checks
  }

  // Wait briefly for the kernel to reap.
  const killStart = Date.now()
  while (Date.now() - killStart < 2000) {
    if ((await readLivePid(home)) === null) {
      return true
    }
    await sleep(pollIntervalMs)
  }

  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Resolve the path to the bundled supervisor bootstrap script.
 *
 * tsup bundles imports into entry files: this module's source lives at
 * `src/runtime/supervisor/daemon.ts`, but post-bundle it ends up inside
 * whichever entry imported it (typically `dist/cli/main.js` when invoked
 * via the CLI). `import.meta.url` reports the entry file's URL, not the
 * source file's. We anchor relative to the entry directory and walk to
 * `runtime/supervisor/bootstrap.js`, which is the supervisor bootstrap
 * entry tsup builds at `dist/runtime/supervisor/bootstrap.js`.
 *
 * From `dist/cli/main.js`: `../runtime/supervisor/bootstrap.js`. From
 * `dist/runtime/supervisor/bootstrap.js` itself (if this module ever
 * gets bundled into the bootstrap): `./bootstrap.js`. Both resolve via
 * the same `dist/`-relative segment as long as `here` ends up under
 * `dist/<segment>/`.
 */
function defaultBootstrapPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // Find the dist root (the parent that contains both `cli` and
  // `runtime` siblings) by walking up until `runtime/supervisor/
  // bootstrap.js` is reachable as a sibling tree.
  // Practically: try `<here>/../runtime/supervisor/bootstrap.js`
  // first (cli/main bundle case), then `<here>/bootstrap.js`
  // (supervisor bundle case), then `<here>/runtime/supervisor/
  // bootstrap.js` (dist root case, e.g., bare-Node entry).
  const candidates = [
    resolve(here, '..', 'runtime', 'supervisor', 'bootstrap.js'),
    resolve(here, 'bootstrap.js'),
    resolve(here, 'runtime', 'supervisor', 'bootstrap.js'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  // Fall back to the cli/main case; the spawn will error visibly if
  // the file is missing and the user can pass `bootstrapPath` explicitly.
  const fallback = candidates[0]
  if (!fallback) throw new Error('no bootstrap path candidates configured')
  return fallback
}
