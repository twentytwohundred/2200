/**
 * Tests for the RFC 8628 device-flow building blocks: the
 * device-authorization (init) request, the single token poll, and the
 * public-client refresh grant. The blocks are pure I/O driven with a
 * stub `fetch`, so every branch of the protocol
 * (authorization_pending, slow_down, expired_token, access_denied,
 * success) is simulated without a real OAuth server. Loop pacing is
 * the subscription driver's job and is tested with it
 * (subscription-providers.test.ts).
 */
import { describe, expect, it } from 'vitest'
import {
  initDeviceAuthorization,
  pollDeviceTokenOnce,
  refreshDeviceFlowToken,
  type DeviceFlowProviderConfig,
} from '../../../src/runtime/oauth/device-flow.js'
import { OAuthError } from '../../../src/runtime/oauth/types.js'

function makeProvider(): DeviceFlowProviderConfig {
  return {
    name: 'test',
    deviceAuthorizationUrl: 'https://issuer.test/device/code',
    tokenUrl: 'https://issuer.test/token',
    clientId: 'public-client-id',
    scopes: ['openid', 'offline_access', 'api:access'],
  }
}

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

const PKCE = { challenge: 'challenge-challenge-challenge-challenge-123', method: 'S256' }

describe('initDeviceAuthorization', () => {
  it('parses + normalizes the device-authorization response', async () => {
    let requestBody = ''
    const fetchImpl: typeof fetch = (_input, init) => {
      requestBody = typeof init?.body === 'string' ? init.body : ''
      return Promise.resolve(
        jsonRes(200, {
          device_code: 'D-1234',
          user_code: 'WBQX-MKHV',
          verification_uri: 'https://issuer.test/device',
          verification_uri_complete: 'https://issuer.test/device?code=WBQX-MKHV',
          expires_in: 600,
          interval: 5,
        }),
      )
    }
    const now = 1_000_000
    const init = await initDeviceAuthorization({
      provider: makeProvider(),
      codeChallenge: PKCE.challenge,
      codeChallengeMethod: PKCE.method,
      fetchImpl,
      nowFn: () => now,
    })
    expect(init.deviceCode).toBe('D-1234')
    expect(init.userCode).toBe('WBQX-MKHV')
    expect(init.verificationUriComplete).toBe('https://issuer.test/device?code=WBQX-MKHV')
    expect(init.expiresAtMs).toBe(now + 600_000)
    expect(init.intervalSec).toBe(5)
    // PKCE is bound at init: the S256 challenge rides the request.
    const params = new URLSearchParams(requestBody)
    expect(params.get('code_challenge')).toBe(PKCE.challenge)
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('client_id')).toBe('public-client-id')
  })

  it('throws TOKEN_EXCHANGE_FAILED when the device-auth endpoint returns non-2xx', async () => {
    const err = await initDeviceAuthorization({
      provider: makeProvider(),
      codeChallenge: PKCE.challenge,
      codeChallengeMethod: PKCE.method,
      fetchImpl: stubFetch(jsonRes(500, { error: 'server_error' })),
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OAuthError)
    expect((err as OAuthError).code).toBe('TOKEN_EXCHANGE_FAILED')
  })

  it('throws INVALID_RESPONSE when required fields are missing', async () => {
    const err = await initDeviceAuthorization({
      provider: makeProvider(),
      codeChallenge: PKCE.challenge,
      codeChallengeMethod: PKCE.method,
      fetchImpl: stubFetch(jsonRes(200, { device_code: 'D-1' })),
    }).catch((e: unknown) => e)
    expect((err as OAuthError).code).toBe('INVALID_RESPONSE')
  })
})

