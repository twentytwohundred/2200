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
import { readFile, unlink, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { atomicWriteFile } from '../util/atomic-write.js'
import { homePaths } from '../storage/layout.js'

/** Path to the PID file under <home>/state/supervisor.pid. */
export function pidFilePath(home: string): string {
  return homePaths(home).stateSupervisorPid
}

/**
 * Read the PID from the file at `<home>/state/supervisor.pid`, or null
 * if the file does not exist or is malformed.
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

/** Atomically write the daemon's PID to `<home>/state/supervisor.pid`. */
export async function writePidFile(home: string, pid: number): Promise<void> {
  const path = pidFilePath(home)
  await mkdir(dirname(path), { recursive: true })
  await atomicWriteFile(path, `${String(pid)}\n`)
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
 * Read the PID file and check liveness. Returns the live PID if present
 * and alive; null if no PID file, malformed PID file, or stale (process
 * gone).
 */
export async function readLivePid(home: string): Promise<number | null> {
  const pid = await readPidFile(home)
  if (pid === null) return null
  if (!isProcessAlive(pid)) return null
  return pid
}

function isNodeNotFoundError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT'
}
