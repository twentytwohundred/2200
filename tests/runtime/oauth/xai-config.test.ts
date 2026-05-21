/**
 * Tests for the xAI OIDC discovery loader + provider config helper.
 *
 * The runtime fetches xAI's discovery doc at flow time rather than
 * hardcoding endpoints. Tests cover happy-path parse, missing-grant
 * defensive failure, and missing-S256 defensive failure ... the
 * second two are the "xAI quietly drops a feature one day" guards.
 */
import { describe, expect, it } from 'vitest'
import { fetchXaiDiscovery, xaiDeviceFlowProvider } from '../../../src/runtime/oauth/xai-config.js'

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function stubFetch(res: Response): typeof fetch {
  const impl: typeof fetch = () => Promise.resolve(res)
  return impl
}

const FULL_DISCOVERY = {
  issuer: 'https://auth.x.ai',
  authorization_endpoint: 'https://auth.x.ai/oauth2/authorize',
  token_endpoint: 'https://auth.x.ai/oauth2/token',
  device_authorization_endpoint: 'https://auth.x.ai/oauth2/device/code',
  revocation_endpoint: 'https://auth.x.ai/oauth2/revoke',
  grant_types_supported: [
    'authorization_code',
    'refresh_token',
    'urn:ietf:params:oauth:grant-type:device_code',
  ],
  code_challenge_methods_supported: ['S256'],
  scopes_supported: ['openid', 'offline_access', 'api:access', 'grok-cli:access'],
}

describe('fetchXaiDiscovery', () => {
  it('parses a well-formed discovery document', async () => {
    const doc = await fetchXaiDiscovery({
      url: 'https://issuer.test/.well-known/openid-configuration',
      fetchImpl: stubFetch(jsonRes(200, FULL_DISCOVERY)),
    })
    expect(doc.issuer).toBe('https://auth.x.ai')
    expect(doc.device_authorization_endpoint).toBe('https://auth.x.ai/oauth2/device/code')
    expect(doc.token_endpoint).toBe('https://auth.x.ai/oauth2/token')
    expect(doc.revocation_endpoint).toBe('https://auth.x.ai/oauth2/revoke')
  })

  it('rejects a doc that drops the device_code grant', async () => {
    // Defensive guard: if xAI ever stops advertising device-code, the
    // CLI should fail at flow start with a clear message, not crash
    // mid-poll with a confusing 4xx.
    const broken = {
      ...FULL_DISCOVERY,
      grant_types_supported: ['authorization_code', 'refresh_token'],
    }
    await expect(
      fetchXaiDiscovery({
        url: 'https://issuer.test/.well-known/openid-configuration',
        fetchImpl: stubFetch(jsonRes(200, broken)),
      }),
    ).rejects.toThrow(/device_code/)
  })

  it("rejects a doc that doesn't advertise PKCE S256", async () => {
    // The bug Hermes hit on #27573. If our defensive check fires
    // here we caught the same issue before any user-facing request.
    const broken = {
      ...FULL_DISCOVERY,
      code_challenge_methods_supported: ['plain'],
    }
    await expect(
      fetchXaiDiscovery({
        url: 'https://issuer.test/.well-known/openid-configuration',
        fetchImpl: stubFetch(jsonRes(200, broken)),
      }),
    ).rejects.toThrow(/S256/)
  })

  it('rejects an HTTP error response cleanly', async () => {
    await expect(
      fetchXaiDiscovery({
        url: 'https://issuer.test/.well-known/openid-configuration',
        fetchImpl: stubFetch(jsonRes(503, {})),
      }),
    ).rejects.toThrow(/503/)
  })
})

describe('xaiDeviceFlowProvider', () => {
  it('builds a DeviceFlowProviderConfig with the shared CLI client + standard scopes', () => {
    const provider = xaiDeviceFlowProvider(FULL_DISCOVERY)
    expect(provider.name).toBe('xai-oauth')
    expect(provider.clientId).toBe('b1a00492-073a-47ea-816f-4c329264a828')
    expect(provider.deviceAuthorizationUrl).toBe('https://auth.x.ai/oauth2/device/code')
    expect(provider.tokenUrl).toBe('https://auth.x.ai/oauth2/token')
    expect(provider.revocationUrl).toBe('https://auth.x.ai/oauth2/revoke')
    expect(provider.scopes).toEqual(['openid', 'offline_access', 'grok-cli:access', 'api:access'])
  })
})