describe('pollDeviceTokenOnce', () => {
  const ARGS = {
    tokenUrl: 'https://issuer.test/token',
    clientId: 'public-client-id',
    deviceCode: 'D-1234',
    codeVerifier: 'verifier-verifier-verifier-verifier-verify',
  }

  it('maps RFC 8628 authorization_pending (HTTP 400) to pending', async () => {
    const outcome = await pollDeviceTokenOnce({
      ...ARGS,
      fetchImpl: stubFetch(jsonRes(400, { error: 'authorization_pending' })),
    })
    expect(outcome.status).toBe('pending')
  })

  it('maps slow_down to slow_down (caller bumps the interval)', async () => {
    const outcome = await pollDeviceTokenOnce({
      ...ARGS,
      fetchImpl: stubFetch(jsonRes(400, { error: 'slow_down' })),
    })
    expect(outcome.status).toBe('slow_down')
  })

  it('returns the tokens on approval', async () => {
    let requestBody = ''
    const fetchImpl: typeof fetch = (_input, init) => {
      requestBody = typeof init?.body === 'string' ? init.body : ''
      return Promise.resolve(
        jsonRes(200, { access_token: 'bearer-abc', refresh_token: 'refresh-xyz' }),
      )
    }
    const outcome = await pollDeviceTokenOnce({ ...ARGS, fetchImpl })
    expect(outcome.status).toBe('completed')
    if (outcome.status === 'completed') {
      expect(outcome.tokens.access_token).toBe('bearer-abc')
    }
    // The PKCE verifier is replayed on every poll, public-client style.
    const params = new URLSearchParams(requestBody)
    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code')
    expect(params.get('code_verifier')).toBe(ARGS.codeVerifier)
    expect(params.get('client_secret')).toBeNull()
  })

  it('surfaces terminal provider errors with their code + description', async () => {
    for (const code of ['access_denied', 'expired_token', 'invalid_grant']) {
      const outcome = await pollDeviceTokenOnce({
        ...ARGS,
        fetchImpl: stubFetch(jsonRes(400, { error: code, error_description: 'detail' })),
      })
      expect(outcome.status).toBe('failed')
      if (outcome.status === 'failed') {
        expect(outcome.error).toBe(code)
        expect(outcome.description).toBe('detail')
      }
    }
  })

  it('reports network blips as transient (caller keeps polling)', async () => {
    const fetchImpl: typeof fetch = () => Promise.reject(new Error('ECONNRESET'))
    const outcome = await pollDeviceTokenOnce({ ...ARGS, fetchImpl })
    expect(outcome.status).toBe('transient')
  })
})

describe('refreshDeviceFlowToken', () => {
  it('returns the new access + (rotated) refresh token on success', async () => {
    let requestBody = ''
    const fetchImpl: typeof fetch = (_input, init) => {
      requestBody = typeof init?.body === 'string' ? init.body : ''
      return Promise.resolve(
        jsonRes(200, {
          access_token: 'bearer-new',
          refresh_token: 'refresh-rotated',
          expires_in: 3600,
        }),
      )
    }
    const tokens = await refreshDeviceFlowToken({
      provider: { tokenUrl: 'https://issuer.test/token', clientId: 'public-client-id' },
      refreshToken: 'refresh-old',
      fetchImpl,
    })
    expect(tokens.access_token).toBe('bearer-new')
    expect(tokens.refresh_token).toBe('refresh-rotated')
    // Public-client refresh: no client_secret on the wire.
    const params = new URLSearchParams(requestBody)
    expect(params.get('grant_type')).toBe('refresh_token')
    expect(params.get('client_secret')).toBeNull()
  })

  it('throws TOKEN_EXCHANGE_FAILED on invalid_grant (revoked refresh)', async () => {
    const err = await refreshDeviceFlowToken({
      provider: { tokenUrl: 'https://issuer.test/token', clientId: 'public-client-id' },
      refreshToken: 'refresh-revoked',
      fetchImpl: stubFetch(jsonRes(400, { error: 'invalid_grant' })),
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OAuthError)
    expect((err as OAuthError).code).toBe('TOKEN_EXCHANGE_FAILED')
  })
})
