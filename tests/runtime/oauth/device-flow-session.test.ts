/**
 * Tests for the in-process session manager that backs the browser-driven
 * device-code flow. The HTTP route layer holds one of these per
 * daemon; per-test isolation is trivial because each test creates its
 * own instance.
 */
import { describe, expect, it } from 'vitest'
import {
  DeviceFlowSessionManager,
  type SessionPublic,
} from '../../../src/runtime/oauth/device-flow-session.js'
import type { DeviceFlowProviderConfig } from '../../../src/runtime/oauth/device-flow.js'

function makeProvider(): DeviceFlowProviderConfig {
  return {
    name: 'xai-oauth',
    deviceAuthorizationUrl: 'https://auth.x.ai/oauth2/device/code',
    tokenUrl: 'https://auth.x.ai/oauth2/token',
    clientId: 'public-client-id',
    scopes: ['openid', 'offline_access', 'api:access'],
  }
}

function makeInput(): Parameters<DeviceFlowSessionManager['create']>[0] {
  return {
    provider: makeProvider(),
    deviceCode: 'D-1234',
    userCode: 'TEST-CODE',
    verificationUri: 'https://auth.x.ai/oauth2/device',
    verificationUriComplete: 'https://auth.x.ai/oauth2/device?user_code=TEST-CODE',
    expiresAtMs: Date.now() + 600_000,
    codeVerifier: 'pkce-verifier-not-a-real-one-just-for-test',
    intervalSec: 5,
  }
}

describe('DeviceFlowSessionManager', () => {
  it('round-trips create + get', () => {
    const mgr = new DeviceFlowSessionManager()
    const pub: SessionPublic = mgr.create(makeInput())
    expect(pub.session_id).toMatch(/^[0-9a-f]{32}$/)
    expect(pub.user_code).toBe('TEST-CODE')
    expect(pub.verification_uri).toBe('https://auth.x.ai/oauth2/device')
    expect(pub.poll_interval_sec).toBe(5)
    const rec = mgr.get(pub.session_id)
    expect(rec).toBeDefined()
    expect(rec?.deviceCode).toBe('D-1234')
    expect(rec?.codeVerifier).toBe('pkce-verifier-not-a-real-one-just-for-test')
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
