/**
 * Tests for the Scheduler service (Epic 6 PR B).
 *
 * Uses a fake timer factory so tests don't sleep real wall time.
 * Verifies arm/fire/re-arm semantics against the real schedule
 * persistence layer (PR A) and against a real TaskStore.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSchedule,
  readSchedule,
  setScheduleEnabled,
} from '../../../src/runtime/scheduler/schedule.js'
import { Scheduler } from '../../../src/runtime/scheduler/service.js'
import { initHome, initAgentDirs } from '../../../src/runtime/storage/init.js'
import { TaskStore } from '../../../src/runtime/agent/task/store.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-scheduler-svc-'))
  await initHome(home)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

async function seedAgent(name: string): Promise<void> {
  const idSrc = join(home, `_seed_${name}.md`)
  await writeFile(
    idSrc,
    `---
schema_version: 5
agent_name: ${name}
agent_role: build agent
model:
  tier: frontier
  provider: anthropic
  model_id: claude-opus-4-7
tools: []
project_dir: /unused
brain_dir: /unused
created: 2026-04-26
---

# Identity
${name}
`,
  )
  await initAgentDirs(home, name, idSrc)
}

/**
 * A fake timer factory that captures pending timers for manual
 * triggering. Instead of relying on real setTimeout latency,
 * tests call `fakeTimers.runNow(handle)` to fire a timer.
 */
function makeFakeTimers() {
  let nextHandleId = 1
  const callbacks = new Map<number, () => void>()
  const setTimer = vi.fn((cb: () => void, _ms: number): NodeJS.Timeout => {
    const id = nextHandleId
    nextHandleId += 1
    callbacks.set(id, cb)
    return id as unknown as NodeJS.Timeout
  })
  const clearTimer = vi.fn((handle: NodeJS.Timeout) => {
    callbacks.delete(handle as unknown as number)
  })
  function fireAll(): void {
    const handles = [...callbacks.keys()]
    for (const h of handles) {
      const cb = callbacks.get(h)
      callbacks.delete(h)
      if (cb) cb()
    }
  }
  function pendingCount(): number {
    return callbacks.size
  }
  return { setTimer, clearTimer, fireAll, pendingCount }
}

describe('Scheduler.start', () => {
  it('returns 0 when no agents and no schedules exist', async () => {
    const fakeTimers = makeFakeTimers()
    const scheduler = new Scheduler({
      home,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
    })
    expect(await scheduler.start()).toBe(0)
    expect(fakeTimers.pendingCount()).toBe(0)
  })

  it('arms one timer per enabled schedule', async () => {
    await seedAgent('hobby')
    await createSchedule({
      home,
      agentName: 'hobby',
      prompt: 'check inbox',
      timing: { kind: 'interval', interval_seconds: 60 },
      now: () => new Date('2026-04-29T12:00:00.000Z'),
      id: 'sched_a',
    })
    await createSchedule({
      home,
      agentName: 'hobby',
      prompt: 'do another thing',
      timing: { kind: 'interval', interval_seconds: 60 },
      now: () => new Date('2026-04-29T12:00:00.000Z'),
      id: 'sched_b',
    })
    const fakeTimers = makeFakeTimers()
    const scheduler = new Scheduler({
      home,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
      now: () => new Date('2026-04-29T12:00:00.000Z'),
    })
    expect(await scheduler.start()).toBe(2)
    expect(fakeTimers.pendingCount()).toBe(2)
    expect(scheduler.armedCount()).toBe(2)
  })

  it('skips disabled schedules', async () => {
    await seedAgent('hobby')
    await createSchedule({
      home,
      agentName: 'hobby',
      prompt: 'on',
      timing: { kind: 'interval', interval_seconds: 60 },
      id: 'sched_on',
    })
    await createSchedule({
      home,
      agentName: 'hobby',
      prompt: 'off',
      timing: { kind: 'interval', interval_seconds: 60 },
      enabled: false,
      id: 'sched_off',
    })
    const fakeTimers = makeFakeTimers()
    const scheduler = new Scheduler({
      home,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
    })
    expect(await scheduler.start()).toBe(1)
  })

  it('aggregates schedules across multiple Agents', async () => {
    await seedAgent('hobby')
    await seedAgent('simon')
    await createSchedule({
      home,
      agentName: 'hobby',
      prompt: 'h',
      timing: { kind: 'interval', interval_seconds: 60 },
      id: 'sched_h',
    })
    await createSchedule({
      home,
      agentName: 'simon',
      prompt: 's',
      timing: { kind: 'interval', interval_seconds: 60 },
      id: 'sched_s',
    })
    const fakeTimers = makeFakeTimers()
    const scheduler = new Scheduler({
      home,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
    })
    expect(await scheduler.start()).toBe(2)
  })

  it('catch-up policy: a schedule whose next_fire_at is in the past is recomputed forward', async () => {
    await seedAgent('hobby')
    // Create a schedule whose next_fire_at is at 12:01.
    await createSchedule({
      home,
      agentName: 'hobby',
      prompt: 'p',
      timing: { kind: 'interval', interval_seconds: 60 },
      now: () => new Date('2026-04-29T12:00:00.000Z'),
      id: 'sched_stale',
    })
    // Then "the supervisor comes back" 6 hours later. The Scheduler
    // sees next_fire_at: 12:01:00 < now (18:00:00) and recomputes
    // forward from now() to 18:01:00.
    const fakeTimers = makeFakeTimers()
    const scheduler = new Scheduler({
      home,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
      now: () => new Date('2026-04-29T18:00:00.000Z'),
    })
    expect(await scheduler.start()).toBe(1)
    // Verify the timer was set with a delay roughly equal to 60s
    // (forward from now), not -6 hours.
    const [, ms] = fakeTimers.setTimer.mock.calls[0]!
    expect(ms).toBe(60 * 1000)
  })
})

