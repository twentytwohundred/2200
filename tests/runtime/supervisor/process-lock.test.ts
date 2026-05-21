/**
 * Tests for the process-lock primitive.
 *
 * The library is `proper-lockfile`; these tests verify the thin
 * wrapper we put around it, plus the cross-process behavior that
 * matters for daemon + Agent liveness (a second process cannot
 * acquire a held lock; release frees it; check correctly reports
 * holdership; the stranger-PID hazard the lock was added to fix is
 * actually defeated).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireProcessLock,
  isLockHeld,
  waitForLockRelease,
  type ProcessLock,
} from '../../../src/runtime/supervisor/process-lock.js'

let dir: string
const heldLocks: ProcessLock[] = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), '2200-lock-test-'))
})

afterEach(async () => {
  while (heldLocks.length > 0) {
    const l = heldLocks.pop()
    if (l) {
      try {
        await l.release()
      } catch {
        // best-effort
      }
    }
  }
  await rm(dir, { recursive: true, force: true })
})

async function acquire(filePath: string, contents = ''): Promise<ProcessLock> {
  const lock = await acquireProcessLock(filePath, contents)
  heldLocks.push(lock)
  return lock
}

describe('acquireProcessLock', () => {
  it('writes the initial contents and acquires the lock', async () => {
    const path = join(dir, 'a.lock')
    await acquire(path, 'hello\n')
    expect(await isLockHeld(path)).toBe(true)
  })

  it('refuses a second concurrent acquire on the same file', async () => {
    // The hazard guard: two daemons cannot both think they are alive.
    const path = join(dir, 'b.lock')
    await acquire(path, '1\n')
    await expect(acquireProcessLock(path, '2\n')).rejects.toMatchObject({ code: 'ELOCKED' })
  })

  it('release() makes the file lockable again', async () => {
    const path = join(dir, 'c.lock')
    const first = await acquireProcessLock(path, 'x')
    await first.release()
    expect(await isLockHeld(path)).toBe(false)
    // Second acquire from the same process succeeds.
    await acquire(path, 'y')
    expect(await isLockHeld(path)).toBe(true)
  })

  it('release() is idempotent', async () => {
    const path = join(dir, 'd.lock')
    const lock = await acquireProcessLock(path, '')
    await lock.release()
    await expect(lock.release()).resolves.toBeUndefined()
  })
})

describe('isLockHeld', () => {
  it('returns false for a file that has never been locked', async () => {
    const path = join(dir, 'never-locked')
    await writeFile(path, 'present-but-unlocked\n')
    expect(await isLockHeld(path)).toBe(false)
  })

  it('returns false for a nonexistent file', async () => {
    expect(await isLockHeld(join(dir, 'missing'))).toBe(false)
  })

  it('returns true while a lock is held', async () => {
    const path = join(dir, 'e.lock')
    await acquire(path, '')
    expect(await isLockHeld(path)).toBe(true)
  })
})

describe('cross-process stranger-PID hazard guard', () => {
  it('refuses acquire when a different process holds the lock', async () => {
    // The scenario this lock model was added to fix: another process
    // already represents "the live daemon". Even if our process knows
    // the PID, it should not be able to second-acquire the lock.
    //
    // We spawn a child that takes the lock, then assert the parent's
    // acquire fails. Once the child exits gracefully, the lock is
    // released and the parent can acquire.
    const path = join(dir, 'cross.lock')
    await writeFile(path, '')

    const child = spawn(
      process.execPath,
      [
        '-e',
        `
        const lockfile = require('proper-lockfile')
        lockfile.lock(process.argv[1], { stale: 10000, update: 5000, realpath: false }).then(() => {
          process.stdout.write('LOCKED\\n')
          process.on('SIGTERM', () => process.exit(0))
          setTimeout(() => process.exit(0), 30000)
        }).catch((err) => {
          process.stderr.write(err.message + '\\n')
          process.exit(1)
        })
        `,
        path,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )

    // Wait for the child to print "LOCKED" so we know it has the lock.
    await new Promise<void>((resolve, reject) => {
      let buf = ''
      const onData = (chunk: Buffer): void => {
        buf += chunk.toString('utf8')
        if (buf.includes('LOCKED')) {
          child.stdout.off('data', onData)
          resolve()
        }
      }
      child.stdout.on('data', onData)
      child.once('exit', () => {
        reject(new Error('child exited before acquiring lock'))
      })
    })

    expect(await isLockHeld(path)).toBe(true)
    await expect(acquireProcessLock(path, '')).rejects.toMatchObject({ code: 'ELOCKED' })

    // Bring the child down; the lock auto-releases.
    child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      child.once('exit', () => {
        resolve()
      })
    })
    expect(await waitForLockRelease(path, 2_000, 50)).toBe(true)
    expect(await isLockHeld(path)).toBe(false)
  })
})

describe('waitForLockRelease', () => {
  it('returns true immediately when the lock is already free', async () => {
    const path = join(dir, 'free')
    expect(await waitForLockRelease(path, 500, 50)).toBe(true)
  })

  it('returns false within the timeout when the lock stays held', async () => {
    const path = join(dir, 'held.lock')
    await acquire(path, '')
    const start = Date.now()
    expect(await waitForLockRelease(path, 400, 50)).toBe(false)
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(350)
  })
})
