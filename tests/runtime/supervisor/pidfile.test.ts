/**
 * Tests for the supervisor PID file utility.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isProcessAlive,
  pidFilePath,
  readLivePid,
  readPidFile,
  removePidFile,
  writePidFile,
} from '../../../src/runtime/supervisor/pidfile.js'

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
  it('returns the current process PID when the PID file points at it', async () => {
    await writePidFile(home, process.pid)
    expect(await readLivePid(home)).toBe(process.pid)
  })

  it('returns null when the PID file is stale (process not alive)', async () => {
    await writePidFile(home, 2147483647)
    expect(await readLivePid(home)).toBeNull()
  })

  it('returns null when the PID file does not exist', async () => {
    expect(await readLivePid(home)).toBeNull()
  })
})
