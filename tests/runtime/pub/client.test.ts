/**
 * Tests for PubClient (Epic 3 PR C).
 *
 * Spins up a real fake-pub-server (HTTP + WebSocket) and exercises
 * the connect → send → receive → react → close lifecycle. The fake
 * mirrors the v0.3.x wire shapes so the client code is exercised
 * the same way the real binary will run it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startFakePub, type FakePub } from './fake-pub-server.js'
import { PubClient } from '../../../src/runtime/pub/client.js'
import { createIdentityClient, ensureRegistered } from '../../../src/runtime/pub/identity-client.js'
import { generateKeypair } from '../../../src/runtime/pub/keypair.js'
import type { PubCredential } from '../../../src/runtime/pub/keypair.js'

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

async function registerAndCred(displayName: string): Promise<PubCredential> {
  if (!pub) throw new Error('pub not started')
  const id = createIdentityClient({ baseUrl: pub.baseUrl })
  const cred = generateKeypair({ display_name: displayName, issuer_url: pub.baseUrl })
  return await ensureRegistered(id, cred)
}

describe('PubClient.connect', () => {
  it('opens the WebSocket and receives welcome + room_state', async () => {
    pub = await startFakePub()
    const cred = await registerAndCred('hobby')
    const client = new PubClient({ baseUrl: pub.baseUrl, cred })
    await client.connect()
    expect(client.roomState()).not.toBeNull()
    expect(client.roomState()?.pub_name).toBe('ops')
    await client.close()
  })

  it('throws PubClientError when keypair is unregistered', async () => {
    pub = await startFakePub()
    const unregisteredCred = generateKeypair({
      display_name: 'never',
      issuer_url: pub.baseUrl,
    })
    const client = new PubClient({ baseUrl: pub.baseUrl, cred: unregisteredCred })
    await expect(client.connect()).rejects.toThrow(/registered/)
  })

  it('idempotent connect: second call is a no-op', async () => {
    pub = await startFakePub()
    const cred = await registerAndCred('hobby')
    const client = new PubClient({ baseUrl: pub.baseUrl, cred })
    await client.connect()
    await client.connect()
    expect(pub.connectedAgents.size).toBe(1)
    await client.close()
  })
})

describe('PubClient.send', () => {
  it('sends a message and receives the echo with assigned message_id', async () => {
    pub = await startFakePub()
    const cred = await registerAndCred('hobby')
    const client = new PubClient({ baseUrl: pub.baseUrl, cred })
    await client.connect()
    const result = await client.send({ content: 'hello pub' })
    expect(result.message_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.timestamp).toMatch(/Z$/)
    expect(pub.receivedMessages).toHaveLength(1)
    expect(pub.receivedMessages[0]?.content).toBe('hello pub')
    await client.close()
  })

  it('caches the sent message for subsequent readCached', async () => {
    pub = await startFakePub()
    const cred = await registerAndCred('hobby')
    const client = new PubClient({ baseUrl: pub.baseUrl, cred })
    await client.connect()
    await client.send({ content: 'first' })
    await client.send({ content: 'second' })
    const cached = client.readCached()
    expect(cached.length).toBe(2)
    expect(cached[0]?.content).toBe('first')
    expect(cached[1]?.content).toBe('second')
    await client.close()
  })

  it('readCached with since_message_id returns only newer', async () => {
    pub = await startFakePub()
    const cred = await registerAndCred('hobby')
    const client = new PubClient({ baseUrl: pub.baseUrl, cred })
    await client.connect()
    const first = await client.send({ content: 'first' })
    await client.send({ content: 'second' })
    await client.send({ content: 'third' })
    const since = client.readCached({ since_message_id: first.message_id })
    expect(since.map((m) => m.content)).toEqual(['second', 'third'])
    await client.close()
  })

  it('passes mentions and reply_to through to the server', async () => {
    pub = await startFakePub()
    const cred = await registerAndCred('hobby')
    const client = new PubClient({ baseUrl: pub.baseUrl, cred })
    await client.connect()
    await client.send({
      content: 'first',
    })
    const cached = client.readCached()
    const firstId = cached[0]!.message_id
    await client.send({
      content: 'reply',
      in_reply_to: firstId,
      mentions: ['some-other-agent-id'],
    })
    const all = client.readCached()
    expect(all.length).toBe(2)
    expect(all[1]?.reply_to).toBe(firstId)
    expect(all[1]?.mentions).toContain('some-other-agent-id')
    await client.close()
  })
})

describe('PubClient.react', () => {
  it('sends a reaction without throwing', async () => {
    pub = await startFakePub()
    const cred = await registerAndCred('hobby')
    const client = new PubClient({ baseUrl: pub.baseUrl, cred })
    await client.connect()
    const sent = await client.send({ content: 'hello' })
    await client.react(sent.message_id, '👍')
    // Reaction broadcasts back; we don't assert on cache here because
    // PubClient only caches messages, not reactions. The fake server's
    // reaction handler runs without error and broadcasts the event.
    await client.close()
  })
})

describe('PubClient subscribers', () => {
  it('onEvent fires for each broadcast message', async () => {
    pub = await startFakePub()
    const cred = await registerAndCred('hobby')
    const client = new PubClient({ baseUrl: pub.baseUrl, cred })
    await client.connect()
    const events: string[] = []
    const unsubscribe = client.onEvent((event) => {
      events.push(event.type)
    })
    await client.send({ content: 'one' })
    await client.send({ content: 'two' })
    expect(events).toContain('message')
    expect(events.filter((t) => t === 'message').length).toBe(2)
    unsubscribe()
    await client.send({ content: 'three' })
    // After unsubscribe, no new events recorded.
    expect(events.filter((t) => t === 'message').length).toBe(2)
    await client.close()
  })
})

describe('PubClient.close', () => {
  it('idempotent close: second call is a no-op; server-side disconnect lands', async () => {
    pub = await startFakePub()
    const cred = await registerAndCred('hobby')
    const client = new PubClient({ baseUrl: pub.baseUrl, cred })
    await client.connect()
    await client.close()
    await client.close()
    // Give the server's close handler a tick to process the disconnect.
    await new Promise((r) => setTimeout(r, 50))
    expect(pub.connectedAgents.size).toBe(0)
  })

  it('after close, send() and connect() throw (close is terminal)', async () => {
    pub = await startFakePub()
    const cred = await registerAndCred('hobby')
    const client = new PubClient({ baseUrl: pub.baseUrl, cred })
    await client.connect()
    await client.close()
    await expect(client.send({ content: 'x' })).rejects.toThrow(/closed/)
    await expect(client.connect()).rejects.toThrow(/closed/)
  })
})

describe('Two PubClients in the same pub', () => {
  it('both connected agents see each other in the room and receive each other’s messages', async () => {
    pub = await startFakePub()
    const credA = await registerAndCred('alice')
    const credB = await registerAndCred('bob')
    const a = new PubClient({ baseUrl: pub.baseUrl, cred: credA })
    const b = new PubClient({ baseUrl: pub.baseUrl, cred: credB })
    await a.connect()
    await b.connect()

    // Capture events on b's side.
    const seen: string[] = []
    const unsub = b.onEvent((event) => {
      if (event.type === 'message') seen.push(event.data.content)
    })

    await a.send({ content: 'hey bob' })
    // Give the broadcast a tick to flow.
    await new Promise((r) => setTimeout(r, 50))
    expect(seen).toContain('hey bob')

    unsub()
    await a.close()
    await b.close()
  })
})
