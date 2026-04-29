import { describe, expect, it } from 'vitest'
import { refreshAccessToken } from '../../../src/runtime/oauth/refresh.js'
import { OAuthError, type OAuthProviderConfig } from '../../../src/runtime/oauth/types.js'

const PROVIDER: OAuthProviderConfig = {
  name: 'fakeprov',
  authUrl: 'https://example.test/authorize',
  tokenUrl: 'https://example.test/token',
  defaultScopes: ['scope.a'],
}

describe('refreshAccessToken', () => {
  it('POSTs grant_type=refresh_token with refresh_token + client creds', async () => {
    let capturedBody: URLSearchParams | null = null
    const fetchImpl: typeof fetch = (_input, init) => {
      const body = init?.body
      capturedBody = new URLSearchParams(typeof body === 'string' ? body : '')
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: 'AT-new',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
    }
    const tokens = await refreshAccessToken({
      provider: PROVIDER,
      refreshToken: 'RT-old',
      clientId: 'CID',
      clientSecret: 'CSECRET',
      fetchImpl,
    })
    expect(tokens.access_token).toBe('AT-new')
    expect(tokens.expires_in).toBe(3600)
    expect(capturedBody).not.toBeNull()
    const body = capturedBody as unknown as URLSearchParams
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('RT-old')
    expect(body.get('client_id')).toBe('CID')
    expect(body.get('client_secret')).toBe('CSECRET')
  })

  it('returns the rotated refresh_token when present in the response', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: 'AT-2',
            refresh_token: 'RT-new',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
    const tokens = await refreshAccessToken({
      provider: PROVIDER,
      refreshToken: 'RT-1',
      clientId: 'CID',
      clientSecret: 'CSECRET',
      fetchImpl,
    })
    expect(tokens.refresh_token).toBe('RT-new')
  })

  it('throws TOKEN_EXCHANGE_FAILED on non-2xx', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      )
    const err = await refreshAccessToken({
      provider: PROVIDER,
      refreshToken: 'RT-old',
      clientId: 'CID',
      clientSecret: 'CSECRET',
      fetchImpl,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OAuthError)
    expect((err as OAuthError).code).toBe('TOKEN_EXCHANGE_FAILED')
  })

  it('throws INVALID_RESPONSE on non-JSON body', async () => {
    const fetchImpl: typeof fetch = () => Promise.resolve(new Response('not-json', { status: 200 }))
    const err = await refreshAccessToken({
      provider: PROVIDER,
      refreshToken: 'RT-old',
      clientId: 'CID',
      clientSecret: 'CSECRET',
      fetchImpl,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OAuthError)
    expect((err as OAuthError).code).toBe('INVALID_RESPONSE')
  })

  it('throws INVALID_RESPONSE when access_token is missing', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ refresh_token: 'RT' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    const err = await refreshAccessToken({
      provider: PROVIDER,
      refreshToken: 'RT-old',
      clientId: 'CID',
      clientSecret: 'CSECRET',
      fetchImpl,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OAuthError)
    expect((err as OAuthError).code).toBe('INVALID_RESPONSE')
  })
})
