/**
 * Lifecycle helpers ... unit-level coverage.
 *
 * The pieces under test are the non-fork machinery that we can exercise
 * without spinning up real Agent processes:
 *
 *   - `isPidAlive`: signal-0 probe.
 *   - `getProcessArgv`: ps-based argv read.
 *   - `validateAdoptedProcessArgv`: substring match between current process
 *     and an expected bootstrap path.
 *   - `adoptAgent`: AdoptedAgent.stop() escalates SIGTERM -> SIGKILL.
 *
 * Start + restart integration with the supervisor is covered indirectly
 * by the supervisor test suite; here we keep the surface narrow and
 * deterministic.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  adoptAgent,
  getProcessArgv,
  isPidAlive,
  validateAdoptedProcessArgv,
} from '../../../src/runtime/supervisor/lifecycle.js'

/**
 * Launch a long-running node subprocess we can probe + kill. Returns the
 * ChildProcess so tests can clean up. Tracking lets afterEach hang up any
 * stragglers if a test bails.
 */
const tracked: ChildProcess[] = []
function launchSleeper(durationMs = 30_000): ChildProcess {
  const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${String(durationMs)})`], {
    stdio: 'ignore',
    detached: false,
  })
  if (typeof child.pid !== 'number') {
    throw new Error('sleeper failed to start')
  }
  tracked.push(child)
  return child
}

afterEach(() => {
  while (tracked.length > 0) {
    const c = tracked.pop()
    if (c && typeof c.pid === 'number' && c.exitCode === null && c.signalCode === null) {
      try {
        c.kill('SIGKILL')
      } catch {
        // ignore
      }
    }
  }
})

describe('isPidAlive', () => {
  it('returns true for a live process', () => {
    const c = launchSleeper()
    expect(c.pid).toBeDefined()
    expect(isPidAlive(c.pid!)).toBe(true)
  })

  it('returns false for a dead process', async () => {
    const c = launchSleeper()
    const pid = c.pid!
    c.kill('SIGKILL')
    // Wait for exit to land in the kernel.
    await new Promise<void>((resolve) =>
      c.once('exit', () => {
        resolve()
      }),
    )
    expect(isPidAlive(pid)).toBe(false)
  })

  it('returns false for a clearly-bogus pid', () => {
    // PID 2^22 is well above any plausible live PID on macOS/Linux.
    expect(isPidAlive(4_194_303)).toBe(false)
  })
})

describe('getProcessArgv', () => {
  it("returns the running process's command line for a live pid", () => {
    const c = launchSleeper()
    const argv = getProcessArgv(c.pid!)
    expect(argv).not.toBeNull()
    // Started with `node -e '<script>'` so the argv string should contain
    // the node binary path. The `-e` flag may not be retained in `ps`
    // output across platforms, so we just check the binary.
    expect(argv).toContain('node')
  })

  it('returns null for a dead pid', async () => {
    const c = launchSleeper()
    const pid = c.pid!
    c.kill('SIGKILL')
    await new Promise<void>((resolve) =>
      c.once('exit', () => {
        resolve()
      }),
    )
    expect(getProcessArgv(pid)).toBeNull()
  })
})

describe('validateAdoptedProcessArgv', () => {
  it('returns true when the argv contains the expected bootstrap path', () => {
    const c = launchSleeper()
    // The sleeper's argv contains `node`, so checking against `node` is a
    // proxy for "argv mentions this token". In production, the supervisor
    // checks for the bootstrap path like `dist/runtime/agent/bootstrap.js`.
    expect(validateAdoptedProcessArgv(c.pid!, 'node')).toBe(true)
  })

  it('returns false when the argv does not contain the expected path', () => {
    const c = launchSleeper()
    expect(validateAdoptedProcessArgv(c.pid!, '/some/nonexistent/path/to/bootstrap.js')).toBe(false)
  })

  it('returns false for a dead pid (no argv available)', async () => {
    const c = launchSleeper()
    const pid = c.pid!
    c.kill('SIGKILL')
    await new Promise<void>((resolve) =>
      c.once('exit', () => {
        resolve()
      }),
    )
    expect(validateAdoptedProcessArgv(pid, 'node')).toBe(false)
  })
})

describe('adoptAgent.stop()', () => {
  it('sends SIGTERM and waits for clean exit', async () => {
    const c = launchSleeper()
    const pid = c.pid!
    const tracked = adoptAgent('test-agent', pid, '/tmp/lifecycle-test-no-home')
    // No SIGKILL escalation needed; the sleeper exits cleanly on SIGTERM.
    await tracked.stop(5000)
    expect(isPidAlive(pid)).toBe(false)
  })

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    // Start a process that traps SIGTERM and ignores it. SIGKILL cannot be
    // trapped, so the stop() escalation is what makes it die.
    const child = spawn(
      process.execPath,
      [
        '-e',
        // Stay alive ignoring SIGTERM; only SIGKILL gets through.
        'process.on("SIGTERM", () => {}); setTimeout(() => {}, 30000);',
      ],
      { stdio: 'ignore', detached: false },
    )
    if (typeof child.pid !== 'number') throw new Error('sigterm-resistant sleeper failed to start')
    tracked.push(child)
    const tractor = adoptAgent('test-agent', child.pid, '/tmp/lifecycle-test-no-home')
    // 500ms timeout: short enough to keep the test fast; long enough to
    // confirm SIGTERM was tried before SIGKILL.
    await tractor.stop(500)
    expect(isPidAlive(child.pid)).toBe(false)
  })

  it('returns silently if the process is already gone', async () => {
    const c = launchSleeper()
    const pid = c.pid!
    c.kill('SIGKILL')
    await new Promise<void>((resolve) =>
      c.once('exit', () => {
        resolve()
      }),
    )
    const tracked = adoptAgent('test-agent', pid, '/tmp/lifecycle-test-no-home')
    await expect(tracked.stop(1000)).resolves.toBeUndefined()
  })
})

describe('adoptAgent.exited', () => {
  it('resolves when the adopted process exits', async () => {
    const c = launchSleeper()
    const tracked = adoptAgent('test-agent', c.pid!, '/tmp/lifecycle-test-no-home')
    setTimeout(() => c.kill('SIGTERM'), 100)
    const result = await tracked.exited
    // We don't get the real code/signal because we didn't start the process.
    expect(result).toEqual({ code: null, signal: null })
  })
})
