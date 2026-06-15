/**
 * Tests for the Discord cutover sequencing.
 *
 * Why this matters: the same bot token must never be live from both
 * OpenClaw and 2200 at once (both Agents would answer ... the exact
 * confusion the cutover eliminates). And a cutover that fails must never
 * leave the operator dark on Discord. These tests pin the ordered
 * sequence and every rollback path, with all side effects injected:
 *
 *   - happy path: stop OpenClaw BEFORE wiring 2200, verify, done (no rollback)
 *   - 2200 fails to connect → roll back by restarting OpenClaw
 *   - wiring throws → roll back by restarting OpenClaw
 *   - can't stop OpenClaw → never wire 2200 (avoid two live bots), no rollback
 */
import { describe, expect, it, vi } from 'vitest'
import {
  carryDiscordWithCutover,
  type DiscordCutoverEffects,
} from '../../../src/runtime/migration/discord-cutover.js'

const DISCORD = { botToken: 'bot.tok.en', channelIds: ['111'], userIds: ['222'] }

function effects(over: Partial<DiscordCutoverEffects> = {}): {
  e: DiscordCutoverEffects
  calls: string[]
} {
  const calls: string[] = []
  // Wrap every effect (default OR override) so the call ORDER is always
  // recorded, regardless of which impl a test injects.
  const wrap = <A extends unknown[], R>(name: string, impl: (...a: A) => Promise<R>) =>
    vi.fn(async (...a: A): Promise<R> => {
      calls.push(name)
      const r = await impl(...a)
      return r
    })
  const e: DiscordCutoverEffects = {
    stopOpenClaw: wrap(
      'stop',
      over.stopOpenClaw ?? (() => Promise.resolve({ ok: true, detail: 'stopped' })),
    ),
    startOpenClaw: wrap(
      'start',
      over.startOpenClaw ?? (() => Promise.resolve({ ok: true, detail: 'restarted' })),
    ),
    wireDiscord: wrap('wire', over.wireDiscord ?? (() => Promise.resolve())),
    verifyConnected: wrap(
      'verify',
      over.verifyConnected ??
        (() => Promise.resolve({ connected: true, botUsername: 'skippy', detail: 'ok' })),
    ),
    log: over.log ?? (() => undefined),
  }
  return { e, calls }
}

describe('carryDiscordWithCutover', () => {
  it('stops OpenClaw BEFORE wiring 2200, then verifies (no rollback)', async () => {
    const { e, calls } = effects()
    const r = await carryDiscordWithCutover(e, DISCORD)
    expect(r.ok).toBe(true)
    expect(r.botUsername).toBe('skippy')
    expect(r.rolledBack).toBe(false)
    // Order is load-bearing: stop must precede wire so the token is never
    // live from two places at once.
    expect(calls).toEqual(['stop', 'wire', 'verify'])
    expect(e.startOpenClaw).not.toHaveBeenCalled()
  })

  it('rolls back (restarts OpenClaw) when 2200 does not connect', async () => {
    const { e, calls } = effects({
      verifyConnected: vi.fn(() =>
        Promise.resolve({ connected: false, botUsername: null, detail: 'no pairing' }),
      ),
    })
    const r = await carryDiscordWithCutover(e, DISCORD)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('verify-failed')
    expect(r.rolledBack).toBe(true)
    expect(calls).toEqual(['stop', 'wire', 'verify', 'start'])
  })

  it('rolls back when wiring throws', async () => {
    const { e, calls } = effects({
      wireDiscord: vi.fn(() => Promise.reject(new Error('setup endpoint returned 500'))),
    })
    const r = await carryDiscordWithCutover(e, DISCORD)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('wire-failed')
    expect(r.rolledBack).toBe(true)
    expect(calls).toEqual(['stop', 'wire', 'start'])
    expect(e.verifyConnected).not.toHaveBeenCalled()
  })

  it('never wires 2200 when OpenClaw cannot be stopped (no two live bots)', async () => {
    const { e, calls } = effects({
      stopOpenClaw: vi.fn(() => Promise.resolve({ ok: false, detail: 'no systemd, no cli' })),
    })
    const r = await carryDiscordWithCutover(e, DISCORD)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('oc-stop-failed')
    expect(r.rolledBack).toBe(false)
    expect(calls).toEqual(['stop'])
    expect(e.wireDiscord).not.toHaveBeenCalled()
    expect(e.startOpenClaw).not.toHaveBeenCalled()
  })

  it('reports rollback failure without throwing (operator gets manual steps)', async () => {
    const logs: string[] = []
    const { e } = effects({
      verifyConnected: vi.fn(() =>
        Promise.resolve({ connected: false, botUsername: null, detail: 'x' }),
      ),
      startOpenClaw: vi.fn(() => Promise.resolve({ ok: false, detail: 'cli missing' })),
      log: (_l, m) => logs.push(m),
    })
    const r = await carryDiscordWithCutover(e, DISCORD)
    expect(r.ok).toBe(false)
    expect(r.rolledBack).toBe(false)
    expect(logs.some((m) => /openclaw gateway start/i.test(m))).toBe(true)
  })
})
