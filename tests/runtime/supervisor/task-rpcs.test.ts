/**
 * Tests for the task-related supervisor RPCs.
 *
 * Covers cli.task.submit, cli.task.list, and cli.agent.resume. Each test
 * spins up a real supervisor with real UDS, submits via RPC, and asserts
 * the on-disk task store reflects the change.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Supervisor } from '../../../src/runtime/supervisor/supervisor.js'
import { JsonRpcClient } from '../../../src/runtime/control-plane/client.js'
import { connectUds } from '../../../src/runtime/control-plane/uds-client.js'
import { TaskStore } from '../../../src/runtime/agent/task/store.js'
import { agentPaths } from '../../../src/runtime/storage/layout.js'

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
  home = await mkdtemp(join(tmpdir(), '2200-task-rpc-'))
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

describe('cli.task.submit', () => {
  it('writes a task to the agent task store and returns the task id', async () => {
    await setupAgent('hobby')
    const result = await client!.call('cli.task.submit', {
      agent: 'hobby',
      title: 'a quick test',
      body: 'do the thing',
    })
    expect(result.ok).toBe(true)
    expect(result.task_id).toMatch(/^task_/)

    const store = new TaskStore(home, 'hobby')
    const task = await store.get(result.task_id)
    expect(task).not.toBeNull()
    expect(task?.frontmatter.title).toBe('a quick test')
    expect(task?.frontmatter.state).toBe('pending')
    expect(task?.frontmatter.idempotency).toBe('pure')
    expect(task?.body.trim()).toBe('do the thing')
  })

  it('respects idempotency and priority overrides', async () => {
    await setupAgent('hobby')
    const result = await client!.call('cli.task.submit', {
      agent: 'hobby',
      title: 'destructive job',
      body: 'send the email',
      idempotency: 'destructive',
      priority: 7,
    })
    const store = new TaskStore(home, 'hobby')
    const task = await store.get(result.task_id)
    expect(task?.frontmatter.idempotency).toBe('destructive')
    expect(task?.frontmatter.priority).toBe(7)
  })

  it('errors when the agent does not exist', async () => {
    supervisor = await Supervisor.create({ home })
    await supervisor.start()
    const conn = await connectUds(Supervisor.socketPath(home))
    client = new JsonRpcClient(conn)
    await expect(
      client.call('cli.task.submit', { agent: 'no-such', title: 't', body: 'b' }),
    ).rejects.toThrow(/no Agent record/)
  })
})

describe('cli.task.list', () => {
  it('returns an empty array when no tasks exist', async () => {
    await setupAgent('hobby')
    const result = await client!.call('cli.task.list', { agent: 'hobby' })
    expect(result.agent).toBe('hobby')
    expect(result.tasks).toEqual([])
  })

  it('returns submitted tasks with their state and metadata', async () => {
    await setupAgent('hobby')
    await client!.call('cli.task.submit', { agent: 'hobby', title: 'first', body: 'one' })
    await client!.call('cli.task.submit', {
      agent: 'hobby',
      title: 'second',
      body: 'two',
      priority: 3,
    })
    const result = await client!.call('cli.task.list', { agent: 'hobby' })
    expect(result.tasks.length).toBe(2)
    const titles = result.tasks.map((t) => t.title).sort()
    expect(titles).toEqual(['first', 'second'])
    for (const t of result.tasks) {
      expect(t.state).toBe('pending')
      expect(t.detector_block_kind).toBeNull()
      expect(t.detector_block_detail).toBeNull()
    }
  })

  it('errors on unknown agent', async () => {
    supervisor = await Supervisor.create({ home })
    await supervisor.start()
    const conn = await connectUds(Supervisor.socketPath(home))
    client = new JsonRpcClient(conn)
    await expect(client.call('cli.task.list', { agent: 'no-such' })).rejects.toThrow(
      /no Agent record/,
    )
  })
})

describe('cli.agent.resume', () => {
  it('flips a blocked_on_detector task back to pending and clears pulse', async () => {
    await setupAgent('hobby')
    // Submit a task, then mutate the store directly to simulate a detector
    // trip (the loop is tested elsewhere; here we just verify the resume
    // RPC behavior).
    const submit = await client!.call('cli.task.submit', {
      agent: 'hobby',
      title: 'will be blocked',
      body: 'b',
    })
    const store = new TaskStore(home, 'hobby')
    await store.update(submit.task_id, (fm) => ({
      ...fm,
      state: 'blocked_on_detector',
      detector_block: {
        trip_id: 'trip_test',
        kind: 'tool_repetition',
        detail: 'simulated',
        at: '2026-04-26T22:00:00Z',
      },
    }))

    const result = await client!.call('cli.agent.resume', { name: 'hobby' })
    expect(result.ok).toBe(true)
    expect(result.resumed_task_id).toBe(submit.task_id)

    const after = await store.get(submit.task_id)
    expect(after?.frontmatter.state).toBe('pending')
    expect(after?.frontmatter.detector_block).toBeNull()

    const pulsePath = join(agentPaths(home, 'hobby').root, 'pulse.json')
    const pulse = JSON.parse(await readFile(pulsePath, 'utf8')) as Record<string, unknown>
    expect(pulse['state']).toBe('resting')
  })

  it('returns null resumed_task_id when no task is blocked', async () => {
    await setupAgent('hobby')
    const result = await client!.call('cli.agent.resume', { name: 'hobby' })
    expect(result.ok).toBe(true)
    expect(result.resumed_task_id).toBeNull()
    const pulsePath = join(agentPaths(home, 'hobby').root, 'pulse.json')
    const pulse = JSON.parse(await readFile(pulsePath, 'utf8')) as Record<string, unknown>
    expect(pulse['state']).toBe('resting')
  })

  it('errors on unknown agent', async () => {
    supervisor = await Supervisor.create({ home })
    await supervisor.start()
    const conn = await connectUds(Supervisor.socketPath(home))
    client = new JsonRpcClient(conn)
    await expect(client.call('cli.agent.resume', { name: 'no-such' })).rejects.toThrow(
      /no Agent record/,
    )
  })
})
