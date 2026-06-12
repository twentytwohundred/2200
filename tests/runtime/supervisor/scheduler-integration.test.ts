/**
 * End-to-end integration tests for the Scheduler against a real Supervisor.
 *
 * The unit tests in tests/runtime/scheduler/ cover the Scheduler in
 * isolation against a fake timer factory; these tests exercise the
 * complete supervisor + scheduler stack with real timers and the
 * actual on-disk schedule layout, covering:
 *
 *   - A short interval schedule fires through the supervisor's
 *     Scheduler instance and the synthetic task lands in the
 *     Agent's TaskStore.
 *   - Supervisor restart: schedules persisted by one Supervisor
 *     are picked up and re-armed by a fresh Supervisor instance.
 *   - reload() is implicit: a schedule added through the running
 *     RPC arms a timer immediately (no restart needed).
 *
 * Real-timer tests use 5s intervals (the schedule minimum) and
 * actual setTimeout, so they run for a few seconds. They are
 * gated on a fast IO test environment; if the suite is flaky on
 * CI we'll switch the supervisor's Scheduler to a test-injectable
 * timer factory in a follow-up.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Supervisor } from '../../../src/runtime/supervisor/supervisor.js'
import { JsonRpcClient } from '../../../src/runtime/control-plane/client.js'
import { connectUds } from '../../../src/runtime/control-plane/uds-client.js'
import { TaskStore } from '../../../src/runtime/agent/task/store.js'
import { createSchedule, readSchedule } from '../../../src/runtime/scheduler/schedule.js'

async function writeIdentity(dir: string, name: string): Promise<string> {
  const path = join(dir, `${name}.identity.md`)
  await writeFile(
    path,
    `---
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
`,
  )
  return path
}

let home: string
let supervisor: Supervisor | undefined
let client: JsonRpcClient | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-sched-int-'))
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

async function setupAgentAndClient(name: string): Promise<void> {
  supervisor = await Supervisor.create({ home })
  await supervisor.start()
  const idPath = await writeIdentity(home, name)
  await supervisor.createAgent(name, idPath)
  const conn = await connectUds(Supervisor.socketPath(home))
  client = new JsonRpcClient(conn)
}

/** Poll a predicate every `intervalMs` up to `timeoutMs`. */
async function eventually(
  predicate: () => Promise<boolean>,
  { intervalMs = 50, timeoutMs = 10_000 }: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`condition did not become true within ${String(timeoutMs)}ms`)
}

describe('end-to-end: schedule fires through running Supervisor', () => {
  it(
    'a 5-second interval schedule fires within ~6s and writes a task',
    { timeout: 15_000 },
    async () => {
      await setupAgentAndClient('hobby')
      const added = await client!.call('cli.schedule.add', {
        agent: 'hobby',
        prompt: 'integration check',
        timing: { kind: 'interval', interval_seconds: 5 },
      })
      const taskStore = new TaskStore(home, 'hobby')

      // Wait for the synthetic task to land. Up to ~7s of slack to
      // absorb timer jitter on slow CI.
      await eventually(
        async () => {
          const tasks = await taskStore.list()
          return tasks.length >= 1
        },
        { intervalMs: 100, timeoutMs: 7000 },
      )
      const tasks = await taskStore.list()
      expect(tasks).toHaveLength(1)
      expect(tasks[0]!.body.trim()).toBe('integration check')
      expect(tasks[0]!.frontmatter.state).toBe('pending')

      // The schedule's last_fired_at is set and next_fire_at shifted
      // forward. The scheduler enqueues the task BEFORE it persists
      // the updated schedule file, so under load there is a real gap
      // between the task landing (observed above) and the file write
      // ... poll instead of reading once (flaked locally 2026-06-12).
      await eventually(
        async () => {
          const reread = await readSchedule(home, 'hobby', added.id)
          return reread.last_fired_at !== null && reread.next_fire_at !== null
        },
        { intervalMs: 100, timeoutMs: 3000 },
      )
    },
  )
})

describe('Supervisor restart re-arms persisted schedules', () => {
  it(
    'a schedule created on one Supervisor instance fires on a fresh one',
    { timeout: 20_000 },
    async () => {
      await setupAgentAndClient('hobby')
      // Persist a schedule via createSchedule directly so we don't go
      // through the running Scheduler. We need a 5s interval — the
      // schedule layer's minimum — so the next_fire_at is short.
      await createSchedule({
        home,
        agentName: 'hobby',
        prompt: 'after restart',
        timing: { kind: 'interval', interval_seconds: 5 },
        id: 'sched_restart_test',
        now: () => new Date(Date.now() - 10_000),
      })

      // Tear down the supervisor and bring up a fresh one. The fresh
      // Supervisor should scan disk on start() and re-arm the timer.
      if (client) {
        try {
          await client.close()
        } catch {
          // ignore
        }
        client = undefined
      }
      await supervisor!.shutdown()

      supervisor = await Supervisor.create({ home })
      await supervisor.start()

      // The persisted schedule's next_fire_at was 5s after a time 10s
      // in the past, i.e., 5s ago — so the catch-up logic recomputes
      // forward from now. The new fire happens within ~5s of now.
      const taskStore = new TaskStore(home, 'hobby')
      await eventually(
        async () => {
          const tasks = await taskStore.list()
          return tasks.length >= 1
        },
        { intervalMs: 100, timeoutMs: 8000 },
      )
      const tasks = await taskStore.list()
      expect(tasks).toHaveLength(1)
      expect(tasks[0]!.body.trim()).toBe('after restart')
    },
  )
})

describe('schedules added at runtime arm immediately (reload semantics)', () => {
  it('an add via RPC arms without a supervisor restart', { timeout: 15_000 }, async () => {
    await setupAgentAndClient('hobby')
    // Two adds back-to-back: both should arm and fire.
    await client!.call('cli.schedule.add', {
      agent: 'hobby',
      prompt: 'first',
      timing: { kind: 'interval', interval_seconds: 5 },
    })
    await client!.call('cli.schedule.add', {
      agent: 'hobby',
      prompt: 'second',
      timing: { kind: 'interval', interval_seconds: 5 },
    })

    const taskStore = new TaskStore(home, 'hobby')
    await eventually(
      async () => {
        const tasks = await taskStore.list()
        return tasks.length >= 2
      },
      { intervalMs: 100, timeoutMs: 8000 },
    )
    const tasks = await taskStore.list()
    const bodies = tasks.map((t) => t.body.trim()).sort()
    expect(bodies).toEqual(['first', 'second'])
  })
})
