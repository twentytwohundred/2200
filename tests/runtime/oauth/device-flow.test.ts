/**
 * Tests for the RFC 8628 device-code flow runner.
 *
 * The runner is pure I/O: takes a config, returns a token. Tests
 * drive it with a stub `fetch` so we can simulate every branch of
 * the protocol (authorization_pending, slow_down, expired_token,
 * access_denied, success) without standing up a real OAuth server.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  refreshDeviceFlowToken,
  runDeviceFlow,
  type DeviceFlowProviderConfig,
} from '../../../src/runtime/oauth/device-flow.js'
import { OAuthError } from '../../../src/runtime/oauth/types.js'

/** Placeholder onPrompt; lint forbids `() => {}` empty arrows. */
const noop = (): void => {
  /* test fixture: no prompt-side I/O */
}

function makeProvider(): DeviceFlowProviderConfig {
  return {
    name: 'test',
    deviceAuthorizationUrl: 'https://issuer.test/device/code',
    tokenUrl: 'https://issuer.test/token',
    clientId: 'public-client-id',
    scopes: ['openid', 'offline_access', 'api:access'],
  }
}

/** Fake fetch that returns a queue of responses for each URL. */
function makeStubFetch(scripts: Record<string, (() => Response)[]>): typeof fetch {
  const counters = new Map<string, number>()
  return (input, _init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const next = counters.get(url) ?? 0
    const script = scripts[url]
    if (!script || next >= script.length) {
      throw new Error(`unexpected fetch to ${url} (call #${String(next + 1)})`)
    }
    counters.set(url, next + 1)
    return Promise.resolve(script[next]!())
  }
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('runDeviceFlow', () => {
  it('completes the happy path: device-auth → polled approval → token', async () => {
    const provider = makeProvider()
    const fetchImpl = makeStubFetch({
      'https://issuer.test/device/code': [
        () =>
          jsonRes(200, {
            device_code: 'D-1234',
            user_code: 'WBQX-MKHV',
            verification_uri: 'https://issuer.test/device',
            verification_uri_complete: 'https://issuer.test/device?code=WBQX-MKHV',
            expires_in: 600,
            interval: 5,
          }),
      ],
      'https://issuer.test/token': [
        () => jsonRes(400, { error: 'authorization_pending' }),
        () => jsonRes(400, { error: 'authorization_pending' }),
        () =>
          jsonRes(200, {
            access_token: 'bearer-abc',
            refresh_token: 'refresh-xyz',
            expires_in: 3600,
            scope: 'openid offline_access api:access',
            token_type: 'Bearer',
          }),
      ],
    })

    const prompts: { userCode: string; verificationUri: string }[] = []
    const tokens = await runDeviceFlow({
      provider,
      fetchImpl,
      onPrompt: (p) => {
        prompts.push({ userCode: p.userCode, verificationUri: p.verificationUri })
      },
      // No real sleeping in unit tests: jump time forward instantly.
      sleepFn: () => Promise.resolve(),
    })

    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.userCode).toBe('WBQX-MKHV')
    expect(prompts[0]?.verificationUri).toBe('https://issuer.test/device')
    expect(tokens.access_token).toBe('bearer-abc')
    expect(tokens.refresh_token).toBe('refresh-xyz')
  })

  it('honors slow_down by bumping the polling interval', async () => {
    // Side-effect counter: count how many distinct sleeps happen so
    // we can confirm slow_down's +5s bump is applied.
    const sleepDurations: number[] = []
    const provider = makeProvider()
    const fetchImpl = makeStubFetch({
      'https://issuer.test/device/code': [
        () =>
          jsonRes(200, {
            device_code: 'D-1',
            user_code: 'C-1',
            verification_uri: 'https://issuer.test/d',
            expires_in: 600,
            interval: 5,
          }),
      ],
      'https://issuer.test/token': [
        () => jsonRes(400, { error: 'slow_down' }),
        () => jsonRes(200, { access_token: 'ok', refresh_token: 'r', expires_in: 3600 }),
      ],
    })

    const tokens = await runDeviceFlow({
      provider,
      fetchImpl,
      onPrompt: noop,
      sleepFn: (ms) => {
        sleepDurations.push(ms)
        return Promise.resolve()
      },
    })
    expect(tokens.access_token).toBe('ok')
    // initial 5s wait (5000ms) then slow_down → bumps to 10s (10000ms).
    expect(sleepDurations).toEqual([5000, 10_000])
  })

  it('throws PROVIDER_DENIED on access_denied', async () => {
    const provider = makeProvider()
    const fetchImpl = makeStubFetch({
      'https://issuer.test/device/code': [
        () =>
          jsonRes(200, {
            device_code: 'D',
            user_code: 'C',
            verification_uri: 'https://issuer.test/d',
            expires_in: 600,
            interval: 5,
          }),
      ],
      'https://issuer.test/token': [() => jsonRes(400, { error: 'access_denied' })],
    })

    await expect(
      runDeviceFlow({ provider, fetchImpl, onPrompt: noop, sleepFn: () => Promise.resolve() }),
    ).rejects.toMatchObject({ code: 'PROVIDER_DENIED' })
  })

  it('throws CALLBACK_TIMEOUT on expired_token', async () => {
    const provider = makeProvider()
    const fetchImpl = makeStubFetch({
      'https://issuer.test/device/code': [
        () =>
          jsonRes(200, {
            device_code: 'D',
            user_code: 'C',
            verification_uri: 'https://issuer.test/d',
            expires_in: 600,
            interval: 5,
          }),
      ],
      'https://issuer.test/token': [() => jsonRes(400, { error: 'expired_token' })],
    })
    await expect(
      runDeviceFlow({ provider, fetchImpl, onPrompt: noop, sleepFn: () => Promise.resolve() }),
    ).rejects.toMatchObject({ code: 'CALLBACK_TIMEOUT' })
  })

  it('throws TOKEN_EXCHANGE_FAILED on a hard provider error', async () => {
    const provider = makeProvider()
    const fetchImpl = makeStubFetch({
      'https://issuer.test/device/code': [
        () =>
          jsonRes(200, {
            device_code: 'D',
            user_code: 'C',
            verification_uri: 'https://issuer.test/d',
            expires_in: 600,
            interval: 5,
          }),
      ],
      'https://issuer.test/token': [
        () => jsonRes(400, { error: 'invalid_grant', error_description: 'mismatched code' }),
      ],
    })
    await expect(
      runDeviceFlow({ provider, fetchImpl, onPrompt: noop, sleepFn: () => Promise.resolve() }),
    ).rejects.toMatchObject({ code: 'TOKEN_EXCHANGE_FAILED' })
  })

  it('throws TOKEN_EXCHANGE_FAILED if device-auth endpoint returns non-2xx', async () => {
    // Regression guard for the failure mode where we silently dropped
    // a 4xx and started polling /token against garbage state.
    const provider = makeProvider()
    const fetchImpl = makeStubFetch({
      'https://issuer.test/device/code': [() => jsonRes(400, { error: 'invalid_request' })],
      'https://issuer.test/token': [],
    })
    await expect(
      runDeviceFlow({ provider, fetchImpl, onPrompt: noop, sleepFn: () => Promise.resolve() }),
    ).rejects.toBeInstanceOf(OAuthError)
  })
})

describe('refreshDeviceFlowToken', () => {
  it('returns the new access + (rotated) refresh token on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes(200, {
        access_token: 'new-bearer',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        scope: 'openid offline_access api:access',
      }),
    ) as unknown as typeof fetch
    const tokens = await refreshDeviceFlowToken({
      provider: { tokenUrl: 'https://issuer.test/token', clientId: 'cid' },
      refreshToken: 'old-refresh',
      fetchImpl,
    })
    expect(tokens.access_token).toBe('new-bearer')
    expect(tokens.refresh_token).toBe('new-refresh')
  })

  it('throws TOKEN_EXCHANGE_FAILED on invalid_grant (revoked refresh)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonRes(400, { error: 'invalid_grant', error_description: 'refresh revoked' }),
      ) as unknown as typeof fetch
    await expect(
      refreshDeviceFlowToken({
        provider: { tokenUrl: 'https://issuer.test/token', clientId: 'cid' },
        refreshToken: 'old',
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'TOKEN_EXCHANGE_FAILED' })
  })
})
