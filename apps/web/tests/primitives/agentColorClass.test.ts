import { describe, expect, it } from 'vitest'
import { agentColorClass } from '../../src/primitives/agentColorClass'

/**
 * Pinned fixtures for the deterministic agent-color hash (v1.1 design
 * system: six hues, char-code sum mod 6). These pairs MUST stay stable
 * across runtime versions and across services. If one of these
 * expectations changes, every Agent's color in every UI suddenly
 * shifts, which breaks the recognition contract documented in
 * wiki/design-system/tokens.json::agentHues.
 *
 * Update this fixture only when the contract itself changes (rare).
 */
const PINNED: { id: string; expected: string }[] = [
  { id: '', expected: 'agent-c0' },
  { id: 'a', expected: 'agent-c1' },
  { id: 'hobby', expected: 'agent-c4' },
  { id: 'simon', expected: 'agent-c4' },
  { id: 'poe', expected: 'agent-c0' },
  { id: 'guppi', expected: 'agent-c3' },
  { id: 'david', expected: 'agent-c4' },
  { id: 'jodin', expected: 'agent-c4' },
]

describe('agentColorClass (pinned hash, v1.1 mod-6)', () => {
  it.each(PINNED)('hashes "$id" to $expected', ({ id, expected }) => {
    expect(agentColorClass(id)).toBe(expected)
  })

  it('is deterministic: same input produces same output across calls', () => {
    const id = 'mira-abc-123'
    expect(agentColorClass(id)).toBe(agentColorClass(id))
  })

  it('returns a slot in 0..5', () => {
    const ids = ['a', 'foo', 'longer-id-with-dashes', 'X', '__internal__']
    for (const id of ids) {
      const cls = agentColorClass(id)
      const slot = Number(cls.replace('agent-c', ''))
      expect(Number.isInteger(slot)).toBe(true)
      expect(slot).toBeGreaterThanOrEqual(0)
      expect(slot).toBeLessThanOrEqual(5)
    }
  })

  it('handles non-ASCII characters via charCodeAt', () => {
    // Smoke-only: just verify we get a valid slot, not a specific one.
    expect(agentColorClass('日本語')).toMatch(/^agent-c[0-5]$/)
    expect(agentColorClass('mira-é')).toMatch(/^agent-c[0-5]$/)
  })
})
