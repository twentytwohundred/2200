/**
 * Tests for the supervisor PID file utility.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireSupervisorLock,
  isProcessAlive,
  pidFilePath,
  readLegacyPidFile,
  readLivePid,
  readPidFile,
  removePidFile,
  writePidFile,
} from '../../../src/runtime/supervisor/pidfile.js'
import type { ProcessLock } from '../../../src/runtime/supervisor/process-lock.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-pidfile-'))
  // Pidfile lives at <home>/state/supervisor.pid; create the parent so
  // tests that write directly via fs (not via writePidFile, which mkdirs
  // for us) can land their content.
  await mkdir(join(home, 'state'), { recursive: true })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('writePidFile / readPidFile', () => {
  it('round-trips a PID', async () => {
    await writePidFile(home, 12345)
    expect(await readPidFile(home)).toBe(12345)
  })

  it('writes a file at supervisor.pid in the state dir', async () => {
    await writePidFile(home, 1)
    const raw = await readFile(pidFilePath(home), 'utf8')
    expect(raw.trim()).toBe('1')
  })

  it('returns null when the file does not exist', async () => {
    expect(await readPidFile(home)).toBeNull()
  })

  it('returns null for malformed content', async () => {
    await writeFile(pidFilePath(home), 'not-a-pid')
    expect(await readPidFile(home)).toBeNull()
  })

  it('returns null for negative or zero PID', async () => {
    await writeFile(pidFilePath(home), '0')
    expect(await readPidFile(home)).toBeNull()
    await writeFile(pidFilePath(home), '-5')
    expect(await readPidFile(home)).toBeNull()
  })
})

describe('removePidFile', () => {
  it('removes an existing file', async () => {
    await writePidFile(home, 1)
    await removePidFile(home)
    expect(await readPidFile(home)).toBeNull()
  })

  it('is a no-op when the file does not exist', async () => {
    await expect(removePidFile(home)).resolves.toBeUndefined()
  })
})

describe('isProcessAlive', () => {
  it('returns true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('returns false for an obviously-invalid PID', () => {
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
  })

  it('returns false for a non-existent PID', () => {
    // PID 2^31 - 1 is unlikely to be in use on any system.
    expect(isProcessAlive(2147483647)).toBe(false)
  })
})

describe('readLivePid', () => {
  // readLivePid is now lock-based, not kill(0)-based: it returns the
  // PID iff the supervisor process lock is held. A bare PID file with
  // no lock is treated as "not running" ... that is the hazard-free
  // policy and is the load-bearing behavior we want covered here.
  let lock: ProcessLock | null = null

  afterEach(async () => {
    if (lock) {
      await lock.release()
      lock = null
    }
  })

  it('returns the PID when the supervisor lock is held', async () => {
    lock = await acquireSupervisorLock(home, process.pid)
    expect(await readLivePid(home)).toBe(process.pid)
  })

  it('returns null when no lock is held even if the PID file is alive', async () => {
    // This is the stranger-PID protection in action: the PID file
    // points at a live process (us), but without the lock we treat
    // it as no daemon ... no recycled-PID confusion possible.
    await writePidFile(home, process.pid)
    expect(await readLivePid(home)).toBeNull()
  })

  it('returns null when the PID file is stale and no lock is held', async () => {
    await writePidFile(home, 2147483647)
    expect(await readLivePid(home)).toBeNull()
  })

  it('returns null when the PID file does not exist', async () => {
    expect(await readLivePid(home)).toBeNull()
  })
})

describe('readLegacyPidFile', () => {
  // The migration path: a daemon from a pre-lock 2200 release writes
  // a PID file but never acquires the lock. `daemon start` and
  // `daemon stop` use readLegacyPidFile to detect that case during the
  // one-time transition.
  let lock: ProcessLock | null = null

  afterEach(async () => {
    if (lock) {
      await lock.release()
      lock = null
    }
  })

  it('returns the PID for an alive PID-file with no lock', async () => {
    await writePidFile(home, process.pid)
    expect(await readLegacyPidFile(home)).toBe(process.pid)
  })

  it('returns null when the lock IS held (a lock-aware daemon is alive)', async () => {
    // If the lock is held, the daemon is current ... not legacy.
    // readLegacyPidFile must NOT fire here, or we would double-report
    // an alive daemon.
    lock = await acquireSupervisorLock(home, process.pid)
    expect(await readLegacyPidFile(home)).toBeNull()
  })

  it('returns null when the PID file is stale (process gone)', async () => {
    await writePidFile(home, 2147483647)
    expect(await readLegacyPidFile(home)).toBeNull()
  })

  it('returns null when no PID file exists', async () => {
    expect(await readLegacyPidFile(home)).toBeNull()
  })
})
