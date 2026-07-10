/**
 * Tests for the in-process session manager that backs the browser-driven
 * subscription sign-ins. The HTTP route layer holds one of these per
 * daemon; per-test isolation is trivial because each test creates its
 * own instance. Sessions carry opaque per-provider poll state (device
 * flows) or a background-completed authorization URL (loopback flows).
 */
import { describe, expect, it } from 'vitest'
import {
  DeviceFlowSessionManager,
  type SessionPublic,
} from '../../../src/runtime/oauth/device-flow-session.js'

function makeInput(): Parameters<DeviceFlowSessionManager['create']>[0] {
  return {
    slug: 'xai-oauth',
    flow: 'device',
    userCode: 'TEST-CODE',
    verificationUri: 'https://auth.x.ai/oauth2/device',
    verificationUriComplete: 'https://auth.x.ai/oauth2/device?user_code=TEST-CODE',
    expiresAtMs: Date.now() + 600_000,
    intervalSec: 5,
    pollState: {
      token_url: 'https://auth.x.ai/oauth2/token',
      client_id: 'public-client-id',
      device_code: 'D-1234',
      code_verifier: 'pkce-verifier-not-a-real-one-just-for-test',
    },
  }
}

describe('DeviceFlowSessionManager', () => {
  it('round-trips create + get', () => {
    const mgr = new DeviceFlowSessionManager()
    const pub: SessionPublic = mgr.create(makeInput())
    expect(pub.session_id).toMatch(/^[0-9a-f]{32}$/)
    expect(pub.flow).toBe('device')
    expect(pub.user_code).toBe('TEST-CODE')
    expect(pub.verification_uri).toBe('https://auth.x.ai/oauth2/device')
    expect(pub.poll_interval_sec).toBe(5)
    const rec = mgr.get(pub.session_id)
    expect(rec).toBeDefined()
    expect(rec?.slug).toBe('xai-oauth')
    expect(rec?.pollState['device_code']).toBe('D-1234')
    expect(rec?.pollState['code_verifier']).toBe('pkce-verifier-not-a-real-one-just-for-test')
  })

  it('holds loopback sessions with an authorization URL and a cancel hook', () => {
    const mgr = new DeviceFlowSessionManager()
    let cancelled = false
    const pub = mgr.create({
      slug: 'openai-oauth',
      flow: 'loopback',
      authorizationUrl: 'https://auth.openai.com/api/accounts/authorize?client_id=x',
      expiresAtMs: Date.now() + 600_000,
      intervalSec: 2,
      cancel: () => {
        cancelled = true
      },
    })
    expect(pub.flow).toBe('loopback')
    expect(pub.authorization_url).toContain('auth.openai.com')
    expect(pub.user_code).toBeUndefined()
    // Removing a loopback session aborts its redirect listener.
    mgr.remove(pub.session_id)
    expect(cancelled).toBe(true)
  })

  it('returns undefined for unknown session ids', () => {
    const mgr = new DeviceFlowSessionManager()
    expect(mgr.get('bogus')).toBeUndefined()
  })

  it('lazy-GCs sessions past their expiry window', () => {
    let now = 1_000_000
    const mgr = new DeviceFlowSessionManager(() => now)
    const pub = mgr.create({ ...makeInput(), expiresAtMs: now + 600_000 })
    // Still within the +60s grace after expiry → present
    now = now + 600_000 + 30_000
    expect(mgr.get(pub.session_id)).toBeDefined()
    // Past the grace window → evicted
    now = now + 60_000
    expect(mgr.get(pub.session_id)).toBeUndefined()
    expect(mgr.size()).toBe(0)
  })

  it('lazy-GC also aborts an expired loopback listener', () => {
    let now = 1_000_000
    const mgr = new DeviceFlowSessionManager(() => now)
    let cancelled = false
    const pub = mgr.create({
      slug: 'openai-oauth',
      flow: 'loopback',
      authorizationUrl: 'https://auth.openai.com/api/accounts/authorize?client_id=x',
      expiresAtMs: now + 600_000,
      intervalSec: 2,
      cancel: () => {
        cancelled = true
      },
    })
    now = now + 600_000 + 61_000
    expect(mgr.get(pub.session_id)).toBeUndefined()
    expect(cancelled).toBe(true)
  })

  it('preserves completed sessions past expiry so re-polls are idempotent', () => {
    let now = 1_000_000
    const mgr = new DeviceFlowSessionManager(() => now)
    const pub = mgr.create({ ...makeInput(), expiresAtMs: now + 600_000 })
    mgr.recordCompletion(pub.session_id, {
      status: 'completed',
      access_token: '<sealed>',
      refresh_token: '<sealed>',
      expires_at_ms: now + 3_600_000,
      granted_scopes: ['api:access'],
    })
    // Far past the expiry, completed sessions stick around
    now = now + 24 * 3_600_000
    expect(mgr.get(pub.session_id)).toBeDefined()
  })

  it('bumps the polling interval on slow_down', () => {
    const mgr = new DeviceFlowSessionManager()
    const pub = mgr.create({ ...makeInput(), intervalSec: 5 })
    mgr.bumpInterval(pub.session_id, 5)
    expect(mgr.get(pub.session_id)?.intervalSec).toBe(10)
    mgr.bumpInterval(pub.session_id, 5)
    expect(mgr.get(pub.session_id)?.intervalSec).toBe(15)
  })

  it('clamps the interval at 60s upper bound', () => {
    const mgr = new DeviceFlowSessionManager()
    const pub = mgr.create({ ...makeInput(), intervalSec: 5 })
    for (let i = 0; i < 20; i++) mgr.bumpInterval(pub.session_id, 5)
    expect(mgr.get(pub.session_id)?.intervalSec).toBe(60)
  })

  it('remove deletes the session', () => {
    const mgr = new DeviceFlowSessionManager()
    const pub = mgr.create(makeInput())
    expect(mgr.size()).toBe(1)
    expect(mgr.remove(pub.session_id)).toBe(true)
    expect(mgr.size()).toBe(0)
    expect(mgr.remove(pub.session_id)).toBe(false)
  })
})
