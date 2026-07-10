/**
 * Tests for the subscription-OAuth provider registry: lookups, the
 * fleet-store activity helpers the onboarding pick + providers DTO
 * consume, the single token-persist path, and the shared blocking
 * device-flow driver. The registry is the seam that makes a second
 * (or third) subscription provider a data entry instead of a fork of
 * six call sites ... these tests pin that contract.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  activeSubscriptionLlmProviders,
  hasActiveSubscription,
  runSubscriptionDeviceFlow,
  saveSubscriptionTokens,
  SUBSCRIPTION_OAUTH_PROVIDERS,
  subscriptionProviderByLlmName,
  subscriptionProviderByRoute,
  subscriptionProviderBySlug,
  type SubscriptionOAuthProviderDef,
} from '../../../src/runtime/oauth/subscription-providers.js'
import { readOAuthToken, saveOAuthToken } from '../../../src/runtime/oauth/token-store.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-subscription-providers-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function fakeJwt(payload: Record<string, unknown>): string {
  const enc = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${enc({ alg: 'RS256' })}.${enc(payload)}.sig`
}

describe('registry lookups', () => {
  it('registers both providers, xAI first (display order)', () => {
    expect(SUBSCRIPTION_OAUTH_PROVIDERS.map((d) => d.slug)).toEqual(['xai-oauth', 'openai-oauth'])
  })

  it('looks up by slug, route, and llm provider name', () => {
    expect(subscriptionProviderBySlug('openai-oauth')?.llmProvider).toBe('openai-subscription')
    expect(subscriptionProviderByRoute('xai')?.slug).toBe('xai-oauth')
    expect(subscriptionProviderByLlmName('openai-subscription')?.route).toBe('openai')
    expect(subscriptionProviderBySlug('nope')).toBeUndefined()
    expect(subscriptionProviderByRoute('nope')).toBeUndefined()
    expect(subscriptionProviderByLlmName('xai')).toBeUndefined()
  })

  it('only OpenAI declares a loopback fallback (xAI never gates device-code)', () => {
    expect(subscriptionProviderBySlug('xai-oauth')?.loopback).toBeUndefined()
    const loopback = subscriptionProviderBySlug('openai-oauth')?.loopback
    expect(loopback?.redirect).toEqual({
      port: 1455,
      path: '/auth/callback',
      urlHostname: 'localhost',
    })
  })

  it('xAI aliases its picker models to the API-key pricing namespace; OpenAI does not', () => {
    expect(subscriptionProviderBySlug('xai-oauth')?.modelsPricingAlias).toBe('xai')
    expect(subscriptionProviderBySlug('openai-oauth')?.modelsPricingAlias).toBeUndefined()
  })
})

describe('fleet-store activity helpers', () => {
  it('reports active subscriptions per provider, not as one blanket boolean', async () => {
    await saveOAuthToken(home, {
      provider: 'openai-oauth',
      bearer: 'bearer',
      refreshToken: 'refresh',
      metadata: {
        granted_scopes: ['openid'],
        expires_at_ms: Date.now() + 3600_000,
        created_at: new Date().toISOString(),
      },
    })
    expect(await hasActiveSubscription(home, 'openai-oauth')).toBe(true)
    expect(await hasActiveSubscription(home, 'xai-oauth')).toBe(false)
    const active = await activeSubscriptionLlmProviders(home)
    expect(active.has('openai-subscription')).toBe(true)
    expect(active.has('xai-subscription')).toBe(false)
  })

  it('an expired token is not active', async () => {
    await saveOAuthToken(home, {
      provider: 'xai-oauth',
      bearer: 'bearer',
      refreshToken: 'refresh',
      metadata: {
        granted_scopes: [],
        expires_at_ms: Date.now() - 1000,
        created_at: new Date().toISOString(),
      },
    })
    expect(await hasActiveSubscription(home, 'xai-oauth')).toBe(false)
    expect((await activeSubscriptionLlmProviders(home)).size).toBe(0)
  })
})

describe('saveSubscriptionTokens', () => {
  it('rejects a token response without a refresh token (background refresh would be dead)', async () => {
    const def = subscriptionProviderBySlug('xai-oauth')
    if (!def) throw new Error('xai def missing')
    await expect(saveSubscriptionTokens(home, def, { access_token: 'at' })).rejects.toThrow(
      /refresh token/,
    )
  })

  it('persists the ChatGPT account id as metadata.subject (openai def)', async () => {
    const def = subscriptionProviderBySlug('openai-oauth')
    if (!def) throw new Error('openai def missing')
    const bearer = fakeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-99' },
      exp: Math.floor(Date.now() / 1000) + 86_400,
    })
    await saveSubscriptionTokens(home, def, {
      access_token: bearer,
      refresh_token: 'rt',
      scope: 'openid profile',
    })
    const stored = await readOAuthToken(home, 'openai-oauth')
    expect(stored?.metadata.subject).toBe('acct-99')
    expect(stored?.metadata.granted_scopes).toEqual(['openid', 'profile'])
  })

  it('derives openai expiry from the JWT exp claim when expires_in is absent', async () => {
    const def = subscriptionProviderBySlug('openai-oauth')
    if (!def) throw new Error('openai def missing')
    const exp = Math.floor(Date.now() / 1000) + 86_400
    await saveSubscriptionTokens(home, def, {
      access_token: fakeJwt({ exp }),
      refresh_token: 'rt',
    })
    const stored = await readOAuthToken(home, 'openai-oauth')
    expect(stored?.metadata.expires_at_ms).toBe(exp * 1000)
  })

  it('falls back to expires_in (xai def, non-JWT bearer)', async () => {
    const def = subscriptionProviderBySlug('xai-oauth')
    if (!def) throw new Error('xai def missing')
    const before = Date.now()
    await saveSubscriptionTokens(home, def, {
      access_token: 'opaque',
      refresh_token: 'rt',
      expires_in: 3600,
    })
    const stored = await readOAuthToken(home, 'xai-oauth')
    expect(stored?.metadata.expires_at_ms).toBeGreaterThanOrEqual(before + 3600_000)
  })
})

describe('runSubscriptionDeviceFlow', () => {
  /** A scripted def: start immediately, then emit the queued outcomes. */
  function scriptedDef(
    outcomes: Awaited<ReturnType<SubscriptionOAuthProviderDef['pollDeviceFlowOnce']>>[],
  ): SubscriptionOAuthProviderDef {
    const queue = [...outcomes]
    return {
      slug: 'test-oauth',
      llmProvider: 'test-subscription',
      route: 'test',
      label: 'Test',
      shortLabel: 'Test',
      signInCta: 'Sign in with Test',
      signInCommand: '2200 oauth test login',
      consentNote: 'note',
      refreshSkewSeconds: 120,
      startDeviceFlow: () =>
        Promise.resolve({
          userCode: 'CODE-1',
          verificationUri: 'https://test.example/device',
          expiresAtMs: Date.now() + 600_000,
          intervalSec: 5,
          pollState: { k: 'v' },
        }),
      pollDeviceFlowOnce: () => {
        const next = queue.shift()
        if (!next) throw new Error('poll called past script end')
        return Promise.resolve(next)
      },
      refreshTokens: () => Promise.reject(new Error('not under test')),
      tokenExpiresAtMs: (t, now) => now + (t.expires_in ?? 3600) * 1000,
    }
  }

  const noSleep = (): Promise<void> => Promise.resolve()

  it('polls through pending/transient to completion and surfaces the prompt', async () => {
    const def = scriptedDef([
      { status: 'pending' },
      { status: 'transient', message: 'blip' },
      { status: 'completed', tokens: { access_token: 'at', refresh_token: 'rt' } },
    ])
    let prompted = ''
    const tokens = await runSubscriptionDeviceFlow(def, {
      onPrompt: (p) => {
        prompted = p.userCode
      },
      sleepFn: noSleep,
    })
    expect(prompted).toBe('CODE-1')
    expect(tokens.access_token).toBe('at')
  })

  it('bumps the interval on slow_down and keeps going', async () => {
    const def = scriptedDef([
      { status: 'slow_down' },
      { status: 'completed', tokens: { access_token: 'at' } },
    ])
    const sleeps: number[] = []
    await runSubscriptionDeviceFlow(def, {
      onPrompt: () => undefined,
      sleepFn: (ms) => {
        sleeps.push(ms)
        return Promise.resolve()
      },
    })
    // Initial 5s wait, then the post-slow_down 10s wait.
    expect(sleeps).toEqual([5000, 10_000])
  })

  it('maps terminal provider errors onto the OAuthError vocabulary', async () => {
    await expect(
      runSubscriptionDeviceFlow(scriptedDef([{ status: 'failed', error: 'access_denied' }]), {
        onPrompt: () => undefined,
        sleepFn: noSleep,
      }),
    ).rejects.toThrow(/denied access/)
    await expect(
      runSubscriptionDeviceFlow(scriptedDef([{ status: 'failed', error: 'expired_token' }]), {
        onPrompt: () => undefined,
        sleepFn: noSleep,
      }),
    ).rejects.toThrow(/expired/)
  })

  it('times out at the deadline instead of polling forever', async () => {
    let now = 1_000_000
    const def = scriptedDef(Array.from({ length: 50 }, () => ({ status: 'pending' as const })))
    await expect(
      runSubscriptionDeviceFlow(def, {
        onPrompt: () => undefined,
        timeoutSeconds: 30,
        nowFn: () => now,
        sleepFn: () => {
          now += 10_000
          return Promise.resolve()
        },
      }),
    ).rejects.toThrow(/timed out/)
  })
})
