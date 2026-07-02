/**
 * Login rate-limit / lockout tests.
 */
import { describe, expect, it } from 'vitest'
import { LoginRateLimiter, loginRateLimitKey } from '../../../src/runtime/http/login-rate-limit.js'

function limiter(now: () => number) {
  return new LoginRateLimiter({ maxFailures: 3, windowMs: 60_000, lockoutMs: 300_000, now })
}

describe('LoginRateLimiter', () => {
  it('allows attempts until the failure threshold, then locks out', () => {
    const t = 1_000_000
    const rl = limiter(() => t)
    const KEY = 'ip:1.2.3.4'
    expect(rl.check(KEY).allowed).toBe(true)
    rl.recordFailure(KEY)
    rl.recordFailure(KEY)
    expect(rl.check(KEY).allowed).toBe(true) // 2 failures, still under 3
    rl.recordFailure(KEY) // 3rd failure trips the lockout
    const decision = rl.check(KEY)
    expect(decision.allowed).toBe(false)
    expect(decision.retryAfterSeconds).toBe(300)
  })

  it('lifts the lockout after the cooldown', () => {
    let t = 0
    const rl = limiter(() => t)
    const KEY = 'ip:1.2.3.4'
    rl.recordFailure(KEY)
    rl.recordFailure(KEY)
    rl.recordFailure(KEY)
    expect(rl.check(KEY).allowed).toBe(false)
    t += 300_001 // just past the 5-minute lockout
    expect(rl.check(KEY).allowed).toBe(true)
  })

  it('resets stale failures outside the window (no slow accretion to lockout)', () => {
    let t = 0
    const rl = limiter(() => t)
    const KEY = 'ip:1.2.3.4'
    rl.recordFailure(KEY)
    rl.recordFailure(KEY)
    t += 60_001 // window expired
    rl.recordFailure(KEY) // fresh window, count = 1
    expect(rl.check(KEY).allowed).toBe(true)
  })

  it('a success clears the failure state', () => {
    const t = 0
    const rl = limiter(() => t)
    const KEY = 'ip:1.2.3.4'
    rl.recordFailure(KEY)
    rl.recordFailure(KEY)
    rl.recordSuccess(KEY)
    rl.recordFailure(KEY) // back to 1, not 3
    expect(rl.check(KEY).allowed).toBe(true)
  })

  it('locks clients independently (one attacker cannot lock out everyone)', () => {
    const t = 0
    const rl = limiter(() => t)
    const ATTACKER = 'cf:6.6.6.6'
    const VICTIM = 'cf:10.0.0.9'
    rl.recordFailure(ATTACKER)
    rl.recordFailure(ATTACKER)
    rl.recordFailure(ATTACKER)
    expect(rl.check(ATTACKER).allowed).toBe(false)
    expect(rl.check(VICTIM).allowed).toBe(true)
  })

  it('sweep drops idle entries but keeps active lockouts', () => {
    let t = 0
    const rl = limiter(() => t)
    rl.recordFailure('ip:a') // idle after window
    rl.recordFailure('ip:b')
    rl.recordFailure('ip:b')
    rl.recordFailure('ip:b') // b is locked out
    t += 60_001
    rl.sweep()
    // a's window expired and it's not locked → dropped; b is locked → kept.
    expect(rl.check('ip:b').allowed).toBe(false)
    expect(rl.size()).toBe(1)
  })
})

describe('loginRateLimitKey', () => {
  it('prefers the Cloudflare real-client header (behind the tunnel)', () => {
    expect(
      loginRateLimitKey({ headers: { 'cf-connecting-ip': '203.0.113.7' }, ip: '127.0.0.1' }),
    ).toBe('cf:203.0.113.7')
  })

  it('falls back to the socket address on a direct connection', () => {
    expect(loginRateLimitKey({ headers: {}, ip: '192.168.1.5' })).toBe('ip:192.168.1.5')
  })
})
