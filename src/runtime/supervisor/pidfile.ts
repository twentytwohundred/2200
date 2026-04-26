/**
 * PID file management for the supervisor daemon.
 *
 * The PID file lives at `<state-dir>/supervisor.pid`. It exists while the
 * daemon is running and is removed on graceful shutdown. A "stale" PID
 * file (file exists, named PID does not refer to a live process) is
 * treated as no daemon running; the next `daemon start` overwrites it.
 *
 * Liveness check uses POSIX `kill(pid, 0)` semantics via Node's
 * `process.kill(pid, 0)`, which sends no signal but throws if the
 * process does not exist or is owned by a different user we cannot
 * signal.
 */
import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile } from '../util/atomic-write.js'

const PIDFILE_NAME = 'supervisor.pid'

export function pidFilePath(stateDir: string): string {
  return join(stateDir, PIDFILE_NAME)
}

/**
 * Read the PID from the file at `<state-dir>/supervisor.pid`, or null if
 * the file does not exist or is malformed.
 */
export async function readPidFile(stateDir: string): Promise<number | null> {
  try {
    const raw = await readFile(pidFilePath(stateDir), 'utf8')
    const pid = Number.parseInt(raw.trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch (err) {
    if (isNodeNotFoundError(err)) return null
    throw err
  }
}

/** Atomically write the daemon's PID to `<state-dir>/supervisor.pid`. */
export async function writePidFile(stateDir: string, pid: number): Promise<void> {
  await atomicWriteFile(pidFilePath(stateDir), `${String(pid)}\n`)
}

/** Remove the PID file if present. Idempotent. */
export async function removePidFile(stateDir: string): Promise<void> {
  try {
    await unlink(pidFilePath(stateDir))
  } catch (err) {
    if (isNodeNotFoundError(err)) return
    throw err
  }
}

/**
 * Check whether `pid` refers to a currently-live process. Uses kill(pid, 0)
 * which sends no signal but checks existence and signal-permission.
 *
 * Returns false for any error (process gone, permission denied to signal,
 * pid invalid). Returns true only when we can confirm the process exists.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Read the PID file and check liveness. Returns the live PID if present and
 * alive; null if no PID file, malformed PID file, or stale (process gone).
 */
export async function readLivePid(stateDir: string): Promise<number | null> {
  const pid = await readPidFile(stateDir)
  if (pid === null) return null
  if (!isProcessAlive(pid)) return null
  return pid
}

function isNodeNotFoundError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT'
}
