/**
 * PID file management for the supervisor daemon.
 *
 * The PID file lives at `<state-dir>/supervisor.pid`. It exists while
 * the daemon is running and is removed on graceful shutdown.
 *
 * Liveness model:
 *
 *   The supervisor daemon (and every Agent) acquires a process lock on
 *   its PID file when it starts. The lock is the authoritative "is
 *   this thing alive?" signal: every liveness check asks
 *   `isLockHeld(pidPath)` instead of `kill(pid, 0)`. This eliminates
 *   the stranger-PID hazard ... a recycled PID owned by an unrelated
 *   process cannot fake the lock.
 *
 *   The PID number stored in the file is retained for two reasons:
 *     (a) operator inspection ... `cat supervisor.pid` is useful
 *     (b) signal targeting ... `daemon stop` reads the PID and sends
 *         SIGTERM directly to it AFTER the lock-based liveness check
 *         confirms the PID belongs to our daemon
 *
 *   `kill(pid, 0)` survives only as a migration fallback in
 *   `readLegacyPidFile`. New installs and post-migration installs use
 *   the lock path exclusively.
 *
 * See decisions/2026-05-21-pid-file-liveness-via-lockfiles.md.
 */
import { readFile, unlink, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { atomicWriteFile } from '../util/atomic-write.js'
import { homePaths } from '../storage/layout.js'
import { acquireProcessLock, isLockHeld, type ProcessLock } from './process-lock.js'

/** Path to the PID file under <home>/state/supervisor.pid. */
export function pidFilePath(home: string): string {
  return homePaths(home).stateSupervisorPid
}

/**
 * Read the PID from the file at `<home>/state/supervisor.pid`, or null
 * if the file does not exist or is malformed. Does NOT consult liveness;
 * use `readLivePid` for that.
 */
export async function readPidFile(home: string): Promise<number | null> {
  try {
    const raw = await readFile(pidFilePath(home), 'utf8')
    const pid = Number.parseInt(raw.trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch (err) {
    if (isNodeNotFoundError(err)) return null
    throw err
  }
}

/**
 * Atomically write the daemon's PID to `<home>/state/supervisor.pid`.
 *
 * Writes the file but does NOT take the lock. The caller (the daemon's
 * own bootstrap) must follow up with `acquireSupervisorLock` to mark
 * itself live.
 */
export async function writePidFile(home: string, pid: number): Promise<void> {
  const path = pidFilePath(home)
  await mkdir(dirname(path), { recursive: true })
  await atomicWriteFile(path, `${String(pid)}\n`)
}

/**
 * Acquire the supervisor process lock. Called by the daemon's bootstrap
 * immediately after `writePidFile`. The returned handle must be
 * released on graceful shutdown.
 *
 * Throws (with `code: 'ELOCKED'`) if another live daemon already holds
 * the lock.
 */
export async function acquireSupervisorLock(home: string, pid: number): Promise<ProcessLock> {
  return acquireProcessLock(pidFilePath(home), `${String(pid)}\n`)
}

/** Remove the PID file if present. Idempotent. */
export async function removePidFile(home: string): Promise<void> {
  try {
    await unlink(pidFilePath(home))
  } catch (err) {
    if (isNodeNotFoundError(err)) return
    throw err
  }
}

/**
 * Check whether `pid` refers to a currently-live process. Uses
 * `kill(pid, 0)`.
 *
 * NOTE: this function exists only for the migration path
 * (`readLegacyPidFile`) and the upgrade-runner's wait-for-pid-exit
 * loop. New code should NOT use it as a liveness signal; the
 * lock-based `isLockHeld(pidFilePath(home))` is the authoritative
 * check.
 *
 * Returns true on positive confirmation (kill succeeds).
 * Returns false only on ESRCH (definitively gone).
 * Any other error (EPERM, etc.) returns true: we cannot prove the
 * slot is free, so we treat it as occupied.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ESRCH') return false
    return true
  }
}

/** Back-compat alias. Prefer `isPidAlive`. */
export const isProcessAlive = isPidAlive

/**
 * Return the PID of the currently-live supervisor daemon, or null if
 * no daemon is running.
 *
 * "Live" means: the supervisor process lock is held. The PID is read
 * from the PID file purely so callers can target signals at it; the
 * lock is what proves liveness.
 */
export async function readLivePid(home: string): Promise<number | null> {
  const path = pidFilePath(home)
  if (!(await isLockHeld(path))) return null
  return readPidFile(home)
}

/**
 * Migration-only: detect an old-format (pre-lock) daemon that may
 * still be running. Returns the PID iff a PID file exists AND that
 * PID is alive (per `kill(0)`) AND no lock is held (the new-format
 * daemon takes the lock, so an unlocked-but-alive PID means a legacy
 * daemon or a stranger).
 *
 * `daemon start` uses this to issue a clear migration message during
 * the one-time transition. `daemon stop` uses this to find and stop
 * a legacy daemon.
 */
export async function readLegacyPidFile(home: string): Promise<number | null> {
  const path = pidFilePath(home)
  if (await isLockHeld(path)) return null
  const pid = await readPidFile(home)
  if (pid === null) return null
  if (!isPidAlive(pid)) return null
  return pid
}

function isNodeNotFoundError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT'
}
