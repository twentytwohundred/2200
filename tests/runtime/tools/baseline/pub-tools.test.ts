/**
 * End-to-end tests for the four pub.* baseline tools (Epic 3 PR C).
 *
 * Spins up:
 *   - A fake pub-server (HTTP for identity + WebSocket for messages)
 *   - A real Supervisor with a registered pub record pointing at the
 *     fake server's port (state == 'running')
 *   - A registered Agent with a pub credential file on disk
 *
 * Then exercises each tool's `execute()` path. Tests run against the
 * tool definitions directly (not the dispatcher) because the
 * dispatcher's plan/run/perm wrapping is exercised by Epic 2's
 * dispatcher tests; this file covers tool-specific behavior.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFakePub, type FakePub } from '../../pub/fake-pub-server.js'
import { Supervisor } from '../../../../src/runtime/supervisor/supervisor.js'
import {
  pubSend,
  pubRead,
  pubListPubs,
  pubReact,
} from '../../../../src/runtime/tools/baseline/pub.js'
import { writeCredentialFile } from '../../../../src/runtime/pub/keypair.js'
import { generateKeypair } from '../../../../src/runtime/pub/keypair-generate.js'
import {
  createIdentityClient,
  ensureRegistered,
} from '../../../../src/runtime/pub/identity-client.js'
import { evictAllPubClients } from '../../../../src/runtime/pub/registry.js'
import { agentPaths } from '../../../../src/runtime/storage/layout.js'
import type { ToolContext } from '../../../../src/runtime/mcp/tool.js'
import { getWatermark } from '../../../../src/runtime/pub/watermark.js'

let home: string
let supervisor: Supervisor | undefined
let pub: FakePub | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-pub-tools-'))
})

afterEach(async () => {
  await evictAllPubClients()
  if (supervisor) {
    await supervisor.shutdown()
    supervisor = undefined
  }
  if (pub) {
    await pub.close()
    pub = undefined
  }
  await rm(home, { recursive: true, force: true })
})

/** Minimal harness: supervisor + running pub record + registered Agent. */
async function setup(agentName: string): Promise<ToolContext> {
  // 1. Real fake pub-server.
  pub = await startFakePub()

  // 2. Supervisor with a pub record marked 'running' pointing at the fake.
  supervisor = await Supervisor.create({ home })
  await supervisor.start()
  await supervisor.createPub('ops', { port: pub.port })
  // Inject 'running' state via the underlying state edit. Bypassing
  // startPub because startPub would spawn a real openpub-server; the
  // fake server is what's actually listening.
  await supervisor.shutdown()
  const { loadState, saveState } = await import('../../../../src/runtime/supervisor/state.js')
  const state = await loadState(home)
  const record = state.pubs['ops']!
  state.pubs['ops'] = {
    ...record,
    state: 'running',
    pid: 12345,
    spawned_at: new Date().toISOString(),
  }
  await saveState(state)
  supervisor = await Supervisor.create({ home })
  await supervisor.start()

  // 3. Register the Agent's pub identity against the fake server.
  const identityClient = createIdentityClient({ baseUrl: pub.baseUrl })
  const cred = generateKeypair({ display_name: agentName, issuer_url: pub.baseUrl })
  const updated = await ensureRegistered(identityClient, cred)
  // Mint the per-Agent dirs and persist the credential file.
  await mkdir(agentPaths(home, agentName).root, { recursive: true })
  await writeCredentialFile(agentPaths(home, agentName).pubSecret, updated)

  return {
    callingAgent: agentName,
    home,
    brainDir: agentPaths(home, agentName).brain,
    projectDir: agentPaths(home, agentName).project,
    taskId: null,
    callId: 'call_test',
  }
}

