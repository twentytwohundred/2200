import { describe, expect, it } from 'vitest'
import { runOAuthFlow } from '../../../src/runtime/oauth/flow.js'
import { startRedirectServer } from '../../../src/runtime/oauth/redirect-server.js'
import { OAuthError, type OAuthProviderConfig } from '../../../src/runtime/oauth/types.js'

const PROVIDER: OAuthProviderConfig = {
  name: 'fakeprov',
  authUrl: 'https://example.test/authorize',
  tokenUrl: 'https://example.test/token',
  defaultScopes: ['scope.a', 'scope.b'],
  extraAuthParams: { extra: 'one' },
}

describe('runOAuthFlow', () => {
  it('runs the full flow with a fake provider, returns parsed tokens', async () => {
    const captured: { authUrl?: URL; tokenBody?: URLSearchParams } = {}

    const fetchImpl: typeof fetch = (_input, init) => {
      const body = init?.body
      captured.tokenBody = new URLSearchParams(typeof body === 'string' ? body : '')
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: 'AT-xyz',
            refresh_token: 'RT-abc',
            expires_in: 3600,
            scope: 'scope.a scope.b',
            token_type: 'Bearer',
            fakeprov_team_id: 'T123',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
    }

    const openBrowser = (url: string): void => {
      const u = new URL(url)
      captured.authUrl = u
      const redirect = u.searchParams.get('redirect_uri') ?? ''
      const state = u.searchParams.get('state') ?? ''
      const cb = `${redirect}?code=callback-code&state=${encodeURIComponent(state)}`
      setTimeout(() => {
        void fetch(cb)
      }, 10)
    }

    const tokens = await runOAuthFlow({
      provider: PROVIDER,
      clientId: 'CID',
      clientSecret: 'CSECRET',
      port: 0,
      timeoutMs: 5000,
      fetchImpl,
      openBrowser,
      redirectServer: startRedirectServer,
    })

    expect(tokens.access_token).toBe('AT-xyz')
    expect(tokens.refresh_token).toBe('RT-abc')
    expect(tokens.expires_in).toBe(3600)
    expect(tokens.token_type).toBe('Bearer')
    expect(tokens.extras?.['fakeprov_team_id']).toBe('T123')

    expect(captured.authUrl).toBeDefined()
    expect(captured.authUrl?.searchParams.get('client_id')).toBe('CID')
    expect(captured.authUrl?.searchParams.get('response_type')).toBe('code')
    expect(captured.authUrl?.searchParams.get('extra')).toBe('one')
    expect(captured.authUrl?.searchParams.get('scope')).toBe('scope.a scope.b')
    expect(captured.authUrl?.searchParams.get('code_challenge_method')).toBe('S256')

    expect(captured.tokenBody?.get('grant_type')).toBe('authorization_code')
    expect(captured.tokenBody?.get('code')).toBe('callback-code')
    expect(captured.tokenBody?.get('client_id')).toBe('CID')
    expect(captured.tokenBody?.get('client_secret')).toBe('CSECRET')
    expect(captured.tokenBody?.get('code_verifier')?.length).toBeGreaterThanOrEqual(43)
  })

  it('rejects when state does not match', async () => {
    const fetchImpl: typeof fetch = () => Promise.resolve(new Response('{}', { status: 200 }))
    const openBrowser = (url: string): void => {
      const u = new URL(url)
      const redirect = u.searchParams.get('redirect_uri') ?? ''
      const cb = `${redirect}?code=anything&state=wrongstate`
      setTimeout(() => {
        void fetch(cb)
      }, 10)
    }

    const err = await runOAuthFlow({
      provider: PROVIDER,
      clientId: 'CID',
      clientSecret: 'CSECRET',
      port: 0,
      timeoutMs: 5000,
      fetchImpl,
      openBrowser,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OAuthError)
    expect((err as OAuthError).code).toBe('STATE_MISMATCH')
  })

  it('rejects when token endpoint returns non-2xx', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      )
    const openBrowser = (url: string): void => {
      const u = new URL(url)
      const redirect = u.searchParams.get('redirect_uri') ?? ''
      const state = u.searchParams.get('state') ?? ''
      const cb = `${redirect}?code=anycode&state=${encodeURIComponent(state)}`
      setTimeout(() => {
        void fetch(cb)
      }, 10)
    }

    const err = await runOAuthFlow({
      provider: PROVIDER,
      clientId: 'CID',
      clientSecret: 'CSECRET',
      port: 0,
      timeoutMs: 5000,
      fetchImpl,
      openBrowser,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OAuthError)
    expect((err as OAuthError).code).toBe('TOKEN_EXCHANGE_FAILED')
  })

  it('rejects when token endpoint returns invalid JSON', async () => {
    const fetchImpl: typeof fetch = () => Promise.resolve(new Response('not-json', { status: 200 }))
    const openBrowser = (url: string): void => {
      const u = new URL(url)
      const redirect = u.searchParams.get('redirect_uri') ?? ''
      const state = u.searchParams.get('state') ?? ''
      setTimeout(() => {
        void fetch(`${redirect}?code=anycode&state=${encodeURIComponent(state)}`)
      }, 10)
    }
    const err = await runOAuthFlow({
      provider: PROVIDER,
      clientId: 'CID',
      clientSecret: 'CSECRET',
      port: 0,
      timeoutMs: 5000,
      fetchImpl,
      openBrowser,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OAuthError)
    expect((err as OAuthError).code).toBe('INVALID_RESPONSE')
  })
})
