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
import { generateKeypair } from '../../../src/runtime/pub/keypair.js'
import { PubWakeSource } from '../../../src/runtime/pub/wake-source.js'
import { TaskStore } from '../../../src/runtime/agent/task/store.js'
import { initHome, initAgentDirs } from '../../../src/runtime/storage/init.js'

let home: string
let pub: FakePub | undefined

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
    await new Promise((r) => setTimeout(r, 100))

    // Alice replies to it. Even without an @bob mention, rule 2 should fire.
    await alice.client.send({ content: 'thanks', in_reply_to: sent.message_id })
    await new Promise((r) => setTimeout(r, 100))

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
    await new Promise((r) => setTimeout(r, 100))

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
})
