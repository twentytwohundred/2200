/**
 * Daemonize the supervisor.
 *
 * `startDaemon(stateDir)` launches the current `2200` binary in `daemon`
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
 * entry point started here. It instantiates the Supervisor, listens on
 * the UDS, and runs until SIGTERM.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { open, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { writePidFile, readLivePid, readLegacyPidFile, pidFilePath, isPidAlive } from './pidfile.js'
import { isLockHeld } from './process-lock.js'
import { homePaths } from '../storage/layout.js'
import { createLogger, type Logger } from '../util/logger.js'
import { loadRuntimeEnv, defaultRuntimeEnvPath } from '../config/runtime-env.js'

/** Path to the daemon log file under <home>/state/supervisor.log. */
export function logFilePath(home: string): string {
  return homePaths(home).stateSupervisorLog
}

export interface StartDaemonOptions {
  /** 2200_HOME root. */
  home: string
  /** Override the bootstrap script (testing). Defaults to bundled entry. */
  bootstrapPath?: string
  /** Override the Node binary. Defaults to `process.execPath`. */
  nodePath?: string
  /** Inject a logger. */
  logger?: Logger
  /**
   * Override the runtime-env file path. Defaults to
   * `~/.config/2200/runtime.env`. Pass `null` to disable runtime-env
   * loading entirely (tests).
   */
  runtimeEnvPath?: string | null
  /**
   * Wait for the spawned daemon to acquire its supervisor lock before
   * returning. Defaults to true: when set, startDaemon's return is a
   * real "daemon is up" signal. Tests that use a bogus bootstrap path
   * (which never spawns a lock-acquiring process) pass false.
   */
  waitForReady?: boolean
}

/**
 * Launch the supervisor as a detached background process. Returns the
 * child's PID. Throws if a live daemon is already running.
 */
export async function startDaemon(opts: StartDaemonOptions): Promise<number> {
  const log = opts.logger ?? createLogger('daemon')
  const paths = homePaths(opts.home)
  await mkdir(paths.state, { recursive: true })

  const existing = await readLivePid(opts.home)
  if (existing !== null) {
    throw new Error(`supervisor daemon already running with PID ${String(existing)}`)
  }
  // Migration check: a daemon from an older 2200 release (pre-lock)
  // writes a PID file but never acquires the lock. Detect it via
  // kill(0) so we refuse to start a second one, with a clear message
  // for the operator.
  const legacy = await readLegacyPidFile(opts.home)
  if (legacy !== null) {
    throw new Error(
      `supervisor daemon already running with PID ${String(legacy)} ` +
        `(legacy format, no lock file). Stop the old daemon (\`kill ${String(legacy)}\` or ` +
        `restart it under the new release) before starting a new one. ` +
        `If you know the process is stale, remove ${pidFilePath(opts.home)} and retry.`,
    )
  }

  const bootstrapPath = opts.bootstrapPath ?? defaultBootstrapPath()
  const nodePath = opts.nodePath ?? process.execPath
  const logPath = logFilePath(opts.home)

  // Load runtime.env so the daemon (and the agents it later starts)
  // inherit long-lived secrets like LLM-provider API keys without the
  // user having to source a shell rc before `2200 daemon start`.
  // Parse errors throw and abort the launch; missing file is fine
  // (the daemon starts; agents will fail loudly if their required
  // keys aren't set, which is the correct degraded behavior).
  let runtimeEnv: Record<string, string> = {}
  let runtimeEnvFromPath: string | null = null
  if (opts.runtimeEnvPath !== null) {
    const target = opts.runtimeEnvPath ?? defaultRuntimeEnvPath()
    runtimeEnv = await loadRuntimeEnv(target)
    runtimeEnvFromPath = target
  }

  // Open the log file for append; the child process inherits the FD as
  // its stdout and stderr.
  const logHandle = await open(logPath, 'a')
  try {
    const child = spawn(nodePath, [bootstrapPath, '--home', opts.home], {
      detached: true,
      stdio: ['ignore', logHandle.fd, logHandle.fd],
      env: { ...process.env, ...runtimeEnv },
    })

    if (child.pid === undefined) {
      throw new Error('failed to start supervisor daemon: no pid')
    }

    // Detach from the parent so we can exit without leaving the child
    // as a zombie.
    child.unref()

    // Seed the PID file with the spawned child's PID. The child's own
    // bootstrap will rewrite it (same value) and acquire the lock.
    // The seed is here so a CLI command that runs in the spawn-to-boot
    // window has at least the PID file to read.
    await writePidFile(opts.home, child.pid)

    if (opts.waitForReady !== false) {
      // Wait up to ~10s for the child to acquire the supervisor lock.
      // This makes startDaemon's return a real "daemon is up" signal:
      // any caller that then runs readLivePid will see the lock and
      // get the PID back, rather than racing the child's boot.
      const lockReady = await waitForLockAcquisition(pidFilePath(opts.home), 10_000)
      if (!lockReady) {
        // The child spawned but did not take the lock in 10s. Either
        // it crashed during boot or it's hung. Either way, do not lie
        // to the caller about "daemon started".
        throw new Error(
          `supervisor daemon spawned (PID ${String(child.pid)}) but did not acquire the lock within 10s. ` +
            `Check ${logPath} for errors.`,
        )
      }
    }

    log.info('supervisor daemon started', {
      pid: child.pid,
      home: opts.home,
      logPath,
      runtime_env_loaded: Object.keys(runtimeEnv).length,
      runtime_env_path: runtimeEnvFromPath,
    })

    return child.pid
  } finally {
    // The child inherited a duplicate of the FD; closing our handle in
    // the parent does not affect the child.
    await logHandle.close()
  }
}

