/**
 * Tests for the identity HTTP client.
 *
 * Spins up a real http.Server implementing the v0.3.2 LOCAL_TRUST
 * contract from Poe's reply (2026-04-26):
 *
 *  - GET  /agents/me            (401 / 404 / 200)
 *  - POST /admin/register-agent (201 / 409)
 *  - POST /agents/auth          (200)
 *
 * Faking at the HTTP level rather than the fetch level so the test
 * exercises the same code path the real binary will hit.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  createIdentityClient,
  ensureRegistered,
  IdentityClientError,
  RegisterAgentConflict,
} from '../../../src/runtime/pub/identity-client.js'
import { generateKeypair } from '../../../src/runtime/pub/keypair.js'

interface FakePub {
  baseUrl: string
  agents: Map<
    string,
    { agent_id: string; display_name: string; public_key: string; key_version: number }
  >
  byName: Map<string, string>
  close: () => Promise<void>
  /** Number of requests received per path. Useful for asserting call counts. */
  callCounts: Map<string, number>
}

async function startFakePub(opts: { conflictDisplayName?: string } = {}): Promise<FakePub> {
  const agents = new Map<
    string,
    { agent_id: string; display_name: string; public_key: string; key_version: number }
  >()
  const byName = new Map<string, string>()
  const callCounts = new Map<string, number>()

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const key = `${req.method ?? 'GET'} ${url.pathname}`
    callCounts.set(key, (callCounts.get(key) ?? 0) + 1)

    void readBody(req).then((rawBody) => {
      if (req.method === 'GET' && url.pathname === '/agents/me') {
        const agentId = req.headers['x-openpub-agent-id']
        if (typeof agentId !== 'string' || !agents.has(agentId)) {
          res.writeHead(404).end()
          return
        }
        const record = agents.get(agentId)!
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(record))
        return
      }
      if (req.method === 'POST' && url.pathname === '/admin/register-agent') {
        const body = JSON.parse(rawBody) as {
          display_name: string
          public_key: string
          key_version: number
        }
        if (opts.conflictDisplayName && body.display_name === opts.conflictDisplayName) {
          res.writeHead(409).end()
          return
        }
        if (byName.has(body.display_name)) {
          res.writeHead(409).end()
          return
        }
        const agent_id = uuidV7Like()
        const record = { agent_id, ...body }
        agents.set(agent_id, record)
        byName.set(body.display_name, agent_id)
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ agent_id }))
        return
      }
      if (req.method === 'POST' && url.pathname === '/agents/auth') {
        // We do not verify the signature in the fake; that's an
        // integration concern. The pub-server's real implementation
        // does verify.
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            access_token: 'access-' + randomUUID(),
            refresh_token: 'refresh-' + randomUUID(),
            access_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
          }),
        )
        return
      }
      res.writeHead(404).end()
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve()
    })
  })
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no address')
  return {
    baseUrl: `http://127.0.0.1:${String(addr.port)}`,
    agents,
    byName,
    callCounts,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      }),
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  return new Promise((resolve, reject) => {
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

function uuidV7Like(): string {
  // Real UUID v7 has time-ordered prefix; the fake just uses v4 for
  // shape. Format matches the 36-char canonical UUID.
  return randomUUID()
}

let pub: FakePub | undefined

beforeEach(() => {
  pub = undefined
})

afterEach(async () => {
  if (pub) {
    await pub.close()
    pub = undefined
  }
})

describe('createIdentityClient', () => {
  it('strips trailing slash from baseUrl', () => {
    const client = createIdentityClient({ baseUrl: 'http://x:1/' })
    expect(client.baseUrl).toBe('http://x:1')
  })
})

describe('registerAgent', () => {
  it('registers a fresh keypair and returns agent_id', async () => {
    pub = await startFakePub()
    const client = createIdentityClient({ baseUrl: pub.baseUrl })
    const cred = generateKeypair({ display_name: 'hobby', issuer_url: pub.baseUrl })
    const result = await client.registerAgent(cred)
    expect(result.agent_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(pub.callCounts.get('POST /admin/register-agent')).toBe(1)
  })

  it('throws RegisterAgentConflict on 409', async () => {
    pub = await startFakePub({ conflictDisplayName: 'hobby' })
    const client = createIdentityClient({ baseUrl: pub.baseUrl })
    const cred = generateKeypair({ display_name: 'hobby', issuer_url: pub.baseUrl })
    await expect(client.registerAgent(cred)).rejects.toBeInstanceOf(RegisterAgentConflict)
  })

  it('throws IdentityClientError on unexpected status', async () => {
    pub = await startFakePub()
    const client = createIdentityClient({ baseUrl: pub.baseUrl + '/wrong' })
    const cred = generateKeypair({ display_name: 'h', issuer_url: pub.baseUrl })
    await expect(client.registerAgent(cred)).rejects.toBeInstanceOf(IdentityClientError)
  })
})

describe('getMe', () => {
  it('returns null when keypair has no agent_id yet', async () => {
    pub = await startFakePub()
    const client = createIdentityClient({ baseUrl: pub.baseUrl })
    const cred = generateKeypair({ display_name: 'h', issuer_url: pub.baseUrl })
    expect(await client.getMe(cred)).toBeNull()
  })

  it('returns null on 404 (keypair not registered)', async () => {
    pub = await startFakePub()
    const client = createIdentityClient({ baseUrl: pub.baseUrl })
    const cred = {
      ...generateKeypair({ display_name: 'h', issuer_url: pub.baseUrl }),
      agent_id: 'never-registered-id',
    }
    expect(await client.getMe(cred)).toBeNull()
  })

  it('returns the agent record after register', async () => {
    pub = await startFakePub()
    const client = createIdentityClient({ baseUrl: pub.baseUrl })
    const cred = generateKeypair({ display_name: 'hobby', issuer_url: pub.baseUrl })
    const { agent_id } = await client.registerAgent(cred)
    const updated = { ...cred, agent_id }
    const record = await client.getMe(updated)
    expect(record).not.toBeNull()
    expect(record?.agent_id).toBe(agent_id)
    expect(record?.display_name).toBe('hobby')
    expect(record?.public_key).toBe(cred.public_key)
  })
})

describe('mintToken', () => {
  it('returns a token pair from the auth endpoint', async () => {
    pub = await startFakePub()
    const client = createIdentityClient({ baseUrl: pub.baseUrl })
    const cred = generateKeypair({ display_name: 'h', issuer_url: pub.baseUrl })
    const { agent_id } = await client.registerAgent(cred)
    const tokens = await client.mintToken({ ...cred, agent_id })
    expect(tokens.access_token).toMatch(/^access-/)
    expect(tokens.refresh_token).toMatch(/^refresh-/)
    expect(tokens.access_expires_at).toMatch(/Z$/)
  })

  it('rejects when keypair has no agent_id', async () => {
    pub = await startFakePub()
    const client = createIdentityClient({ baseUrl: pub.baseUrl })
    const cred = generateKeypair({ display_name: 'h', issuer_url: pub.baseUrl })
    await expect(client.mintToken(cred)).rejects.toThrow(/registered agent_id/)
  })
})

describe('ensureRegistered (idempotent provisioning)', () => {
  it('registers a fresh keypair and returns updated cred', async () => {
    pub = await startFakePub()
    const client = createIdentityClient({ baseUrl: pub.baseUrl })
    const cred = generateKeypair({ display_name: 'h', issuer_url: pub.baseUrl })
    const updated = await ensureRegistered(client, cred)
    expect(updated.agent_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(pub.callCounts.get('POST /admin/register-agent')).toBe(1)
    expect(pub.callCounts.get('GET /agents/me')).toBeUndefined() // no agent_id, no GET
  })

  it('skips register when getMe confirms an existing agent_id', async () => {
    pub = await startFakePub()
    const client = createIdentityClient({ baseUrl: pub.baseUrl })
    const cred0 = generateKeypair({ display_name: 'h', issuer_url: pub.baseUrl })
    const updated = await ensureRegistered(client, cred0)
    // Second call with the credential that already has agent_id: GET /me succeeds, register skipped.
    const second = await ensureRegistered(client, updated)
    expect(second.agent_id).toBe(updated.agent_id)
    expect(pub.callCounts.get('POST /admin/register-agent')).toBe(1) // still 1
    expect(pub.callCounts.get('GET /agents/me')).toBe(1)
  })

  it('throws on agent_id mismatch between credential and pub-server', async () => {
    pub = await startFakePub()
    const client = createIdentityClient({ baseUrl: pub.baseUrl })
    const cred = generateKeypair({ display_name: 'h', issuer_url: pub.baseUrl })
    const { agent_id } = await client.registerAgent(cred)
    // Now claim a different agent_id while the pub-server knows the right one.
    const lying = { ...cred, agent_id: 'a-totally-different-id' }
    // getMe with that wrong id will 404; ensureRegistered then attempts
    // to re-register, which 409s because display_name is taken.
    await expect(ensureRegistered(client, lying)).rejects.toBeInstanceOf(RegisterAgentConflict)
    // Sanity: the original agent_id is still recognized.
    expect(await client.getMe({ ...cred, agent_id })).not.toBeNull()
  })
})
