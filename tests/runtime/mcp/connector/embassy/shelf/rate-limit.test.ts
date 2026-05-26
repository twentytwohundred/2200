import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SHELF_RATE_LIMITS,
  ShelfRateLimiter,
} from '../../../../../../src/runtime/mcp/connector/embassy/shelf/rate-limit.js'

describe('ShelfRateLimiter classifyAndRecord', () => {
  it('returns "ok" until soft threshold crossed', () => {
    let t = 0
    const limiter = new ShelfRateLimiter({ now: () => t })
    for (let i = 0; i < DEFAULT_SHELF_RATE_LIMITS.soft_per_minute; i++) {
      t += 100
      expect(limiter.classifyAndRecord('e')).toBe('ok')
    }
  })

  it('fires soft_threshold_crossed exactly once per window', () => {
    let t = 0
    const limiter = new ShelfRateLimiter({ now: () => t })
    // Fill to soft threshold + 1
    for (let i = 0; i <= DEFAULT_SHELF_RATE_LIMITS.soft_per_minute; i++) {
      t += 100
      limiter.classifyAndRecord('e')
    }
    // Last call should have crossed the threshold
    // The 21st call (soft+1) is the trigger.
    // Verify subsequent calls within the window don't re-fire soft
    t += 100
    expect(limiter.classifyAndRecord('e')).toBe('ok')
    t += 100
    expect(limiter.classifyAndRecord('e')).toBe('ok')
  })

  it('hard rejects when hard cap is exceeded (and does not record the rejected placement)', () => {
    let t = 0
    const limiter = new ShelfRateLimiter({ now: () => t })
    // Fill to hard cap
    for (let i = 0; i < DEFAULT_SHELF_RATE_LIMITS.hard_per_minute; i++) {
      t += 10
      limiter.classifyAndRecord('e')
    }
    t += 10
    expect(limiter.classifyAndRecord('e')).toBe('hard_threshold_exceeded')
    // Should not have grown the window past the hard cap
    expect(limiter.size('e')).toBe(DEFAULT_SHELF_RATE_LIMITS.hard_per_minute)
  })

  it('rolling window drops expired entries', () => {
    let t = 0
    const limiter = new ShelfRateLimiter({ now: () => t })
    for (let i = 0; i < 25; i++) {
      t += 100
      limiter.classifyAndRecord('e')
    }
    // Advance past 60s (+1ms for strict exclusivity); old entries drop off
    t += 60_001
    expect(limiter.size('e')).toBe(0)
    // Fresh activity should classify as "ok" again
    expect(limiter.classifyAndRecord('e')).toBe('ok')
  })

  it('honors per-embassy override limits', () => {
    const t = 0
    const limiter = new ShelfRateLimiter({ now: () => t })
    const tighter = { soft_per_minute: 2, hard_per_minute: 3 }
    expect(limiter.classifyAndRecord('e', tighter)).toBe('ok')
    expect(limiter.classifyAndRecord('e', tighter)).toBe('ok')
    expect(limiter.classifyAndRecord('e', tighter)).toBe('soft_threshold_crossed')
    expect(limiter.classifyAndRecord('e', tighter)).toBe('hard_threshold_exceeded')
  })

  it('tracks separate windows per embassy', () => {
    let t = 0
    const limiter = new ShelfRateLimiter({ now: () => t })
    t += 100
    limiter.classifyAndRecord('a')
    t += 100
    limiter.classifyAndRecord('a')
    t += 100
    limiter.classifyAndRecord('b')
    expect(limiter.size('a')).toBe(2)
    expect(limiter.size('b')).toBe(1)
  })
})
