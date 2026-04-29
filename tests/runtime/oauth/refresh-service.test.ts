import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CredentialVault } from '../../../src/runtime/credentials/vault.js'
import { TokenRefreshService } from '../../../src/runtime/oauth/refresh-service.js'

let home: string
const ENV_ID = '_2200_OAUTH_GOOGLE_CLIENT_ID'
const ENV_SECRET = '_2200_OAUTH_GOOGLE_CLIENT_SECRET'

function clearOAuthEnv(): void {
  Reflect.deleteProperty(process.env, ENV_ID)
  Reflect.deleteProperty(process.env, ENV_SECRET)
}

async function createAgentDir(name: string): Promise<void> {
  await mkdir(join(home, 'agents', name), { recursive: true })
}

async function seedOAuthPair(opts: {
  agent: string
  name: string
  accessExpiresAt: string
  refreshValue: string
  scopes?: string[]
}): Promise<void> {
  const vault = new CredentialVault(home, opts.agent)
  await vault.set(opts.name, {
    value: 'AT-old',
    metadata: {
      created_at: '2026-04-29T19:00:00.000Z',
      provider: 'google',
      scopes: opts.scopes ?? ['https://www.googleapis.com/auth/calendar'],
      expires_at: opts.accessExpiresAt,
      notes: 'oauth access_token',
    },
  })
  await vault.set(`${opts.name}-refresh`, {
    value: opts.refreshValue,
    metadata: {
      created_at: '2026-04-29T19:00:00.000Z',
      provider: 'google',
      scopes: opts.scopes ?? ['https://www.googleapis.com/auth/calendar'],
      notes: 'oauth refresh_token',
    },
  })
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-refresh-'))
  clearOAuthEnv()
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  clearOAuthEnv()
})

