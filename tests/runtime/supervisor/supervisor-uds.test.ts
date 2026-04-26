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
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Supervisor } from '../../../src/runtime/supervisor/supervisor.js'
import { JsonRpcClient } from '../../../src/runtime/control-plane/client.js'
import { connectUds } from '../../../src/runtime/control-plane/transport-uds.js'

let stateDir: string
let supervisor: Supervisor | undefined
let client: JsonRpcClient | undefined

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), '2200-supervisor-uds-'))
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
  await rm(stateDir, { recursive: true, force: true })
})

describe('Supervisor over real UDS', () => {
  it('responds to state.snapshot with the empty state on first boot', async () => {
    supervisor = await Supervisor.create({ stateDir })
    await supervisor.start()
    const conn = await connectUds(Supervisor.socketPath(stateDir))
    client = new JsonRpcClient(conn)
    const snap = await client.call('state.snapshot', {})
    expect(snap.schema_version).toBe('0.1')
    expect(snap.state_dir).toBe(stateDir)
    expect(snap.agents).toEqual({})
  })

  it('registers an Agent and updates its record', async () => {
    supervisor = await Supervisor.create({ stateDir })
    await supervisor.createAgent('hobby', '/tmp/identity.md')
    await supervisor.start()

    const conn = await connectUds(Supervisor.socketPath(stateDir))
    client = new JsonRpcClient(conn)

    const reg = await client.call('agent.register', { name: 'hobby', pid: 9999 })
    expect(reg.accepted).toBe(true)

    const snap = await client.call('state.snapshot', {})
    expect(snap.agents['hobby']?.state).toBe('running')
    expect(snap.agents['hobby']?.pid).toBe(9999)
  })

  it('rejects registration of an unknown Agent', async () => {
    supervisor = await Supervisor.create({ stateDir })
    await supervisor.start()
    const conn = await connectUds(Supervisor.socketPath(stateDir))
    client = new JsonRpcClient(conn)
    const reg = await client.call('agent.register', { name: 'ghost', pid: 1 })
    expect(reg.accepted).toBe(false)
    expect(reg.reason).toContain('no Agent record')
  })

  it('updates state via agent.heartbeat', async () => {
    supervisor = await Supervisor.create({ stateDir })
    await supervisor.createAgent('hobby', '/tmp/identity.md')
    await supervisor.start()

    const conn = await connectUds(Supervisor.socketPath(stateDir))
    client = new JsonRpcClient(conn)
    await client.call('agent.register', { name: 'hobby', pid: 1234 })

    const ack = await client.call('agent.heartbeat', { state: 'waiting' })
    expect(ack.ack).toBe(true)

    const snap = await client.call('state.snapshot', {})
    expect(snap.agents['hobby']?.state).toBe('waiting')
    expect(snap.agents['hobby']?.last_heartbeat).toBeTruthy()
  })

  it('shutdown removes the socket file', async () => {
    supervisor = await Supervisor.create({ stateDir })
    await supervisor.start()
    const path = Supervisor.socketPath(stateDir)
    await access(path)
    await supervisor.shutdown()
    supervisor = undefined
    await expect(access(path)).rejects.toThrow()
  })
})
