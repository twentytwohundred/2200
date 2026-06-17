/**
 * Tests for resolveFleetDefaults ... the single fleet model/credential source.
 *
 * Uses the real sealed OAuth token store (saveOAuthToken) against a temp home
 * so the encrypt/decrypt + expiry path is exercised, not mocked.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveFleetDefaults } from '../../../src/runtime/config/fleet-defaults.js'
import { saveOAuthToken } from '../../../src/runtime/oauth/token-store.js'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-fleet-defaults-'))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

async function seedToken(bearer: string, expiresInMs: number): Promise<void> {
  await saveOAuthToken(home, {
    provider: 'xai-oauth',
    bearer,
    refreshToken: 'refresh-tok',
    metadata: {
      granted_scopes: ['openid', 'api:access'],
      expires_at_ms: Date.now() + expiresInMs,
      created_at: new Date().toISOString(),
    },
  })
}

describe('resolveFleetDefaults', () => {
  it('is inactive with null pub LLM when no subscription token exists', async () => {
    const fd = await resolveFleetDefaults(home)
    expect(fd.subscriptionActive).toBe(false)
    expect(fd.pubServerLlm).toBeNull()
  })

  it('is inactive when the subscription token is expired', async () => {
    await seedToken('expired', -1_000)
    const fd = await resolveFleetDefaults(home)
    expect(fd.subscriptionActive).toBe(false)
    expect(fd.pubServerLlm).toBeNull()
  })

  it('wires the pub-server LLM from an active subscription', async () => {
    await seedToken('live-bearer-xyz', 3_600_000)
    const fd = await resolveFleetDefaults(home)
    expect(fd.subscriptionActive).toBe(true)
    expect(fd.pubServerLlm).not.toBeNull()
    // OpenAI-compatible adapter, api.x.ai base, the LIVE bearer, and the model
    // id resolved from the catalog (NOT an inline literal in the resolver).
    expect(fd.pubServerLlm?.provider).toBe('openai')
    expect(fd.pubServerLlm?.baseUrl).toBe('https://api.x.ai')
    expect(fd.pubServerLlm?.apiKey).toBe('live-bearer-xyz')
    expect(fd.pubServerLlm?.model).toBe('grok-4.3')
  })
})
