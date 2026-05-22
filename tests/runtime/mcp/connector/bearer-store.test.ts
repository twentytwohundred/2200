/**
 * Tests for the fleet-scoped MCP connector bearer-token store.
 *
 * Same primitives as the OAuth token store but with a distinct HKDF
 * namespace. Tests cover token minting shape, round-trip, missing-file
 * behavior, idempotent overwrite (regenerate), delete (disable), and
 * the regression guard that plaintext does not appear in the sealed
 * file on disk.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deleteBearer,
  hasBearer,
  isWellFormedBearerToken,
  mintBearerToken,
  readBearer,
  saveBearer,
} from '../../../../src/runtime/mcp/connector/bearer-store.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-connector-bearer-store-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('mintBearerToken', () => {
  it('produces a token in the canonical 2200-mcp- shape', () => {
    const t = mintBearerToken()
    expect(t).toMatch(/^2200-mcp-[A-Za-z0-9_-]+$/)
    expect(isWellFormedBearerToken(t)).toBe(true)
  })

  it('produces 32 random bytes worth of entropy (43 base64url chars)', () => {
    const t = mintBearerToken()
    const rest = t.slice('2200-mcp-'.length)
    // 32 bytes base64url-encoded is 43 chars (no padding for non-multiple-of-3).
    expect(rest).toHaveLength(43)
  })

  it('does not collide across calls', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) seen.add(mintBearerToken())
    expect(seen.size).toBe(200)
  })
})

describe('isWellFormedBearerToken', () => {
  it('rejects unprefixed strings', () => {
    expect(isWellFormedBearerToken('aaaaaaaaaaaaaaaaaaaaa')).toBe(false)
  })

  it('rejects too-short suffixes', () => {
    expect(isWellFormedBearerToken('2200-mcp-short')).toBe(false)
  })

  it('rejects suffixes with disallowed characters', () => {
    expect(isWellFormedBearerToken('2200-mcp-has spaces and stuff!')).toBe(false)
  })

  it('accepts a freshly minted token', () => {
    expect(isWellFormedBearerToken(mintBearerToken())).toBe(true)
  })
})

describe('bearer-store persistence', () => {
  it('round-trips a token through save+read', async () => {
    const token = mintBearerToken()
    await saveBearer(home, {
      token,
      createdAt: '2026-05-22T10:00:00.000Z',
    })
    const read = await readBearer(home)
    expect(read).not.toBeNull()
    expect(read?.token).toBe(token)
    expect(read?.createdAt).toBe('2026-05-22T10:00:00.000Z')
    expect(read?.regeneratedAt).toBeUndefined()
  })

  it('returns null when no token has been saved', async () => {
    expect(await readBearer(home)).toBeNull()
    expect(await hasBearer(home)).toBe(false)
  })

  it('overwrites the prior token on regenerate', async () => {
    await saveBearer(home, { token: mintBearerToken(), createdAt: '2026-05-22T10:00:00.000Z' })
    const newToken = mintBearerToken()
    await saveBearer(home, {
      token: newToken,
      createdAt: '2026-05-22T10:00:00.000Z',
      regeneratedAt: '2026-05-22T11:00:00.000Z',
    })
    const read = await readBearer(home)
    expect(read?.token).toBe(newToken)
    expect(read?.regeneratedAt).toBe('2026-05-22T11:00:00.000Z')
  })

  it('hasBearer reflects save/delete', async () => {
    expect(await hasBearer(home)).toBe(false)
    await saveBearer(home, { token: mintBearerToken(), createdAt: '2026-05-22T10:00:00.000Z' })
    expect(await hasBearer(home)).toBe(true)
    await deleteBearer(home)
    expect(await hasBearer(home)).toBe(false)
  })

  it('delete is idempotent', async () => {
    expect(await deleteBearer(home)).toBe(false)
    await saveBearer(home, { token: mintBearerToken(), createdAt: '2026-05-22T10:00:00.000Z' })
    expect(await deleteBearer(home)).toBe(true)
    expect(await deleteBearer(home)).toBe(false)
  })

  it('the on-disk file does not contain the plaintext token', async () => {
    const SECRET = '2200-mcp-DO-NOT-LEAK-THIS-MARKER-VALUE-AAAA'
    await saveBearer(home, { token: SECRET, createdAt: '2026-05-22T10:00:00.000Z' })
    const path = join(home, 'state', 'connector', 'bearer.json')
    const raw = await readFile(path, 'utf-8')
    expect(raw).not.toContain('DO-NOT-LEAK-THIS-MARKER-VALUE')
  })
})
