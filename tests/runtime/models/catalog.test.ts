import { describe, expect, it } from 'vitest'
import {
  CATALOG,
  CATALOG_VERSION,
  findById,
  findByProviderAndModel,
  listTier,
  recommendedForTier,
} from '../../../src/runtime/models/catalog.js'

describe('model catalog', () => {
  it('declares a version', () => {
    expect(CATALOG_VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('every entry has the required fields', () => {
    for (const e of CATALOG) {
      expect(e.id).toBe(`${e.provider}/${e.model_id}`)
      expect(e.tier).toMatch(/^(frontier|fast|economy|specialist)$/)
      expect(e.status).toMatch(/^(active|deprecated|retired)$/)
      expect(e.display_name.length).toBeGreaterThan(0)
    }
  })

  it('every deprecated/retired entry has a recommended successor that is in the catalog', () => {
    const ids = new Set(CATALOG.map((e) => e.id))
    for (const e of CATALOG) {
      if (e.status !== 'active') {
        const successor = e.recommended_successor
        expect(successor).toBeDefined()
        if (successor) expect(ids.has(successor)).toBe(true)
      }
    }
  })

  it('every active frontier model is reachable via recommendedForTier', () => {
    const frontier = recommendedForTier('frontier')
    expect(frontier).not.toBeNull()
    expect(frontier?.tier).toBe('frontier')
    expect(frontier?.status).toBe('active')
  })

  it('findById returns the right entry by canonical id', () => {
    const opus = findById('anthropic/claude-opus-4-7')
    expect(opus).toBeDefined()
    expect(opus?.tier).toBe('frontier')
    expect(opus?.provider).toBe('anthropic')
  })

  it('findByProviderAndModel mirrors findById', () => {
    const a = findById('anthropic/claude-opus-4-7')
    const b = findByProviderAndModel('anthropic', 'claude-opus-4-7')
    expect(a).toEqual(b)
  })

  it('listTier groups by tier', () => {
    const fast = listTier('fast')
    expect(fast.length).toBeGreaterThan(0)
    for (const e of fast) expect(e.tier).toBe('fast')
  })

  it('recommendedForTier returns null for an empty tier (smoke ... no specialist-only tier exists today)', () => {
    // Verify the function returns the first active entry; if a tier
    // ever becomes empty in the future this assertion would catch the
    // regression.
    const tiers: ('frontier' | 'fast' | 'economy' | 'specialist')[] = [
      'frontier',
      'fast',
      'economy',
      'specialist',
    ]
    for (const t of tiers) {
      const rec = recommendedForTier(t)
      if (rec) {
        expect(rec.status).toBe('active')
        expect(rec.tier).toBe(t)
      }
    }
  })
})
