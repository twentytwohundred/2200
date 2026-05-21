/**
 * Process locks for daemon + Agent liveness.
 *
 * Replaces the historical "is `kill(pid, 0)` succeeding?" liveness model
 * with a lock-on-a-file model. The old approach trusted that the named
 * PID was still our process, which breaks when the OS recycles a PID and
 * a stranger process ends up with the same number (especially likely on
 * long-uptime hosts or after PID-space wraparound).
 *
 * The lock model removes that trust: we ask "does anyone currently hold
 * this specific lockfile?" instead of "is some PID alive?". A stranger
 * process cannot fake the lock because it does not know the lockfile
 * exists.
 *
 * The lock is backed by `proper-lockfile`, the same library npm itself
 * uses. Implementation note: that library uses `mkdir` atomicity (not
 * `fcntl`) plus mtime-based staleness detection. The practical effect:
 *
 *   - Lock is auto-released on graceful process exit (via the library's
 *     exit hook).
 *   - On crash / SIGKILL / OOM-kill, the lock looks held for up to
 *     `STALE_MS` after the process dies; after that the staleness check
 *     considers it free.
 *   - mtime is refreshed every `UPDATE_MS` while the process is alive,
 *     so a slow process is not mistaken for a dead one.
 *
 * The `STALE_MS` window is the cost of not using true `fcntl` locks.
 * It is acceptable for 2200's use case (one daemon per host, restarts
 * are intentional events). If we ever need instant-recovery-on-crash,
 * we can swap the implementation for a native `fcntl`/`flock` binding
 * without changing this module's surface.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import lockfile from 'proper-lockfile'

/**
 * Staleness window. If a lockfile's mtime is older than this, the
 * holder is considered dead.
 *
 * 10s is the library default and is well-suited to our workload:
 *   - normal acquire/release latency is sub-millisecond
 *   - the daemon's heartbeat refreshes mtime every UPDATE_MS
 *   - a 10s window after SIGKILL before a new daemon can start is
 *     a fair price for not needing native bindings
 */
const STALE_MS = 10_000

/**
 * Heartbeat interval for the lock holder. The library updates the
 * lockfile's mtime this often so checkers know we are still alive.
 * Must be less than STALE_MS.
 */
const UPDATE_MS = 5_000

/**
 * A held lock. Calling `release()` drops the lock and lets another
 * process acquire it. Release is also called automatically by the
 * library's process-exit hook on graceful exit.
 */
export interface ProcessLock {
  /** Path to the file the lock is taken on. */
  readonly filePath: string
  /** Drop the lock. Idempotent: safe to call multiple times. */
  release(): Promise<void>
}

/**
 * Acquire an exclusive lock on `filePath`. The file is created if it
 * does not exist (with optional initial contents); proper-lockfile
 * requires the target to exist before locking.
 *
 * Throws if another live process already holds the lock. The error's
 * `code` will be `'ELOCKED'` in that case.
 *
 * Pass `initialContents` to overwrite the target before acquiring.
 * For PID files, this is the new PID. For a pure liveness lock with
 * no content, pass `''` (empty string).
 */
export async function acquireProcessLock(
  filePath: string,
  initialContents: string,
): Promise<ProcessLock> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, initialContents)
  const release = await lockfile.lock(filePath, {
    stale: STALE_MS,
    update: UPDATE_MS,
    realpath: false,
    retries: 0,
  })
  let released = false
  return {
    filePath,
    async release() {
      if (released) return
      released = true
      try {
        await release()
      } catch {
        // Already released (e.g., process-exit hook fired). Idempotent.
      }
    },
  }
}

/**
 * Check whether `filePath` is currently held by a live process.
 *
 * Returns true iff a non-stale lock exists for the file.
 *
 * Returns false if:
 *   - the file does not exist
 *   - no lock has been taken
 *   - the lock exists but its mtime is older than `STALE_MS`
 *     (holder is presumed dead)
 *
 * This is the lock-based replacement for the legacy
 * `isPidAlive(readPidFile(home))` check. It does not require knowing
 * the PID at all.
 */
export async function isLockHeld(filePath: string): Promise<boolean> {
  try {
    return await lockfile.check(filePath, {
      stale: STALE_MS,
      realpath: false,
    })
  } catch (err) {
    // ENOENT means the file does not exist, which means no lock.
    if (isEnoent(err)) return false
    throw err
  }
}

/**
 * Wait until `filePath`'s lock is released (or the file is gone),
 * polling every `pollMs` until `timeoutMs` elapses.
 *
 * Returns true if the lock cleared within the budget, false on timeout.
 * Used by daemon shutdown + the upgrade-runner to know when it is safe
 * to take over.
 */
export async function waitForLockRelease(
  filePath: string,
  timeoutMs: number,
  pollMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await isLockHeld(filePath))) return true
    await sleep(pollMs)
  }
  return !(await isLockHeld(filePath))
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
