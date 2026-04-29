/**
 * Integration tests for PubWakeSource (Epic 3 PR D).
 *
 * Spins up the fake pub-server, registers two agents (alice and bob),
 * connects bob's PubClient with a wake source attached, has alice send
 * messages from her own client, and asserts that bob's task store
 * received a synthetic `pub.handle` task only when the message is
 * `directed_to` him.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFakePub, type FakePub } from './fake-pub-server.js'
import { PubClient } from '../../../src/runtime/pub/client.js'
import { createIdentityClient, ensureRegistered } from '../../../src/runtime/pub/identity-client.js'
import { generateKeypair } from '../../../src/runtime/pub/keypair-generate.js'
import { PubWakeSource } from '../../../src/runtime/pub/wake-source.js'
import { Router } from '../../../src/runtime/pub/router.js'
import { upsertRosterEntry } from '../../../src/runtime/pub/roster.js'
import { TaskStore } from '../../../src/runtime/agent/task/store.js'
import { initHome, initAgentDirs } from '../../../src/runtime/storage/init.js'
import type { LLMProvider } from '../../../src/runtime/llm/provider.js'
import type { CompletionResponse } from '../../../src/runtime/llm/types.js'

let home: string
let pub: FakePub | undefined

/**
 * Poll until `predicate` returns true or the deadline elapses. Used in
 * place of fixed setTimeout waits so the suite is robust to slow CI
 * scheduling; locally it returns in ~10-30ms vs the old 100ms wait.
 */
async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`waitFor: condition not satisfied within ${String(timeoutMs)}ms`)
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-wake-'))
  await initHome(home)
})

afterEach(async () => {
  if (pub) {
    await pub.close()
    pub = undefined
  }
  await rm(home, { recursive: true, force: true })
})

interface AgentSetup {
  client: PubClient
  agentId: string
  taskStore: TaskStore
}

async function setupAgent(name: string): Promise<AgentSetup> {
  if (!pub) throw new Error('start pub first')
  const id = createIdentityClient({ baseUrl: pub.baseUrl })
  const cred = generateKeypair({ display_name: name, issuer_url: pub.baseUrl })
  const updated = await ensureRegistered(id, cred)
  const sourceIdentity = join(home, `${name}.identity.md`)
  await import('node:fs/promises').then((m) =>
    m.writeFile(
      sourceIdentity,
      '---\nschema_version: 1\n---\n# placeholder identity body for tests\n',
      'utf8',
    ),
  )
  await initAgentDirs(home, name, sourceIdentity)
  const client = new PubClient({ baseUrl: pub.baseUrl, cred: updated })
  await client.connect()
  const taskStore = new TaskStore(home, name)
  return { client, agentId: updated.agent_id!, taskStore }
}

