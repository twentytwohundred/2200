/**
 * Integration test: real Supervisor + real JsonRpcClient over real UDS.
 *
 * Spins up a Supervisor in-process (no Agent processes spawned), connects a
 * JsonRpcClient via UDS, and exercises:
 *  - state.snapshot returns the right shape
 *  - agent.register on a known Agent record marks it running
 *  - agent.heartbeat updates state
 *  - state.snapshot reflects the changes
 *  - shutdown cleans up the socket file
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Supervisor } from '../../../src/runtime/supervisor/supervisor.js'
import { JsonRpcClient } from '../../../src/runtime/control-plane/client.js'
import { connectUds } from '../../../src/runtime/control-plane/transport-uds.js'

/**
 * Write a minimal-but-valid Identity to a tmpfile and return its path.
 * The supervisor's createAgent now validates Identities at create time;
 * tests that exercise create paths need a real on-disk Identity.
 */
async function writeIdentity(dir: string, name: string): Promise<string> {
  const path = join(dir, `${name}.identity.md`)
  const content = `---
schema_version: 1
agent_name: ${name}
agent_role: "test agent for supervisor-uds suite"
model:
  tier: frontier
  provider: anthropic
  model_id: claude-opus-4-7
tools: []
project_dir: /tmp/${name}/project
brain_dir: /tmp/${name}/brain
created: 2026-04-26
---

# Identity

Test agent body.
`
  await writeFile(path, content, 'utf8')
  return path
}

let home: string
let supervisor: Supervisor | undefined
let client: JsonRpcClient | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-supervisor-uds-'))
})

afterEach(async () => {
  if (client) {
    try {
      await client.close()
    } catch {
      // ignore
    }
    client = undefined
  }
  if (supervisor) {
    await supervisor.shutdown()
    supervisor = undefined
  }
  await rm(home, { recursive: true, force: true })
})

describe('Supervisor over real UDS', () => {
  it('responds to state.snapshot with the empty state on first boot', async () => {
    supervisor = await Supervisor.create({ home })
    await supervisor.start()
    const conn = await connectUds(Supervisor.socketPath(home))
    client = new JsonRpcClient(conn)
    const snap = await client.call('state.snapshot', {})
    expect(snap.schema_version).toBe(1)
    expect(snap.home).toBe(home)
    expect(snap.state_dir).toBe(join(home, 'state'))
    expect(snap.agents).toEqual({})
  })

  it('registers an Agent and updates its record', async () => {
    supervisor = await Supervisor.create({ home })
    const identity = await writeIdentity(home, 'hobby')
    await supervisor.createAgent('hobby', identity)
    await supervisor.start()

    const conn = await connectUds(Supervisor.socketPath(home))
    client = new JsonRpcClient(conn)

    const reg = await client.call('agent.register', { name: 'hobby', pid: 9999 })
    expect(reg.accepted).toBe(true)

    const snap = await client.call('state.snapshot', {})
    expect(snap.agents['hobby']?.state).toBe('running')
    expect(snap.agents['hobby']?.pid).toBe(9999)
  })

  it('rejects registration of an unknown Agent', async () => {
    supervisor = await Supervisor.create({ home })
    await supervisor.start()
    const conn = await connectUds(Supervisor.socketPath(home))
    client = new JsonRpcClient(conn)
    const reg = await client.call('agent.register', { name: 'ghost', pid: 1 })
    expect(reg.accepted).toBe(false)
    expect(reg.reason).toContain('no Agent record')
  })

  it('updates state via agent.heartbeat', async () => {
    supervisor = await Supervisor.create({ home })
    const identity = await writeIdentity(home, 'hobby')
    await supervisor.createAgent('hobby', identity)
    await supervisor.start()

    const conn = await connectUds(Supervisor.socketPath(home))
    client = new JsonRpcClient(conn)
    await client.call('agent.register', { name: 'hobby', pid: 1234 })

    const ack = await client.call('agent.heartbeat', { state: 'waiting' })
    expect(ack.ack).toBe(true)

    const snap = await client.call('state.snapshot', {})
    expect(snap.agents['hobby']?.state).toBe('waiting')
    expect(snap.agents['hobby']?.last_heartbeat).toBeTruthy()
  })

  it('shutdown removes the socket file', async () => {
    supervisor = await Supervisor.create({ home })
    await supervisor.start()
    const path = Supervisor.socketPath(home)
    await access(path)
    await supervisor.shutdown()
    supervisor = undefined
    await expect(access(path)).rejects.toThrow()
  })
})

describe('CLI-facing RPC methods over real UDS', () => {
  it('cli.agent.create registers an Agent record', async () => {
    supervisor = await Supervisor.create({ home })
    await supervisor.start()
    const conn = await connectUds(Supervisor.socketPath(home))
    client = new JsonRpcClient(conn)

    const identity = await writeIdentity(home, 'hobby')
    const result = await client.call('cli.agent.create', {
      name: 'hobby',
      identity_path: identity,
    })
    expect(result.ok).toBe(true)

    const snap = await client.call('state.snapshot', {})
    // After PR #8, the supervisor copies the Identity into the canonical
    // location at <home>/agents/<name>/identity.md and stores THAT as
    // identity_path; the source path is no longer the source of truth.
    expect(snap.agents['hobby']?.identity_path).toBe(join(home, 'agents', 'hobby', 'identity.md'))
    expect(snap.agents['hobby']?.state).toBe('stopped')
  })

  it('cli.agent.create rejects a duplicate name', async () => {
    supervisor = await Supervisor.create({ home })
    const identityA = await writeIdentity(home, 'hobby')
    await supervisor.createAgent('hobby', identityA)
    await supervisor.start()
    const conn = await connectUds(Supervisor.socketPath(home))
    client = new JsonRpcClient(conn)
    await expect(
      client.call('cli.agent.create', { name: 'hobby', identity_path: identityA }),
    ).rejects.toThrow(/already exists/)
  })

  it('cli.agent.create rejects a malformed Identity', async () => {
    supervisor = await Supervisor.create({ home })
    await supervisor.start()
    const conn = await connectUds(Supervisor.socketPath(home))
    client = new JsonRpcClient(conn)
    // Identity does not exist on disk
    await expect(
      client.call('cli.agent.create', {
        name: 'ghost',
        identity_path: join(home, 'nonexistent.identity.md'),
      }),
    ).rejects.toThrow(/could not read Identity/)
  })

  it('cli.agent.stop on an unknown agent updates state to stopped', async () => {
    supervisor = await Supervisor.create({ home })
    const identity = await writeIdentity(home, 'hobby')
    await supervisor.createAgent('hobby', identity)
    await supervisor.start()
    const conn = await connectUds(Supervisor.socketPath(home))
    client = new JsonRpcClient(conn)
    // hobby was never started; cli.agent.stop should still mark it stopped.
    const result = await client.call('cli.agent.stop', { name: 'hobby', reason: 'test' })
    expect(result.ok).toBe(true)
    const snap = await client.call('state.snapshot', {})
    expect(snap.agents['hobby']?.state).toBe('stopped')
  })
})
