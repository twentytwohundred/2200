/**
 * Tests for disabling / re-enabling the source OpenClaw gateway.
 *
 * Why this matters: after a Discord cutover, OpenClaw must not come back
 * on the next login/boot ... a stopped-but-still-enabled systemd unit
 * would restart and put the SAME bot on Discord again, so two Agents
 * answer. The gateway's unit is `openclaw-gateway` (an earlier version of
 * this code disabled the wrong name, `openclaw`, so it never actually
 * disabled). These tests pin that we issue `disable` for the real unit,
 * and that rollback re-enables it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const calls: string[] = []

interface FakeChild {
  on: (event: string, cb: (code?: number) => void) => FakeChild
}

vi.mock('node:child_process', () => ({
  spawn: (cmd: string, args: string[]): FakeChild => {
    calls.push(`${cmd} ${args.join(' ')}`)
    const child: FakeChild = {
      on(event: string, cb: (code?: number) => void): FakeChild {
        // Every command "succeeds" so we exercise the full command set.
        if (event === 'exit')
          queueMicrotask(() => {
            cb(0)
          })
        return child
      },
    }
    return child
  },
}))

const { disableOpenClaw, enableOpenClaw } =
  await import('../../../src/runtime/migration/openclaw.js')

afterEach(() => {
  calls.length = 0
})

describe('disableOpenClaw', () => {
  it('disables the openclaw-gateway unit so it does not restart on boot', async () => {
    const r = await disableOpenClaw()
    expect(r.ok).toBe(true)
    expect(r.detail).toMatch(/disabled/)
    // The load-bearing line: the REAL unit name gets disabled.
    expect(calls).toContain('systemctl --user disable openclaw-gateway')
    // And the gateway is stopped now via the CLI.
    expect(calls).toContain('openclaw gateway stop')
  })
})

describe('enableOpenClaw', () => {
  it('re-enables the openclaw-gateway unit and starts it (rollback)', async () => {
    const r = await enableOpenClaw()
    expect(r.ok).toBe(true)
    expect(calls).toContain('systemctl --user enable openclaw-gateway')
    expect(calls).toContain('openclaw gateway start')
  })
})
