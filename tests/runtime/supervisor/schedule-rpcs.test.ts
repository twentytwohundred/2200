/**
 * Tests for cli.schedule.* supervisor RPCs (Epic 6 PR C).
 *
 * Each test spins up a real supervisor on a UDS socket and invokes
 * the RPC through a real client; assertions then read the on-disk
 * schedule files and the Agent's TaskStore.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Supervisor } from '../../../src/runtime/supervisor/supervisor.js'
import { JsonRpcClient } from '../../../src/runtime/control-plane/client.js'
import { connectUds } from '../../../src/runtime/control-plane/transport-uds.js'
import { listSchedules, readSchedule } from '../../../src/runtime/scheduler/schedule.js'
import { TaskStore } from '../../../src/runtime/agent/task/store.js'

async function writeIdentity(dir: string, name: string): Promise<string> {
  const path = join(dir, `${name}.identity.md`)
  const content = `---
schema_version: 1
agent_name: ${name}
agent_role: "test agent"
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
Test agent.
`
  await writeFile(path, content, 'utf8')
  return path
}

let home: string
let supervisor: Supervisor | undefined
let client: JsonRpcClient | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-sched-rpc-'))
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

async function setupAgent(name: string): Promise<void> {
  supervisor = await Supervisor.create({ home })
  await supervisor.start()
  const idPath = await writeIdentity(home, name)
  await supervisor.createAgent(name, idPath)
  const conn = await connectUds(Supervisor.socketPath(home))
  client = new JsonRpcClient(conn)
}

describe('cli.schedule.add', () => {
  it('persists an interval schedule and returns next_fire_at', async () => {
    await setupAgent('hobby')
    const r = await client!.call('cli.schedule.add', {
      agent: 'hobby',
      prompt: 'check inbox',
      timing: { kind: 'interval', interval_seconds: 60 },
    })
    expect(r.ok).toBe(true)
    expect(r.id).toMatch(/^sched_/)
    expect(r.next_fire_at).not.toBeNull()

    const list = await listSchedules(home, 'hobby')
    expect(list).toHaveLength(1)
    expect(list[0]!.timing).toEqual({ kind: 'interval', interval_seconds: 60 })
    expect(list[0]!.prompt).toBe('check inbox')
    expect(list[0]!.enabled).toBe(true)
  })

  it('persists a cron schedule', async () => {
    await setupAgent('hobby')
    const r = await client!.call('cli.schedule.add', {
      agent: 'hobby',
      prompt: 'morning sweep',
      timing: { kind: 'cron', expression: '0 9 * * *', timezone: 'UTC' },
      description: 'morning sweep',
    })
    expect(r.ok).toBe(true)
    const entry = await readSchedule(home, 'hobby', r.id)
    expect(entry.timing.kind).toBe('cron')
    expect(entry.description).toBe('morning sweep')
  })

  it('rejects an invalid cron expression', async () => {
    await setupAgent('hobby')
    await expect(
      client!.call('cli.schedule.add', {
        agent: 'hobby',
        prompt: 'p',
        timing: { kind: 'cron', expression: 'not a cron', timezone: 'UTC' },
      }),
    ).rejects.toThrow(/invalid cron/i)
  })

  it('errors when the Agent does not exist', async () => {
    supervisor = await Supervisor.create({ home })
    await supervisor.start()
    const conn = await connectUds(Supervisor.socketPath(home))
    client = new JsonRpcClient(conn)
    await expect(
      client.call('cli.schedule.add', {
        agent: 'no-such',
        prompt: 'p',
        timing: { kind: 'interval', interval_seconds: 60 },
      }),
    ).rejects.toThrow(/no Agent record/)
  })
})

describe('cli.schedule.list', () => {
  it('returns [] when no schedules exist', async () => {
    await setupAgent('hobby')
    const r = await client!.call('cli.schedule.list', {})
    expect(r.entries).toEqual([])
  })

  it('lists across all Agents when no agent is specified', async () => {
    await setupAgent('hobby')
    const idPath2 = await writeIdentity(home, 'simon')
    await supervisor!.createAgent('simon', idPath2)
    await client!.call('cli.schedule.add', {
      agent: 'hobby',
      prompt: 'h',
      timing: { kind: 'interval', interval_seconds: 60 },
    })
    await client!.call('cli.schedule.add', {
      agent: 'simon',
      prompt: 's',
      timing: { kind: 'interval', interval_seconds: 60 },
    })
    const r = await client!.call('cli.schedule.list', {})
    const agents = r.entries.map((e) => e.agent).sort()
    expect(agents).toEqual(['hobby', 'simon'])
  })

  it('filters by agent when supplied', async () => {
    await setupAgent('hobby')
    const idPath2 = await writeIdentity(home, 'simon')
    await supervisor!.createAgent('simon', idPath2)
    await client!.call('cli.schedule.add', {
      agent: 'hobby',
      prompt: 'h',
      timing: { kind: 'interval', interval_seconds: 60 },
    })
    await client!.call('cli.schedule.add', {
      agent: 'simon',
      prompt: 's',
      timing: { kind: 'interval', interval_seconds: 60 },
    })
    const r = await client!.call('cli.schedule.list', { agent: 'hobby' })
    expect(r.entries.map((e) => e.agent)).toEqual(['hobby'])
  })
})

describe('cli.schedule.remove', () => {
  it('deletes a persisted schedule', async () => {
    await setupAgent('hobby')
    const added = await client!.call('cli.schedule.add', {
      agent: 'hobby',
      prompt: 'p',
      timing: { kind: 'interval', interval_seconds: 60 },
    })
    await client!.call('cli.schedule.remove', { agent: 'hobby', id: added.id })
    expect(await listSchedules(home, 'hobby')).toHaveLength(0)
  })

  it('is idempotent when the schedule does not exist', async () => {
    await setupAgent('hobby')
    await expect(
      client!.call('cli.schedule.remove', { agent: 'hobby', id: 'sched_missing' }),
    ).resolves.toEqual({ ok: true })
  })
})

describe('cli.schedule.set-enabled', () => {
  it('disabling clears next_fire_at; re-enabling recomputes it', async () => {
    await setupAgent('hobby')
    const added = await client!.call('cli.schedule.add', {
      agent: 'hobby',
      prompt: 'p',
      timing: { kind: 'interval', interval_seconds: 60 },
    })
    const dis = await client!.call('cli.schedule.set-enabled', {
      agent: 'hobby',
      id: added.id,
      enabled: false,
    })
    expect(dis.next_fire_at).toBeNull()
    const stored = await readSchedule(home, 'hobby', added.id)
    expect(stored.enabled).toBe(false)

    const en = await client!.call('cli.schedule.set-enabled', {
      agent: 'hobby',
      id: added.id,
      enabled: true,
    })
    expect(en.next_fire_at).not.toBeNull()
  })
})

describe('cli.schedule.run-once', () => {
  it('enqueues a synthetic task without updating last_fired_at', async () => {
    await setupAgent('hobby')
    const added = await client!.call('cli.schedule.add', {
      agent: 'hobby',
      prompt: 'check inbox now',
      description: 'inbox-sweep',
      timing: { kind: 'interval', interval_seconds: 60 },
    })
    const r = await client!.call('cli.schedule.run-once', {
      agent: 'hobby',
      id: added.id,
    })
    expect(r.task_id).toMatch(/^task_/)
    const taskStore = new TaskStore(home, 'hobby')
    const tasks = await taskStore.list()
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.body.trim()).toBe('check inbox now')
    expect(tasks[0]!.frontmatter.title).toBe('inbox-sweep')

    const stored = await readSchedule(home, 'hobby', added.id)
    expect(stored.last_fired_at).toBeNull()
  })

  it('errors when the schedule does not exist', async () => {
    await setupAgent('hobby')
    await expect(
      client!.call('cli.schedule.run-once', { agent: 'hobby', id: 'sched_missing' }),
    ).rejects.toThrow()
  })
})
