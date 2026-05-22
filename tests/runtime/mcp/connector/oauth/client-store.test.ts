import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deleteClient,
  hashClientSecret,
  listClients,
  markRevoked,
  readClient,
  recordAuthorize,
  registerClient,
  rotateClientSecret,
  verifyClientSecret,
} from '../../../../../src/runtime/mcp/connector/oauth/client-store.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-oauth-client-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('hashClientSecret + verifyClientSecret', () => {
  it('round-trips a secret through scrypt hash + constant-time verify', async () => {
    const secret = 'shhh-this-is-my-secret-1234'
    const hash = await hashClientSecret(secret)
    expect(hash).toMatch(/^[0-9a-f]+:[0-9a-f]+$/)
    expect(await verifyClientSecret(secret, hash)).toBe(true)
    expect(await verifyClientSecret('wrong-secret', hash)).toBe(false)
  })

  it('rejects malformed hash strings', async () => {
    expect(await verifyClientSecret('x', 'not-a-real-hash')).toBe(false)
    expect(await verifyClientSecret('x', '')).toBe(false)
  })
})

describe('registerClient', () => {
  it('mints a `grok-<24 hex>` client_id and returns no secret by default', async () => {
    const result = await registerClient({
      home,
      displayName: 'Grok (test)',
      redirectUris: ['https://grok.com/connectors/x/callback'],
    })
    expect(result.clientId).toMatch(/^grok-[0-9a-f]{24}$/)
    expect(result.clientSecret).toBeNull()
  })

  it('returns a one-time plaintext secret when mintSecret: true', async () => {
    const result = await registerClient({
      home,
      displayName: 'Grok (with secret)',
      redirectUris: ['https://grok.com/connectors/x/callback'],
      mintSecret: true,
    })
    expect(result.clientSecret).not.toBeNull()
    expect(result.clientSecret!.length).toBeGreaterThan(40)
  })

  it('does not leak the secret into the on-disk sealed file', async () => {
    const SECRET_MARKER = 'verifyTHISsecretDoesNotEndUpOnDiskInPlaintext'
    // The store mints the secret; we can't inject. Instead, verify
    // that the stored record's client_secret_hash is not the raw
    // plaintext.
    const result = await registerClient({
      home,
      displayName: 'Grok',
      redirectUris: ['https://grok.com/x'],
      mintSecret: true,
    })
    const recordPath = join(home, 'state', 'connector', 'oauth-clients', `${result.clientId}.json`)
    const raw = await readFile(recordPath, 'utf-8')
    // Sealed envelope: no plaintext from the secret should be readable.
    expect(raw).not.toContain(result.clientSecret!)
    expect(raw).not.toContain(SECRET_MARKER)
  })
})

describe('readClient / listClients / deleteClient', () => {
  it('returns null for unknown client_id', async () => {
    expect(await readClient(home, 'grok-doesnotexist')).toBeNull()
  })

  it('lists every registered client, sorted by registered_at descending', async () => {
    const a = await registerClient({
      home,
      displayName: 'Earlier',
      redirectUris: ['https://x.example/cb'],
      now: () => new Date('2026-05-23T10:00:00Z'),
    })
    const b = await registerClient({
      home,
      displayName: 'Later',
      redirectUris: ['https://y.example/cb'],
      now: () => new Date('2026-05-23T11:00:00Z'),
    })
    const items = await listClients(home)
    expect(items).toHaveLength(2)
    expect(items[0]?.client_id).toBe(b.clientId)
    expect(items[1]?.client_id).toBe(a.clientId)
  })

  it('delete is idempotent', async () => {
    const reg = await registerClient({
      home,
      displayName: 'x',
      redirectUris: ['https://x.example/cb'],
    })
    expect(await deleteClient(home, reg.clientId)).toBe(true)
    expect(await deleteClient(home, reg.clientId)).toBe(false)
  })
})

describe('recordAuthorize + markRevoked', () => {
  it('writes last_authorize_at on recordAuthorize', async () => {
    const reg = await registerClient({
      home,
      displayName: 'x',
      redirectUris: ['https://x.example/cb'],
    })
    await recordAuthorize(home, reg.clientId, new Date('2026-05-23T12:00:00Z'))
    const r = await readClient(home, reg.clientId)
    expect(r?.last_authorize_at).toBe('2026-05-23T12:00:00.000Z')
  })

  it('markRevoked sets the revoked_at timestamp', async () => {
    const reg = await registerClient({
      home,
      displayName: 'x',
      redirectUris: ['https://x.example/cb'],
    })
    await markRevoked(home, reg.clientId, new Date('2026-05-23T13:00:00Z'))
    const r = await readClient(home, reg.clientId)
    expect(r?.revoked_at).toBe('2026-05-23T13:00:00.000Z')
  })
})

describe('rotateClientSecret', () => {
  it('rotates the secret on an existing client and returns the new plaintext', async () => {
    const reg = await registerClient({
      home,
      displayName: 'x',
      redirectUris: ['https://x.example/cb'],
      mintSecret: true,
    })
    const fresh = await rotateClientSecret(home, reg.clientId)
    expect(fresh.length).toBeGreaterThan(40)
    const r = await readClient(home, reg.clientId)
    expect(r?.client_secret_hash).not.toBeNull()
    expect(await verifyClientSecret(fresh, r!.client_secret_hash!)).toBe(true)
    expect(await verifyClientSecret(reg.clientSecret!, r!.client_secret_hash!)).toBe(false)
  })
})
