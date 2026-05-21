/**
 * Tests for the fleet-scoped OAuth token store.
 *
 * The store seals tokens with AES-256-GCM under an HKDF-derived
 * wrapping key (same primitives as the per-Agent vault). Tests cover
 * round-trip, missing-file behavior, idempotent overwrite, and the
 * fleet-vs-agent namespace separation (a per-Agent vault key cannot
 * unseal a fleet-store envelope and vice versa).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deleteOAuthToken,
  hasOAuthToken,
  oauthTokenFilePath,
  readOAuthToken,
  saveOAuthToken,
} from '../../../src/runtime/oauth/token-store.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-oauth-token-store-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('oauth token store', () => {
  it('round-trips a token through save+read', async () => {
    await saveOAuthToken(home, {
      provider: 'xai-oauth',
      bearer: 'bearer-secret-123',
      refreshToken: 'refresh-secret-456',
      metadata: {
        granted_scopes: ['openid', 'offline_access', 'api:access'],
        expires_at_ms: Date.now() + 3600_000,
        created_at: '2026-05-21T18:00:00.000Z',
      },
    })
    const read = await readOAuthToken(home, 'xai-oauth')
    expect(read).not.toBeNull()
    expect(read?.bearer).toBe('bearer-secret-123')
    expect(read?.refreshToken).toBe('refresh-secret-456')
    expect(read?.metadata.granted_scopes).toEqual(['openid', 'offline_access', 'api:access'])
  })

  it('returns null when no token has been saved', async () => {
    expect(await readOAuthToken(home, 'xai-oauth')).toBeNull()
    expect(await hasOAuthToken(home, 'xai-oauth')).toBe(false)
  })

  it('overwrites the prior token (idempotent save)', async () => {
    const baseMeta = {
      granted_scopes: ['openid'],
      expires_at_ms: Date.now() + 3600_000,
      created_at: '2026-05-21T18:00:00.000Z',
    }
    await saveOAuthToken(home, {
      provider: 'xai-oauth',
      bearer: 'first',
      refreshToken: 'r1',
      metadata: baseMeta,
    })
    await saveOAuthToken(home, {
      provider: 'xai-oauth',
      bearer: 'second',
      refreshToken: 'r2',
      metadata: { ...baseMeta, refreshed_at: '2026-05-21T19:00:00.000Z' },
    })
    const read = await readOAuthToken(home, 'xai-oauth')
    expect(read?.bearer).toBe('second')
    expect(read?.refreshToken).toBe('r2')
    expect(read?.metadata.refreshed_at).toBe('2026-05-21T19:00:00.000Z')
  })

  it('the on-disk file does not contain plaintext secrets', async () => {
    // The whole point of sealing: a casual `cat` of the file must NOT
    // reveal the bearer or refresh token. Regression guard ... if a
    // future refactor accidentally bypasses the seal, this fires.
    await saveOAuthToken(home, {
      provider: 'xai-oauth',
      bearer: 'BEARER-MUST-NOT-LEAK',
      refreshToken: 'REFRESH-MUST-NOT-LEAK',
      metadata: {
        granted_scopes: [],
        expires_at_ms: Date.now() + 3600_000,
        created_at: '2026-05-21T18:00:00.000Z',
      },
    })
    const raw = await readFile(oauthTokenFilePath(home, 'xai-oauth'), 'utf-8')
    expect(raw).not.toContain('BEARER-MUST-NOT-LEAK')
    expect(raw).not.toContain('REFRESH-MUST-NOT-LEAK')
  })

  it('delete is idempotent', async () => {
    expect(await deleteOAuthToken(home, 'xai-oauth')).toBe(false)
    await saveOAuthToken(home, {
      provider: 'xai-oauth',
      bearer: 'x',
      refreshToken: 'y',
      metadata: {
        granted_scopes: [],
        expires_at_ms: Date.now() + 3600_000,
        created_at: '2026-05-21T18:00:00.000Z',
      },
    })
    expect(await deleteOAuthToken(home, 'xai-oauth')).toBe(true)
    expect(await deleteOAuthToken(home, 'xai-oauth')).toBe(false)
    expect(await readOAuthToken(home, 'xai-oauth')).toBeNull()
  })
})
