import { describe, expect, it } from 'vitest'
import { FAVICON_COLORS, faviconStateFor, type FleetSnapshot } from '../../src/favicon/state'

/**
 * The favicon's status-light contract. The brief calls out a strict
 * priority: connection beats agent-error beats inbox beats idle. This
 * file pins that priority and pins the four color hexes themselves
 * (changing either is a brand decision, not a refactor).
 */

function snapshot(over: Partial<FleetSnapshot> = {}): FleetSnapshot {
  return {
    connected: true,
    errorCount: 0,
    inboxCount: 0,
    idleCount: 0,
    ...over,
  }
}

describe('faviconStateFor priority', () => {
  it('disconnected wins over every other signal', () => {
    // The user must not be lied to about a fleet we cannot see. Even
    // if cached counts say something is wrong, the icon must say
    // "offline" so the operator does not act on stale info.
    expect(
      faviconStateFor({
        connected: false,
        errorCount: 5,
        inboxCount: 5,
        idleCount: 5,
      }),
    ).toBe('off')
  })

  it('agent errors raise to err even with idle agents and clean inbox', () => {
    expect(faviconStateFor(snapshot({ errorCount: 1, idleCount: 3 }))).toBe('err')
  })

  it('pending inbox raises to err when no agent errors', () => {
    // inbox > 0 means the human owes a decision; ambient idle agents
    // are still less important than that ask.
    expect(faviconStateFor(snapshot({ inboxCount: 1, idleCount: 3 }))).toBe('err')
  })

  it('idle agents raise to warn when nothing demands attention', () => {
    expect(faviconStateFor(snapshot({ idleCount: 1 }))).toBe('warn')
  })

  it('all-quiet is ok', () => {
    expect(faviconStateFor(snapshot())).toBe('ok')
  })
})

describe('FAVICON_COLORS pinned hex', () => {
  // Pin per the brief; changing any of these is a brand decision.
  it('ok is the system green', () => {
    expect(FAVICON_COLORS.ok).toBe('#22c97a')
  })
  it('warn is the system amber', () => {
    expect(FAVICON_COLORS.warn).toBe('#e3a847')
  })
  it('err is the system red', () => {
    expect(FAVICON_COLORS.err).toBe('#e35d4d')
  })
  it('off is the system slate', () => {
    expect(FAVICON_COLORS.off).toBe('#7a8089')
  })
})