/**
 * Run the supervisor in the FOREGROUND, for `2200 daemon run` under a service
 * manager (systemd `Type=simple`, launchd, a container ENTRYPOINT, etc.).
 *
 * Unlike startDaemon, this does NOT detach: the supervisor runs as a child with
 * inherited stdio (logs flow to the service manager's journal), and this call
 * does not resolve until the supervisor exits. SIGTERM/SIGINT are forwarded so
 * `systemctl stop` shuts it down gracefully, and the supervisor's exit code is
 * returned so the manager sees success vs. failure correctly. This is the clean
 * alternative to the detached `daemon start`, which fights `Type=forking`'s
 * cgroup tracking (the detached child escapes the unit's control group).
 */
export async function runDaemonForeground(opts: StartDaemonOptions): Promise<number> {
  const paths = homePaths(opts.home)
  await mkdir(paths.state, { recursive: true })
  const bootstrapPath = opts.bootstrapPath ?? defaultBootstrapPath()
  const nodePath = opts.nodePath ?? process.execPath

  let runtimeEnv: Record<string, string> = {}
  if (opts.runtimeEnvPath !== null) {
    runtimeEnv = await loadRuntimeEnv(opts.runtimeEnvPath ?? defaultRuntimeEnvPath())
  }

  const child = spawn(nodePath, [bootstrapPath, '--home', opts.home], {
    stdio: 'inherit',
    env: { ...process.env, ...runtimeEnv },
  })

  const forward = (sig: NodeJS.Signals): void => {
    if (child.pid !== undefined) {
      try {
        child.kill(sig)
      } catch {
        /* already gone */
      }
    }
  }
  process.on('SIGTERM', () => {
    forward('SIGTERM')
  })
  process.on('SIGINT', () => {
    forward('SIGINT')
  })

  return await new Promise<number>((resolve) => {
    child.on('exit', (code, signal) => {
      if (code !== null) {
        resolve(code)
      } else {
        // Signal-terminated: an expected stop (SIGTERM/SIGINT) is success.
        resolve(signal === 'SIGTERM' || signal === 'SIGINT' ? 0 : 1)
      }
    })
    child.on('error', () => {
      resolve(1)
    })
  })
}

/**
 * Send SIGTERM to a running daemon and wait for it to exit. Cleans up
 * the PID file when the daemon dies. Returns true if a daemon was
 * stopped; false if no daemon was running.
 *
 * Liveness is polled with a short interval; the timeout defaults to
 * 5000ms before falling back to SIGKILL.
 */
/**
 * Send a signal to the running daemon. Returns false when no daemon
 * is registered. Used by `2200 daemon restart` to send SIGHUP, which
 * the supervisor's bootstrap interprets as "graceful shutdown that
 * preserves Agent and pub child processes." The CLI follows up by
 * waiting for the PID file to clear and re-starting the daemon.
 */
/**
 * True when a live supervisor currently holds the daemon lock for this home.
 * The lock is the single source of truth for "is the daemon up" ... a stale
 * PID file without a held lock reads as not-running.
 */
export async function isSupervisorRunning(home: string): Promise<boolean> {
  return isLockHeld(pidFilePath(home))
}

export async function signalDaemon(home: string, signal: NodeJS.Signals): Promise<boolean> {
  const pid = await readLivePid(home)
  if (pid === null) return false
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

export async function killDaemon(
  home: string,
  options: { timeoutMs?: number; logger?: Logger } = {},
): Promise<boolean> {
  const log = options.logger ?? createLogger('daemon')
  // Try the lock-based check first. Fall back to the legacy
  // kill(0) path so `daemon stop` can also stop a pre-lock daemon
  // during the one-time upgrade transition.
  let pid = await readLivePid(home)
  if (pid === null) {
    const legacy = await readLegacyPidFile(home)
    if (legacy === null) return false
    pid = legacy
    log.warn('stopping legacy daemon (no lock file)', { pid })
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
  // "Gone" means the PROCESS is actually dead (kill(0) → ESRCH), for both
  // legacy and lock-aware daemons. Do NOT trust lock-release alone: a buggy
  // or service-manager-interrupted shutdown could release the lock without
  // the process exiting, and we'd report "stopped" while it keeps serving.
  // Requiring real process death is what makes `daemon stop` honest ... and
  // escalates to SIGKILL if the process lingers.
  const isStillAlive = (): boolean => isPidAlive(pid)

  while (Date.now() - start < timeoutMs) {
    if (!isStillAlive()) {
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
    if (!isStillAlive()) {
      return true
    }
    await sleep(pollIntervalMs)
  }

  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Poll until the daemon's PID-file lock is held, or a timeout elapses.
 * Used by startDaemon to convert "spawn returned" into "daemon is up".
 */
async function waitForLockAcquisition(filePath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isLockHeld(filePath)) return true
    await sleep(100)
  }
  return isLockHeld(filePath)
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
  // Fall back to the cli/main case; the launch will error visibly if
  // the file is missing and the user can pass `bootstrapPath` explicitly.
  const fallback = candidates[0]
  if (!fallback) throw new Error('no bootstrap path candidates configured')
  return fallback
}
