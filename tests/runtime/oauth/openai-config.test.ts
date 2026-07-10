/**
 * Tests for the OpenAI / ChatGPT OAuth config: discovery loader,
 * device-flow start + poll normalization, and the JWT metadata reads.
 *
 * The device wire shape is pinned to what the live surface returned on
 * 2026-07-10 (string `interval`, ISO `expires_at`, HTTP 403 +
 * `deviceauth_authorization_pending` while pending). The poll SUCCESS
 * shape is unverified upstream; these tests encode the two payloads
 * the adapter accepts (direct tokens, authorization-code exchange) so
 * a verification-day correction changes exactly one config block and
 * its test.
 */
import { describe, expect, it } from 'vitest'
import {
  accessTokenExpiryMs,
  extractChatgptAccountId,
  fetchOpenAiDiscovery,
  OPENAI_DEVICE_AUTH_WIRE,
  openaiLoopbackProvider,
  pollOpenAiDeviceTokenOnce,
  startOpenAiDeviceFlow,
} from '../../../src/runtime/oauth/openai-config.js'

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

/** Unsigned JWT with the given payload (metadata reads only; no signature check). */
function fakeJwt(payload: Record<string, unknown>): string {
  const enc = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(payload)}.signature`
}

const LIVE_DISCOVERY = {
  issuer: 'https://auth.openai.com',
  authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
  token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token',
  scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
}

describe('fetchOpenAiDiscovery', () => {
  it('parses the live discovery document shape', async () => {
    const doc = await fetchOpenAiDiscovery({ fetchImpl: stubFetch(jsonRes(200, LIVE_DISCOVERY)) })
    expect(doc.authorization_endpoint).toBe('https://auth.openai.com/api/accounts/authorize')
    expect(doc.token_endpoint).toBe('https://auth.openai.com/api/accounts/oauth/token')
  })

  it('fails loud when the authorization_code grant disappears', async () => {
    const doc = { ...LIVE_DISCOVERY, grant_types_supported: ['refresh_token'] }
    await expect(fetchOpenAiDiscovery({ fetchImpl: stubFetch(jsonRes(200, doc)) })).rejects.toThrow(
      /authorization_code/,
    )
  })

  it('fails loud when S256 disappears', async () => {
    const doc = { ...LIVE_DISCOVERY, code_challenge_methods_supported: ['plain'] }
    await expect(fetchOpenAiDiscovery({ fetchImpl: stubFetch(jsonRes(200, doc)) })).rejects.toThrow(
      /S256/,
    )
  })

  it('builds the loopback provider config with the originator param', () => {
    const provider = openaiLoopbackProvider({
      issuer: 'https://auth.openai.com',
      authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
      token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token',
    })
    expect(provider.authUrl).toContain('/api/accounts/authorize')
    expect(provider.extraAuthParams?.['originator']).toBe('codex_cli_rs')
    expect(provider.defaultScopes).toContain('offline_access')
  })
})

describe('startOpenAiDeviceFlow', () => {
  // Exactly what the live mint returned on 2026-07-10: interval is a
  // STRING and expires_at is an ISO timestamp.
  const LIVE_MINT = {
    device_auth_id: 'deviceauth_abc123',
    user_code: 'YM3A-N8J3U',
    interval: '5',
    expires_at: '2026-07-10T13:00:10.800263+00:00',
  }

  it('normalizes the live mint shape (string interval, ISO expiry)', async () => {
    // Pin the clock 10 minutes before the fixture's expires_at so the
    // absolute timestamp is honored as-is (sane-clock case).
    const now = Date.parse('2026-07-10T13:00:10.800263+00:00') - 600_000
    const start = await startOpenAiDeviceFlow({
      fetchImpl: stubFetch(jsonRes(200, LIVE_MINT)),
      nowFn: () => now,
    })
    expect(start.userCode).toBe('YM3A-N8J3U')
    expect(start.intervalSec).toBe(5)
    expect(start.expiresAtMs).toBe(Date.parse('2026-07-10T13:00:10.800263+00:00'))
    expect(start.verificationUri).toBe(OPENAI_DEVICE_AUTH_WIRE.verificationUri)
    expect(start.pollState.deviceAuthId).toBe('deviceauth_abc123')
    expect(start.pollState.codeVerifier.length).toBeGreaterThan(20)
  })

  it('defaults expiry to ~15min when expires_at is unparseable', async () => {
    const now = 1_000_000
    const start = await startOpenAiDeviceFlow({
      fetchImpl: stubFetch(jsonRes(200, { ...LIVE_MINT, expires_at: 'garbage' })),
      nowFn: () => now,
    })
    expect(start.expiresAtMs).toBe(now + 900_000)
  })

  it('floors an already-past expires_at (local clock ahead of the server)', async () => {
    // A machine clock running ahead of OpenAI's would otherwise see the
    // code as expired before the first poll and kill the flow.
    const now = Date.parse('2026-07-10T13:00:10.800263+00:00') + 120_000
    const start = await startOpenAiDeviceFlow({
      fetchImpl: stubFetch(jsonRes(200, LIVE_MINT)),
      nowFn: () => now,
    })
    expect(start.expiresAtMs).toBe(now + 900_000)
  })

  it('throws on a rejected mint (the loopback-fallback trigger)', async () => {
    await expect(
      startOpenAiDeviceFlow({
        fetchImpl: stubFetch(jsonRes(403, { error: { message: 'device auth disabled' } })),
      }),
    ).rejects.toThrow(/rejected: HTTP 403/)
  })

  it('throws when the mint response is missing its ids', async () => {
    await expect(
      startOpenAiDeviceFlow({ fetchImpl: stubFetch(jsonRes(200, { interval: '5' })) }),
    ).rejects.toThrow(/missing device_auth_id or user_code/)
  })
})

describe('pollOpenAiDeviceTokenOnce', () => {
  const POLL_STATE = {
    deviceAuthId: 'deviceauth_abc123',
    userCode: 'YM3A-N8J3U',
    codeVerifier: 'verifier-verifier-verifier-verifier-verifier',
  }

  it('maps the live pending envelope (HTTP 403 + error.code) to pending', async () => {
    const outcome = await pollOpenAiDeviceTokenOnce(POLL_STATE, {
      fetchImpl: stubFetch(
        jsonRes(403, {
          error: {
            message: 'Device authorization is pending. Please try again.',
            type: 'invalid_request_error',
            code: 'deviceauth_authorization_pending',
          },
        }),
      ),
    })
    expect(outcome.status).toBe('pending')
  })

  it('accepts direct tokens on the poll response', async () => {
    const outcome = await pollOpenAiDeviceTokenOnce(POLL_STATE, {
      fetchImpl: stubFetch(
        jsonRes(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }),
      ),
    })
    expect(outcome.status).toBe('completed')
    if (outcome.status === 'completed') {
      expect(outcome.tokens.access_token).toBe('at-1')
      expect(outcome.tokens.refresh_token).toBe('rt-1')
    }
  })

  it('exchanges an authorization_code with the PKCE verifier bound at mint', async () => {
    let exchangeBody = ''
    const fetchImpl: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/deviceauth/token')) {
        return Promise.resolve(jsonRes(200, { authorization_code: 'code-xyz' }))
      }
      if (url.includes('openid-configuration')) {
        return Promise.resolve(jsonRes(200, LIVE_DISCOVERY))
      }
      if (url.includes('/api/accounts/oauth/token')) {
        exchangeBody = typeof init?.body === 'string' ? init.body : ''
        return Promise.resolve(jsonRes(200, { access_token: 'at-2', refresh_token: 'rt-2' }))
      }
      return Promise.resolve(new Response('not found', { status: 404 }))
    }
    const outcome = await pollOpenAiDeviceTokenOnce(POLL_STATE, { fetchImpl })
    expect(outcome.status).toBe('completed')
    const params = new URLSearchParams(exchangeBody)
    expect(params.get('grant_type')).toBe('authorization_code')
    expect(params.get('code')).toBe('code-xyz')
    expect(params.get('code_verifier')).toBe(POLL_STATE.codeVerifier)
    // Public client: no client_secret on the exchange.
    expect(params.get('client_secret')).toBeNull()
  })

  it('surfaces unknown terminal errors with the provider code + message', async () => {
    const outcome = await pollOpenAiDeviceTokenOnce(POLL_STATE, {
      fetchImpl: stubFetch(
        jsonRes(403, { error: { message: 'user declined', code: 'deviceauth_denied' } }),
      ),
    })
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') {
      expect(outcome.error).toBe('deviceauth_denied')
      expect(outcome.description).toBe('user declined')
    }
  })

  it('reports network blips as transient (caller keeps polling)', async () => {
    const fetchImpl: typeof fetch = () => Promise.reject(new Error('ECONNRESET'))
    const outcome = await pollOpenAiDeviceTokenOnce(POLL_STATE, { fetchImpl })
    expect(outcome.status).toBe('transient')
  })

  it('treats gateway blips (5xx/429/non-JSON) as transient, not terminal', async () => {
    // A user mid-approval on their phone must not have the whole flow
    // killed by one 502 from a proxy. Only a structured provider error
    // is a verdict on the sign-in.
    const responses = [
      new Response('<html>bad gateway</html>', { status: 502 }),
      new Response('<html>service unavailable</html>', { status: 503 }),
      jsonRes(429, {}),
    ]
    for (const res of responses) {
      const outcome = await pollOpenAiDeviceTokenOnce(POLL_STATE, { fetchImpl: stubFetch(res) })
      expect(outcome.status).toBe('transient')
    }
  })

  it('uses the routed poll URL from the wire config', async () => {
    let polledUrl = ''
    const fetchImpl: typeof fetch = (input) => {
      polledUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return Promise.resolve(jsonRes(200, { access_token: 'at', refresh_token: 'rt' }))
    }
    await pollOpenAiDeviceTokenOnce(POLL_STATE, { fetchImpl })
    expect(polledUrl).toBe(OPENAI_DEVICE_AUTH_WIRE.pollUrl)
  })
})

describe('JWT metadata reads', () => {
  it('extracts the ChatGPT account id from the auth claim', () => {
    const token = fakeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-42' },
      exp: 1_800_000_000,
    })
    expect(extractChatgptAccountId(token)).toBe('acct-42')
  })

  it('returns null for tokens without the claim (or non-JWT bearers)', () => {
    expect(extractChatgptAccountId(fakeJwt({ sub: 'user' }))).toBeNull()
    expect(extractChatgptAccountId('opaque-bearer-string')).toBeNull()
  })

  it('reads the exp claim as ms', () => {
    expect(accessTokenExpiryMs(fakeJwt({ exp: 1_800_000_000 }))).toBe(1_800_000_000_000)
    expect(accessTokenExpiryMs('opaque')).toBeNull()
  })
})