describe('pub_send', () => {
  it('sends a message and returns the assigned message_id', async () => {
    const ctx = await setup('hobby')
    const result = await pubSend.execute({ content: 'hello pub' }, ctx)
    expect(result.pub_name).toBe('ops')
    expect(result.message_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(pub!.receivedMessages[0]?.content).toBe('hello pub')
  })

  it('passes mentions through', async () => {
    const ctx = await setup('hobby')
    await pubSend.execute({ content: 'fyi', mentions: ['some-id'] }, ctx)
    expect(pub!.receivedMessages).toHaveLength(1)
  })

  it('errors when no pubs exist on the instance', async () => {
    // Skip the running-pub setup; just have a supervisor with no pubs.
    pub = await startFakePub()
    supervisor = await Supervisor.create({ home })
    await supervisor.start()
    const cred = generateKeypair({ display_name: 'hobby', issuer_url: pub.baseUrl })
    await mkdir(agentPaths(home, 'hobby').root, { recursive: true })
    await writeCredentialFile(agentPaths(home, 'hobby').pubSecret, cred)
    const ctx: ToolContext = {
      callingAgent: 'hobby',
      home,
      brainDir: agentPaths(home, 'hobby').brain,
      projectDir: agentPaths(home, 'hobby').project,
      taskId: null,
      callId: 'call_test',
    }
    await expect(pubSend.execute({ content: 'x' }, ctx)).rejects.toThrow(/no running pubs/)
  })

  it('errors when the named pub does not exist', async () => {
    const ctx = await setup('hobby')
    await expect(pubSend.execute({ content: 'x', pub_name: 'no-such' }, ctx)).rejects.toThrow(
      /does not exist/,
    )
  })

  it('errors when the Agent has no registered pub identity (agent_id null)', async () => {
    const ctx = await setup('hobby')
    // Overwrite credential with one that has no agent_id.
    const cred = generateKeypair({ display_name: 'fresh', issuer_url: pub!.baseUrl })
    await writeCredentialFile(agentPaths(home, 'hobby').pubSecret, cred)
    await expect(pubSend.execute({ content: 'x' }, ctx)).rejects.toThrow(
      /no registered pub identity/,
    )
  })
})

describe('pub.read with watermark', () => {
  it('returns messages newer than watermark and advances it', async () => {
    const ctx = await setup('hobby')
    // Send three messages so the cache populates.
    await pubSend.execute({ content: 'one' }, ctx)
    await pubSend.execute({ content: 'two' }, ctx)
    await pubSend.execute({ content: 'three' }, ctx)

    // First read with no watermark should return all three and advance the watermark.
    const first = await pubRead.execute({ limit: 50 }, ctx)
    expect(first.messages.map((m) => m.content)).toEqual(['one', 'two', 'three'])
    expect(first.advanced_watermark).toBe(true)

    // Second read returns nothing (cache exhausted past watermark).
    const second = await pubRead.execute({ limit: 50 }, ctx)
    expect(second.messages).toEqual([])

    // Watermark on disk reflects the last read.
    const wm = await getWatermark(home, 'hobby', 'ops')
    expect(wm?.last_read_message_id).toBe(first.messages[2]!.message_id)
  })

  it('explicit since_message_id is non-mutating (does not advance watermark)', async () => {
    const ctx = await setup('hobby')
    const a = await pubSend.execute({ content: 'a' }, ctx)
    const b = await pubSend.execute({ content: 'b' }, ctx)
    void b // suppress unused warning
    // Read with explicit since: returns 'b' but does NOT advance watermark.
    const result = await pubRead.execute({ since_message_id: a.message_id, limit: 50 }, ctx)
    expect(result.advanced_watermark).toBe(false)
    expect(result.messages.map((m) => m.content)).toEqual(['b'])
    const wm = await getWatermark(home, 'hobby', 'ops')
    expect(wm).toBeNull()
  })
})

describe('pub_list_pubs', () => {
  it('reports the running pub and its port', async () => {
    const ctx = await setup('hobby')
    const result = await pubListPubs.execute({}, ctx)
    expect(result.pubs).toHaveLength(1)
    expect(result.pubs[0]?.name).toBe('ops')
    expect(result.pubs[0]?.state).toBe('running')
    expect(result.pubs[0]?.port).toBe(pub!.port)
  })
})

describe('pub_react', () => {
  it('reacts to a message without throwing', async () => {
    const ctx = await setup('hobby')
    const sent = await pubSend.execute({ content: 'hi' }, ctx)
    const result = await pubReact.execute({ message_id: sent.message_id, emoji: '👍' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.message_id).toBe(sent.message_id)
    expect(result.emoji).toBe('👍')
    expect(result.normalized).toBe(false)
    expect(result.requested_emoji).toBe('👍')
  })

  it('normalizes bare check `✓` to whitelist-allowed `✅`', async () => {
    const ctx = await setup('hobby')
    const sent = await pubSend.execute({ content: 'hi' }, ctx)
    const result = await pubReact.execute({ message_id: sent.message_id, emoji: '✓' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.emoji).toBe('✅')
    expect(result.requested_emoji).toBe('✓')
    expect(result.normalized).toBe(true)
  })

  it('normalizes heart variants to whitelist-allowed `🔥`', async () => {
    const ctx = await setup('hobby')
    const sent = await pubSend.execute({ content: 'hi' }, ctx)
    const result = await pubReact.execute({ message_id: sent.message_id, emoji: '❤️' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.emoji).toBe('🔥')
    expect(result.normalized).toBe(true)
  })
})

describe('multi-agent in the same pub', () => {
  it('alice sends a message; bob reads it', async () => {
    const aliceCtx = await setup('alice')

    // Register and credential bob too.
    const identityClient = createIdentityClient({ baseUrl: pub!.baseUrl })
    const credBob = generateKeypair({ display_name: 'bob', issuer_url: pub!.baseUrl })
    const updatedBob = await ensureRegistered(identityClient, credBob)
    await mkdir(agentPaths(home, 'bob').root, { recursive: true })
    await writeCredentialFile(agentPaths(home, 'bob').pubSecret, updatedBob)
    const bobCtx: ToolContext = {
      callingAgent: 'bob',
      home,
      brainDir: agentPaths(home, 'bob').brain,
      projectDir: agentPaths(home, 'bob').project,
      taskId: null,
      callId: 'call_bob',
    }

    await pubSend.execute({ content: 'hi from alice' }, aliceCtx)
    // Bob's first read pulls in cached messages from his own connect's room_state plus the broadcast.
    // Give the broadcast a tick to flow into Bob's PubClient's cache.
    await new Promise((r) => setTimeout(r, 100))
    const result = await pubRead.execute({ limit: 50 }, bobCtx)
    expect(result.messages.map((m) => m.content)).toContain('hi from alice')
  })
})
