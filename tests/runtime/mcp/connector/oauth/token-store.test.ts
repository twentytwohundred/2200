import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deleteAccessToken,
  isAccessTokenShape,
  isRefreshTokenShape,
  issueAccessToken,
  issueRefreshToken,
  mintAccessToken,
  mintRefreshToken,
  readAccessToken,
  readRefreshToken,
  revokeChain,
  revokeClientTokens,
  saveRefreshToken,
} from '../../../../../src/runtime/mcp/connector/oauth/token-store.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-oauth-tokens-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('token-shape helpers', () => {
  it('mints distinguishable access vs refresh tokens', () => {
    const at = mintAccessToken()
    const rt = mintRefreshToken()
    expect(isAccessTokenShape(at)).toBe(true)
    expect(isAccessTokenShape(rt)).toBe(false)
    expect(isRefreshTokenShape(rt)).toBe(true)
    expect(isRefreshTokenShape(at)).toBe(false)
    expect(at).toMatch(/^2200-mcp-at-[A-Za-z0-9_-]+$/)
    expect(rt).toMatch(/^2200-mcp-rt-[A-Za-z0-9_-]+$/)
  })
})

describe('access tokens: issue / read / delete', () => {
  it('round-trips an access token through issue → read', async () => {
    const { token, record } = await issueAccessToken({
      home,
      clientId: 'grok-aaa',
      scopes: ['connector:full'],
    })
    expect(isAccessTokenShape(token)).toBe(true)
    expect(record.client_id).toBe('grok-aaa')
    const read = await readAccessToken(home, token)
    expect(read).not.toBeNull()
    expect(read?.client_id).toBe('grok-aaa')
    expect(read?.scopes).toEqual(['connector:full'])
  })

  it('honors a custom TTL', async () => {
    const fixedNow = new Date('2026-05-23T10:00:00Z')
    const { record } = await issueAccessToken({
      home,
      clientId: 'grok-aaa',
      scopes: ['connector:full'],
      ttlMs: 3_600_000,
      now: () => fixedNow,
    })
    expect(record.expires_at).toBe('2026-05-23T11:00:00.000Z')
  })

  it('delete is idempotent', async () => {
    const { token } = await issueAccessToken({
      home,
      clientId: 'grok-aaa',
      scopes: [],
    })
    expect(await deleteAccessToken(home, token)).toBe(true)
    expect(await deleteAccessToken(home, token)).toBe(false)
  })
})

describe('refresh tokens: issue / chain semantics', () => {
  it('round-trips a refresh token + carries chain_id + rotated:false', async () => {
    const { token, record } = await issueRefreshToken({
      home,
      clientId: 'grok-aaa',
      scopes: ['connector:full'],
    })
    expect(isRefreshTokenShape(token)).toBe(true)
    expect(record.chain_id).toMatch(/^chain-/)
    expect(record.rotated).toBe(false)
  })

  it('reuses a chain when chainId is passed (rotation case)', async () => {
    const original = await issueRefreshToken({
      home,
      clientId: 'grok-aaa',
      scopes: [],
    })
    const rotated = await issueRefreshToken({
      home,
      clientId: 'grok-aaa',
      scopes: [],
      chainId: original.record.chain_id,
    })
    expect(rotated.record.chain_id).toBe(original.record.chain_id)
    expect(rotated.token).not.toBe(original.token)
  })
})

describe('revokeChain', () => {
  it('removes every refresh token in a chain, leaving other chains intact', async () => {
    const chainA = await issueRefreshToken({ home, clientId: 'grok-aaa', scopes: [] })
    const chainAlater = await issueRefreshToken({
      home,
      clientId: 'grok-aaa',
      scopes: [],
      chainId: chainA.record.chain_id,
    })
    const chainB = await issueRefreshToken({ home, clientId: 'grok-bbb', scopes: [] })

    const { removed } = await revokeChain(home, chainA.record.chain_id)
    expect(removed).toBe(2)

    expect(await readRefreshToken(home, chainA.token)).toBeNull()
    expect(await readRefreshToken(home, chainAlater.token)).toBeNull()
    expect(await readRefreshToken(home, chainB.token)).not.toBeNull()
  })
})

describe('revokeClientTokens', () => {
  it('purges every access + refresh token for a client', async () => {
    const at1 = await issueAccessToken({ home, clientId: 'grok-aaa', scopes: [] })
    const at2 = await issueAccessToken({ home, clientId: 'grok-aaa', scopes: [] })
    const rt1 = await issueRefreshToken({ home, clientId: 'grok-aaa', scopes: [] })
    const atOther = await issueAccessToken({ home, clientId: 'grok-bbb', scopes: [] })

    const counts = await revokeClientTokens(home, 'grok-aaa')
    expect(counts.removed_access).toBe(2)
    expect(counts.removed_refresh).toBe(1)

    expect(await readAccessToken(home, at1.token)).toBeNull()
    expect(await readAccessToken(home, at2.token)).toBeNull()
    expect(await readRefreshToken(home, rt1.token)).toBeNull()
    expect(await readAccessToken(home, atOther.token)).not.toBeNull()
  })
})

describe('saveRefreshToken update path (rotation flag)', () => {
  it('marks a refresh token rotated and the next read sees the flag', async () => {
    const { token, record } = await issueRefreshToken({
      home,
      clientId: 'grok-aaa',
      scopes: [],
    })
    await saveRefreshToken(home, { ...record, rotated: true })
    const read = await readRefreshToken(home, token)
    expect(read?.rotated).toBe(true)
  })
})

describe('on-disk file does not leak plaintext token', () => {
  it('the access-token sealed file does not expose the token value (client_id IS metadata-plaintext by design)', async () => {
    // client_id sits in the unencrypted metadata block on purpose:
    // revokeClientTokens scans the directory without decrypting every
    // file. The token VALUE is what must stay secret.
    const SECRET_SCOPE_MARKER = 'must-not-end-up-on-disk-zzz'
    const { token } = await issueAccessToken({
      home,
      clientId: 'grok-aaa',
      scopes: [SECRET_SCOPE_MARKER],
    })
    expect(isAccessTokenShape(token)).toBe(true)
    const dir = join(home, 'state', 'connector', 'oauth-access-tokens')
    const { readdir, readFile } = await import('node:fs/promises')
    const files = await readdir(dir)
    let total = ''
    for (const f of files) total += await readFile(join(dir, f), 'utf-8')
    expect(total).not.toContain(token)
    expect(total).not.toContain(SECRET_SCOPE_MARKER)
  })
})
