/**
 * Tests for the daemon start / kill helpers.
 *
 * These tests do NOT actually start the supervisor (that requires the
 * built dist/ bundle and would be a slower e2e test). They exercise the
 * pre-conditions and error paths: refusing to start when a live daemon
 * is already registered, and reporting nothing-to-stop cleanly.
 *
 * The start-and-RPC end-to-end path is covered by manual verification
 * (documented in the PR) plus the existing supervisor-uds integration
 * tests against an in-process Supervisor.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { killDaemon, logFilePath, startDaemon } from '../../../src/runtime/supervisor/daemon.js'
import { pidFilePath, readLivePid, writePidFile } from '../../../src/runtime/supervisor/pidfile.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-daemon-test-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('logFilePath', () => {
  it('returns supervisor.log inside <home>/state', () => {
    expect(logFilePath(home)).toBe(join(home, 'state', 'supervisor.log'))
  })
})

describe('startDaemon precondition', () => {
  it('refuses when a live daemon is already registered', async () => {
    // Use the current process PID as a guaranteed-alive sentinel.
    await writePidFile(home, process.pid)
    await expect(startDaemon({ home })).rejects.toThrow(/already running/)
  })

  it('proceeds past the precondition when the registered PID is stale', async () => {
    // PID 2^31 - 1 is essentially never live; the precondition treats it
    // as "no daemon" and would attempt to start. We point bootstrapPath
    // at a non-existent file so the launch itself is deterministic and
    // does not actually fork a real supervisor; we only verify the
    // precondition gate lets us through.
    await writePidFile(home, 2147483647)
    const result = await startDaemon({
      home,
      bootstrapPath: '/nonexistent/path/that/will/error/in/the/child',
    })
    expect(typeof result).toBe('number')
    expect(result).toBeGreaterThan(0)
  })
})

describe('runtime-env loading on start', () => {
  it('proceeds when runtimeEnvPath points at a non-existent file', async () => {
    await writePidFile(home, 2147483647)
    const result = await startDaemon({
      home,
      bootstrapPath: '/nonexistent/path/that/will/error/in/the/child',
      runtimeEnvPath: join(home, 'no-such-runtime-env.env'),
    })
    expect(result).toBeGreaterThan(0)
  })

  it('respects runtimeEnvPath: null (disabled load) without throwing', async () => {
    await writePidFile(home, 2147483647)
    const result = await startDaemon({
      home,
      bootstrapPath: '/nonexistent/path/that/will/error/in/the/child',
      runtimeEnvPath: null,
    })
    expect(result).toBeGreaterThan(0)
  })

  it('aborts the start when runtime-env file has a parse error', async () => {
    await writePidFile(home, 2147483647)
    const { writeFile } = await import('node:fs/promises')
    const badPath = join(home, 'bad-runtime.env')
    await writeFile(badPath, 'this line is missing the equals sign\n')
    await expect(
      startDaemon({
        home,
        bootstrapPath: '/nonexistent/path/that/will/error/in/the/child',
        runtimeEnvPath: badPath,
      }),
    ).rejects.toThrowError(/runtime\.env parse error/)
  })
})

describe('killDaemon', () => {
  it('returns false when no daemon is running', async () => {
    expect(await killDaemon(home)).toBe(false)
  })

  it('returns false when the PID file is stale', async () => {
    await writePidFile(home, 2147483647)
    expect(await killDaemon(home)).toBe(false)
  })

  it('does not crash when the PID file is malformed', async () => {
    // Writing a malformed PID file via the lower-level fs API since
    // writePidFile validates input. readLivePid returns null for
    // malformed content; killDaemon then returns false cleanly.
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(join(home, 'state'), { recursive: true })
    await writeFile(pidFilePath(home), 'not-a-pid')
    expect(await killDaemon(home)).toBe(false)
    expect(await readLivePid(home)).toBeNull()
  })
})