describe('PubWakeSource', () => {
  it('enqueues a synthetic task when alice @-mentions bob', async () => {
    pub = await startFakePub()
    const alice = await setupAgent('alice')
    const bob = await setupAgent('bob')

    const wake = new PubWakeSource({
      client: bob.client,
      agentName: 'bob',
      pubName: 'ops',
      agent: { agent_id: bob.agentId, handle: '@bob' },
      taskStore: bob.taskStore,
    })
    wake.start()

    // Alice mentions bob explicitly via the mentions field.
    await alice.client.send({ content: 'hey @bob ping', mentions: [bob.agentId] })
    // Give the broadcast a tick to land in bob's wake handler.
    await new Promise((r) => setTimeout(r, 100))

    const tasks = await bob.taskStore.list()
    expect(tasks.length).toBe(1)
    expect(tasks[0]?.frontmatter.title).toContain('direct_mention')
    expect(tasks[0]?.frontmatter.state).toBe('pending')
    expect(tasks[0]?.body).toContain('Pub: ops')
    expect(tasks[0]?.body).toContain('Rule fired: direct_mention')

    wake.stop()
    await alice.client.close()
    await bob.client.close()
  })

  it('does not enqueue when alice sends a message NOT directed to bob', async () => {
    pub = await startFakePub()
    const alice = await setupAgent('alice')
    const bob = await setupAgent('bob')

    const wake = new PubWakeSource({
      client: bob.client,
      agentName: 'bob',
      pubName: 'ops',
      agent: { agent_id: bob.agentId, handle: '@bob' },
      taskStore: bob.taskStore,
    })
    wake.start()

    // Generic chatter, no mention, no reply, multi-member pub (alice, bob,
    // and the cap-3 member set means sole_recipient does not match either).
    // Add a third connected agent so sole_recipient is definitively false.
    const _third = await setupAgent('charlie')
    await alice.client.send({ content: 'just a status update' })
    await new Promise((r) => setTimeout(r, 100))

    const tasks = await bob.taskStore.list()
    expect(tasks.length).toBe(0)

    wake.stop()
    await alice.client.close()
    await bob.client.close()
    await _third.client.close()
  })

  it('rule 2 (reply_to_mine) fires when alice replies to bob', async () => {
    pub = await startFakePub()
    const alice = await setupAgent('alice')
    const bob = await setupAgent('bob')

    const wake = new PubWakeSource({
      client: bob.client,
      agentName: 'bob',
      pubName: 'ops',
      agent: { agent_id: bob.agentId, handle: '@bob' },
      taskStore: bob.taskStore,
    })
    wake.start()

    // Bob sends a message; the wake source records its message_id locally
    // (because bob.client also receives the broadcast of his own send).
    const sent = await bob.client.send({ content: 'first' })

    // Alice replies to it. Even without an @bob mention, rule 2 should fire.
    await alice.client.send({ content: 'thanks', in_reply_to: sent.message_id })
    await waitFor(async () => (await bob.taskStore.list()).length >= 1)

    const tasks = await bob.taskStore.list()
    expect(tasks.length).toBe(1)
    expect(tasks[0]?.frontmatter.title).toContain('reply_to_mine')

    wake.stop()
    await alice.client.close()
    await bob.client.close()
  })

  it('rule 5 (domain_match) fires when content matches an Identity domain', async () => {
    pub = await startFakePub()
    const alice = await setupAgent('alice')
    // Add a third agent so sole_recipient (rule 3) does not preempt
    // domain_match (rule 5).
    const _third = await setupAgent('charlie')
    const carl = await setupAgent('carl')

    const wake = new PubWakeSource({
      client: carl.client,
      agentName: 'carl',
      pubName: 'ops',
      agent: {
        agent_id: carl.agentId,
        handle: '@carl',
        domains: ['weather arb'],
      },
      taskStore: carl.taskStore,
    })
    wake.start()

    await alice.client.send({ content: 'New WEATHER ARB tonight, KORD METAR coming up' })
    await waitFor(async () => (await carl.taskStore.list()).length >= 1)

    const tasks = await carl.taskStore.list()
    expect(tasks.length).toBe(1)
    expect(tasks[0]?.frontmatter.title).toContain('domain_match')

    wake.stop()
    await alice.client.close()
    await carl.client.close()
    await _third.client.close()
  })

  it('stop() unsubscribes; subsequent messages do not enqueue', async () => {
    pub = await startFakePub()
    const alice = await setupAgent('alice')
    const bob = await setupAgent('bob')

    const wake = new PubWakeSource({
      client: bob.client,
      agentName: 'bob',
      pubName: 'ops',
      agent: { agent_id: bob.agentId, handle: '@bob' },
      taskStore: bob.taskStore,
    })
    wake.start()
    await alice.client.send({ content: '@bob first', mentions: [bob.agentId] })
    await new Promise((r) => setTimeout(r, 100))
    expect((await bob.taskStore.list()).length).toBe(1)

    wake.stop()
    await alice.client.send({ content: '@bob second', mentions: [bob.agentId] })
    await new Promise((r) => setTimeout(r, 100))
    expect((await bob.taskStore.list()).length).toBe(1) // unchanged

    await alice.client.close()
    await bob.client.close()
  })

  it("does not wake on bob's own messages (skip-self check)", async () => {
    pub = await startFakePub()
    const bob = await setupAgent('bob')

    const wake = new PubWakeSource({
      client: bob.client,
      agentName: 'bob',
      pubName: 'ops',
      agent: { agent_id: bob.agentId, handle: '@bob' },
      taskStore: bob.taskStore,
    })
    wake.start()

    // Bob sends a message that mentions himself. That should NOT wake.
    await bob.client.send({ content: '@bob testing', mentions: [bob.agentId] })
    await new Promise((r) => setTimeout(r, 100))

    const tasks = await bob.taskStore.list()
    expect(tasks.length).toBe(0)

    wake.stop()
    await bob.client.close()
  })

  // ---------------------------------------------------------------------------
  // Ambient routing (Epic 3.6 PR K)
  // ---------------------------------------------------------------------------

  function fakeProviderReturning(text: string): LLMProvider {
    return {
      name: 'fake',
      baseUrl: 'fake://',
      complete(): Promise<CompletionResponse> {
        return Promise.resolve({
          text,
          finishReason: 'stop',
          costMetrics: { inputTokens: 1, outputTokens: 1 },
          providerResponseId: 'fake',
        })
      },
    }
  }

  it('falls back to the router when no deterministic rule fires and the router picks bob', async () => {
    pub = await startFakePub()
    const alice = await setupAgent('alice')
    const _third = await setupAgent('charlie')
    const bob = await setupAgent('bob')

    // Persist a roster entry for bob so the router has a candidate.
    await upsertRosterEntry(home, 'ops', {
      agent_id: bob.agentId,
      agent_name: 'bob',
      display_name: 'bob',
      role_blurb: 'devops, hosts deploys',
    })
    await upsertRosterEntry(home, 'ops', {
      agent_id: _third.agentId,
      agent_name: 'charlie',
      display_name: 'charlie',
      role_blurb: 'unrelated',
    })

    const router = new Router({
      provider: fakeProviderReturning(
        `{"woken_agent_ids": ["${bob.agentId}"], "rationale": "ops question"}`,
      ),
      modelId: 'fast',
    })

    const wake = new PubWakeSource({
      client: bob.client,
      agentName: 'bob',
      pubName: 'ops',
      agent: { agent_id: bob.agentId, handle: '@bob' },
      taskStore: bob.taskStore,
      router,
      home,
    })
    wake.start()

    // Generic chatter, no @-mention, no reply, > 2 members so
    // sole_recipient does not match. With the router on, bob should
    // wake because the router named him.
    await alice.client.send({ content: 'who can talk to me about deploys?' })
    await waitFor(async () => (await bob.taskStore.list()).length >= 1)

    const tasks = await bob.taskStore.list()
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.frontmatter.title).toContain('router')

    wake.stop()
    await alice.client.close()
    await bob.client.close()
    await _third.client.close()
  })

  it('does not wake when the router picks someone else', async () => {
    pub = await startFakePub()
    const alice = await setupAgent('alice')
    const _third = await setupAgent('charlie')
    const bob = await setupAgent('bob')

    await upsertRosterEntry(home, 'ops', {
      agent_id: _third.agentId,
      agent_name: 'charlie',
      display_name: 'charlie',
      role_blurb: 'unrelated',
    })

    const router = new Router({
      provider: fakeProviderReturning(
        `{"woken_agent_ids": ["${_third.agentId}"], "rationale": "for charlie"}`,
      ),
      modelId: 'fast',
    })

    const wake = new PubWakeSource({
      client: bob.client,
      agentName: 'bob',
      pubName: 'ops',
      agent: { agent_id: bob.agentId, handle: '@bob' },
      taskStore: bob.taskStore,
      router,
      home,
    })
    wake.start()

    await alice.client.send({ content: 'an unrelated message' })
    await new Promise((r) => setTimeout(r, 200))

    expect((await bob.taskStore.list()).length).toBe(0)

    wake.stop()
    await alice.client.close()
    await bob.client.close()
    await _third.client.close()
  })

  it('skips the router entirely when a deterministic rule fires (no extra LLM cost)', async () => {
    pub = await startFakePub()
    const alice = await setupAgent('alice')
    const bob = await setupAgent('bob')

    let routerCalls = 0
    const router = new Router({
      provider: {
        name: 'fake',
        baseUrl: 'fake://',
        complete(): Promise<CompletionResponse> {
          routerCalls += 1
          return Promise.resolve({
            text: '{"woken_agent_ids": []}',
            finishReason: 'stop',
            costMetrics: { inputTokens: 1, outputTokens: 1 },
            providerResponseId: 'fake',
          })
        },
      },
      modelId: 'fast',
    })

    const wake = new PubWakeSource({
      client: bob.client,
      agentName: 'bob',
      pubName: 'ops',
      agent: { agent_id: bob.agentId, handle: '@bob' },
      taskStore: bob.taskStore,
      router,
      home,
    })
    wake.start()

    // Direct mention fires rule 1; router must NOT be consulted.
    await alice.client.send({ content: 'hey @bob ping', mentions: [bob.agentId] })
    await waitFor(async () => (await bob.taskStore.list()).length >= 1)

    expect(routerCalls).toBe(0)
    expect(await bob.taskStore.list()).toHaveLength(1)

    wake.stop()
    await alice.client.close()
    await bob.client.close()
  })

  it('skips the router when the message comes from another Agent (anti-ack-spiral guard)', async () => {
    // Doug's diagnostic: a chain of "noted / standing by / ack" between
    // Agents was draining time + tokens. Cure is structural... when an
    // Agent posts, the router must not run. Only @-mentions wake.
    pub = await startFakePub()
    const alice = await setupAgent('alice') // sender; will be in roster
    const _third = await setupAgent('charlie')
    const bob = await setupAgent('bob') // listener

    // Register all three in the roster, including alice. This makes
    // alice an "Agent sender" from bob's wake-source perspective.
    await upsertRosterEntry(home, 'ops', {
      agent_id: alice.agentId,
      agent_name: 'alice',
      display_name: 'alice',
      role_blurb: 'random other agent',
    })
    await upsertRosterEntry(home, 'ops', {
      agent_id: bob.agentId,
      agent_name: 'bob',
      display_name: 'bob',
      role_blurb: 'devops',
    })
    await upsertRosterEntry(home, 'ops', {
      agent_id: _third.agentId,
      agent_name: 'charlie',
      display_name: 'charlie',
      role_blurb: 'unrelated',
    })

    let routerCalls = 0
    const router = new Router({
      provider: {
        name: 'fake',
        baseUrl: 'fake://',
        complete(): Promise<CompletionResponse> {
          routerCalls += 1
          return Promise.resolve({
            text: `{"woken_agent_ids": ["${bob.agentId}"], "rationale": "would have woken"}`,
            finishReason: 'stop',
            costMetrics: { inputTokens: 1, outputTokens: 1 },
            providerResponseId: 'fake',
          })
        },
      },
      modelId: 'fast',
    })

    const wake = new PubWakeSource({
      client: bob.client,
      agentName: 'bob',
      pubName: 'ops',
      agent: { agent_id: bob.agentId, handle: '@bob' },
      taskStore: bob.taskStore,
      router,
      home,
    })
    wake.start()

    // alice (an Agent in the roster) posts a generic message bob would
    // have woken on if it came from a human. Router must not be
    // consulted; bob must not wake.
    await alice.client.send({ content: 'noted, standing by' })
    await new Promise((r) => setTimeout(r, 200))

    expect(routerCalls).toBe(0)
    expect((await bob.taskStore.list()).length).toBe(0)

    wake.stop()
    await alice.client.close()
    await bob.client.close()
    await _third.client.close()
  })

  it('skips the router when the message @-mentions other Agents but not this one', async () => {
    // Diagnostic: Doug said "@simon, earlier I asked..." and Hobby
    // still woke via router despite the explicit @simon target. The
    // explicit address signal must override ambient routing.
    pub = await startFakePub()
    const alice = await setupAgent('alice') // human stand-in: NOT in roster
    const _third = await setupAgent('charlie') // explicitly addressed
    const bob = await setupAgent('bob') // listener that should NOT wake

    await upsertRosterEntry(home, 'ops', {
      agent_id: bob.agentId,
      agent_name: 'bob',
      display_name: 'bob',
      role_blurb: 'devops',
    })
    await upsertRosterEntry(home, 'ops', {
      agent_id: _third.agentId,
      agent_name: 'charlie',
      display_name: 'charlie',
      role_blurb: 'product',
    })

    let routerCalls = 0
    const router = new Router({
      provider: {
        name: 'fake',
        baseUrl: 'fake://',
        complete(): Promise<CompletionResponse> {
          routerCalls += 1
          return Promise.resolve({
            text: `{"woken_agent_ids": ["${bob.agentId}"], "rationale": "would have woken"}`,
            finishReason: 'stop',
            costMetrics: { inputTokens: 1, outputTokens: 1 },
            providerResponseId: 'fake',
          })
        },
      },
      modelId: 'fast',
    })

    const wake = new PubWakeSource({
      client: bob.client,
      agentName: 'bob',
      pubName: 'ops',
      agent: { agent_id: bob.agentId, handle: '@bob' },
      taskStore: bob.taskStore,
      router,
      home,
    })
    wake.start()

    // alice (human stand-in) explicitly @-mentions charlie. Bob is
    // NOT mentioned. Router must not be consulted; bob must not wake.
    await alice.client.send({
      content: '@charlie give me the bullet points please',
      mentions: [_third.agentId],
    })
    await new Promise((r) => setTimeout(r, 200))

    expect(routerCalls).toBe(0)
    expect((await bob.taskStore.list()).length).toBe(0)

    wake.stop()
    await alice.client.close()
    await bob.client.close()
    await _third.client.close()
  })

  it('still wakes on a direct @-mention from another Agent (the escape hatch survives)', async () => {
    pub = await startFakePub()
    const alice = await setupAgent('alice')
    const bob = await setupAgent('bob')

    // alice is in the roster so she counts as an Agent sender.
    await upsertRosterEntry(home, 'ops', {
      agent_id: alice.agentId,
      agent_name: 'alice',
      display_name: 'alice',
      role_blurb: 'other agent',
    })

    const wake = new PubWakeSource({
      client: bob.client,
      agentName: 'bob',
      pubName: 'ops',
      agent: { agent_id: bob.agentId, handle: '@bob' },
      taskStore: bob.taskStore,
      home,
    })
    wake.start()

    // Direct @-mention from another Agent... rule 1 fires regardless.
    await alice.client.send({ content: 'hey @bob ping', mentions: [bob.agentId] })
    await waitFor(async () => (await bob.taskStore.list()).length >= 1)

    expect((await bob.taskStore.list()).length).toBe(1)

    wake.stop()
    await alice.client.close()
    await bob.client.close()
  })
})