describe('TokenRefreshService', () => {
  it('refreshes access tokens within the refresh window', async () => {
    process.env[ENV_ID] = 'CID'
    process.env[ENV_SECRET] = 'CSECRET'
    await createAgentDir('hobby')
    const now = new Date('2026-04-29T20:00:00.000Z')
    // Expires in 2 minutes (within default 5-min window).
    const expiresAt = new Date(now.getTime() + 2 * 60_000).toISOString()
    await seedOAuthPair({
      agent: 'hobby',
      name: 'google-default',
      accessExpiresAt: expiresAt,
      refreshValue: 'RT-1',
    })

    let calls = 0
    const fetchImpl: typeof fetch = () => {
      calls++
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

    const service = new TokenRefreshService({
      home,
      now: () => now,
      fetchImpl,
    })
    const stats = await service.tick()
    expect(stats.scanned).toBe(1)
    expect(stats.refreshed).toBe(1)
    expect(stats.failed).toBe(0)
    expect(calls).toBe(1)

    const vault = new CredentialVault(home, 'hobby')
    const access = await vault.get('google-default')
    expect(access.value).toBe('AT-new')
    expect(access.metadata.notes).toBe('oauth access_token (auto-refreshed)')
  })

  it('skips entries outside the refresh window', async () => {
    process.env[ENV_ID] = 'CID'
    process.env[ENV_SECRET] = 'CSECRET'
    await createAgentDir('hobby')
    const now = new Date('2026-04-29T20:00:00.000Z')
    const expiresAt = new Date(now.getTime() + 60 * 60_000).toISOString()
    await seedOAuthPair({
      agent: 'hobby',
      name: 'google-default',
      accessExpiresAt: expiresAt,
      refreshValue: 'RT-1',
    })

    let calls = 0
    const fetchImpl: typeof fetch = () => {
      calls++
      return Promise.resolve(new Response('{}', { status: 200 }))
    }
    const service = new TokenRefreshService({
      home,
      now: () => now,
      fetchImpl,
    })
    const stats = await service.tick()
    expect(stats.scanned).toBe(1)
    expect(stats.skipped).toBe(1)
    expect(stats.refreshed).toBe(0)
    expect(calls).toBe(0)
  })

  it('skips entries with no companion refresh', async () => {
    process.env[ENV_ID] = 'CID'
    process.env[ENV_SECRET] = 'CSECRET'
    await createAgentDir('hobby')
    const vault = new CredentialVault(home, 'hobby')
    const now = new Date('2026-04-29T20:00:00.000Z')
    await vault.set('google-default', {
      value: 'AT',
      metadata: {
        created_at: now.toISOString(),
        provider: 'google',
        scopes: ['x'],
        expires_at: new Date(now.getTime() + 60_000).toISOString(),
        notes: 'access_token (no refresh)',
      },
    })
    let calls = 0
    const fetchImpl: typeof fetch = () => {
      calls++
      return Promise.resolve(new Response('{}', { status: 200 }))
    }
    const service = new TokenRefreshService({ home, now: () => now, fetchImpl })
    const stats = await service.tick()
    expect(stats.scanned).toBe(1)
    expect(stats.skipped).toBe(1)
    expect(calls).toBe(0)
  })

  it('rotates the refresh_token when the provider returns a new one', async () => {
    process.env[ENV_ID] = 'CID'
    process.env[ENV_SECRET] = 'CSECRET'
    await createAgentDir('hobby')
    const now = new Date('2026-04-29T20:00:00.000Z')
    const expiresAt = new Date(now.getTime() + 60_000).toISOString()
    await seedOAuthPair({
      agent: 'hobby',
      name: 'google-default',
      accessExpiresAt: expiresAt,
      refreshValue: 'RT-old',
    })

    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: 'AT-new',
            refresh_token: 'RT-rotated',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )

    const service = new TokenRefreshService({ home, now: () => now, fetchImpl })
    await service.tick()

    const vault = new CredentialVault(home, 'hobby')
    const refresh = await vault.get('google-default-refresh')
    expect(refresh.value).toBe('RT-rotated')
    expect(refresh.metadata.notes).toContain('auto-rotated')
  })

  it('honors failure cooldown between ticks', async () => {
    process.env[ENV_ID] = 'CID'
    process.env[ENV_SECRET] = 'CSECRET'
    await createAgentDir('hobby')
    const now = new Date('2026-04-29T20:00:00.000Z')
    const expiresAt = new Date(now.getTime() + 60_000).toISOString()
    await seedOAuthPair({
      agent: 'hobby',
      name: 'google-default',
      accessExpiresAt: expiresAt,
      refreshValue: 'RT-1',
    })

    let calls = 0
    const fetchImpl: typeof fetch = () => {
      calls++
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }

    let cur = now
    const service = new TokenRefreshService({
      home,
      now: () => cur,
      fetchImpl,
      failureCooldownMs: 60_000,
    })
    const s1 = await service.tick()
    expect(s1.failed).toBe(1)
    expect(calls).toBe(1)

    // Second tick at +30s should be skipped (within cooldown).
    cur = new Date(now.getTime() + 30_000)
    const s2 = await service.tick()
    expect(s2.skipped).toBe(1)
    expect(s2.failed).toBe(0)
    expect(calls).toBe(1)

    // Third tick at +90s should retry (past cooldown).
    cur = new Date(now.getTime() + 90_000)
    const s3 = await service.tick()
    expect(s3.failed).toBe(1)
    expect(calls).toBe(2)
  })

  it('does not refresh when client credentials are missing', async () => {
    // env vars unset.
    await createAgentDir('hobby')
    const now = new Date('2026-04-29T20:00:00.000Z')
    const expiresAt = new Date(now.getTime() + 60_000).toISOString()
    await seedOAuthPair({
      agent: 'hobby',
      name: 'google-default',
      accessExpiresAt: expiresAt,
      refreshValue: 'RT-1',
    })
    let calls = 0
    const fetchImpl: typeof fetch = () => {
      calls++
      return Promise.resolve(new Response('{}', { status: 200 }))
    }
    const service = new TokenRefreshService({ home, now: () => now, fetchImpl })
    const stats = await service.tick()
    expect(stats.failed).toBe(1)
    expect(calls).toBe(0)
  })

  it('skips entries with provider not in the registry', async () => {
    process.env[ENV_ID] = 'CID'
    process.env[ENV_SECRET] = 'CSECRET'
    await createAgentDir('hobby')
    const vault = new CredentialVault(home, 'hobby')
    const now = new Date('2026-04-29T20:00:00.000Z')
    await vault.set('weird', {
      value: 'AT',
      metadata: {
        created_at: now.toISOString(),
        provider: 'made-up-provider',
        scopes: ['x'],
        expires_at: new Date(now.getTime() + 60_000).toISOString(),
      },
    })
    await vault.set('weird-refresh', {
      value: 'RT',
      metadata: {
        created_at: now.toISOString(),
        provider: 'made-up-provider',
      },
    })
    const fetchImpl: typeof fetch = () => Promise.resolve(new Response('{}', { status: 200 }))
    const service = new TokenRefreshService({ home, now: () => now, fetchImpl })
    const stats = await service.tick()
    expect(stats.failed).toBe(1)
  })
})