describe('Scheduler firing', () => {
  it('on fire: enqueues a synthetic task and records last_fired_at', async () => {
    await seedAgent('hobby')
    const created = await createSchedule({
      home,
      agentName: 'hobby',
      prompt: 'check inbox and reply to anything new',
      description: 'inbox sweep',
      timing: { kind: 'interval', interval_seconds: 60 },
      now: () => new Date('2026-04-29T12:00:00.000Z'),
      id: 'sched_x',
    })
    expect(created.last_fired_at).toBeNull()

    const fakeTimers = makeFakeTimers()
    const fireTime = new Date('2026-04-29T12:01:00.000Z')
    const scheduler = new Scheduler({
      home,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
      now: () => fireTime,
    })
    await scheduler.start()
    fakeTimers.fireAll()
    // Wait for the async fire chain (readSchedule → enqueue → recordFired
    // → arm) to fully settle. We poll the TaskStore directly: under
    // parallel suite load, the schedule write and the task write can
    // become visible at slightly different times to a fresh
    // TaskStore instance. Polling for the task makes the test
    // robust to that timing.
    const taskStore = new TaskStore(home, 'hobby')
    await vi.waitFor(
      async () => {
        const tasks = await taskStore.list()
        if (tasks.length < 1) {
          throw new Error('task not yet enqueued')
        }
        const reread = await readSchedule(home, 'hobby', 'sched_x')
        if (reread.last_fired_at === null) {
          throw new Error('schedule not yet fired')
        }
      },
      { timeout: 5000, interval: 10 },
    )

    // Task got enqueued.
    const tasks = await taskStore.list()
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.body.trim()).toBe('check inbox and reply to anything new')
    expect(tasks[0]!.frontmatter.title).toBe('inbox sweep')

    // last_fired_at is updated.
    const reread = await readSchedule(home, 'hobby', 'sched_x')
    expect(reread.last_fired_at).toBe('2026-04-29T12:01:00.000Z')
    // next_fire_at is recomputed forward.
    expect(reread.next_fire_at).toBe('2026-04-29T12:02:00.000Z')

    // The next firing is armed.
    expect(scheduler.armedCount()).toBe(1)
  })

  it('on fire: skips and does not enqueue if the schedule was disabled between arm and fire', async () => {
    await seedAgent('hobby')
    await createSchedule({
      home,
      agentName: 'hobby',
      prompt: 'should not run',
      timing: { kind: 'interval', interval_seconds: 60 },
      now: () => new Date('2026-04-29T12:00:00.000Z'),
      id: 'sched_disabled_late',
    })
    const fakeTimers = makeFakeTimers()
    const scheduler = new Scheduler({
      home,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
      now: () => new Date('2026-04-29T12:00:00.000Z'),
    })
    await scheduler.start()
    // Disable it before the timer fires.
    await setScheduleEnabled(home, 'hobby', 'sched_disabled_late', false)
    fakeTimers.fireAll()
    // Give the async fire callback enough time to read the file and
    // notice it's disabled. 50ms is well over what an in-process file
    // read takes on any sane filesystem.
    await new Promise((resolve) => setTimeout(resolve, 50))

    const taskStore = new TaskStore(home, 'hobby')
    const tasks = await taskStore.list()
    expect(tasks).toHaveLength(0)
  })
})

describe('Scheduler.stop and reload', () => {
  it('stop() clears all timers', async () => {
    await seedAgent('hobby')
    await createSchedule({
      home,
      agentName: 'hobby',
      prompt: 'p',
      timing: { kind: 'interval', interval_seconds: 60 },
      id: 'sched_q',
    })
    const fakeTimers = makeFakeTimers()
    const scheduler = new Scheduler({
      home,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
    })
    await scheduler.start()
    expect(scheduler.armedCount()).toBe(1)
    scheduler.stop()
    expect(scheduler.armedCount()).toBe(0)
    expect(scheduler.isRunning()).toBe(false)
  })

  it('reload() picks up newly added schedules', async () => {
    await seedAgent('hobby')
    const fakeTimers = makeFakeTimers()
    const scheduler = new Scheduler({
      home,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
    })
    expect(await scheduler.start()).toBe(0)

    await createSchedule({
      home,
      agentName: 'hobby',
      prompt: 'fresh',
      timing: { kind: 'interval', interval_seconds: 60 },
      id: 'sched_fresh',
    })
    expect(await scheduler.reload()).toBe(1)
    expect(scheduler.armedCount()).toBe(1)
  })
})
