/**
 * Tests for orphaned-task reconciliation on Agent boot.
 *
 * The intent being protected: a task that was in flight when the Agent
 * process died must not vanish. `pickPending()` only ever returns
 * `pending` tasks, so a task left in `running` is invisible to the loop
 * forever ... it is never retried, never errored, and never surfaced to
 * the operator. The operator's experience is an Agent that was asked a
 * question and simply never answered. These tests fail if that silence
 * can come back.
 *
 * The disposition split is the second thing under test. It is not a
 * style choice: requeuing a `destructive` task could repeat an
 * irreversible side effect, so those must surface as failures instead.
 * If someone later "simplifies" this to requeue everything, the
 * destructive test fails and says why.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TaskStore } from '../../../src/runtime/agent/task/store.js'
import { newPendingTask, type TaskRecord } from '../../../src/runtime/agent/task/types.js'
import { newTaskId } from '../../../src/runtime/util/id.js'
import {
  ORPHANED_TASK_ERROR_CLASS,
  reconcileOrphanedTasks,
} from '../../../src/runtime/agent/orphaned-tasks.js'
import { createLogger } from '../../../src/runtime/util/logger.js'

let home: string
const AGENT = 'skippy'
const logger = createLogger('test/orphan-sweep')

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-orphan-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

async function seed(
  store: TaskStore,
  opts: {
    state: TaskRecord['frontmatter']['state']
    idempotency?: TaskRecord['frontmatter']['idempotency']
    body?: string
  },
): Promise<string> {
  const t = newPendingTask({
    id: newTaskId(),
    agent: AGENT,
    title: 'ask hobby how many keys are in the vault',
    body: opts.body ?? 'original task body',
    ...(opts.idempotency ? { idempotency: opts.idempotency } : {}),
  })
  t.frontmatter.state = opts.state
  await store.save(t)
  return t.frontmatter.id
}

describe('reconcileOrphanedTasks', () => {
  it('requeues a checkpointed task the dead process left running', async () => {
    const store = new TaskStore(home, AGENT)
    const id = await seed(store, { state: 'running', idempotency: 'checkpointed' })

    const result = await reconcileOrphanedTasks({ taskStore: store, logger })

    expect(result.dispositions).toHaveLength(1)
    expect(result.dispositions[0]?.action).toBe('requeued')

    // The load-bearing assertion: the task is visible to the loop again.
    // `state === 'pending'` is not the point ... being pickable is.
    const picked = await store.pickPending()
    expect(picked?.frontmatter.id).toBe(id)
  })

  it('requeues a pure task', async () => {
    const store = new TaskStore(home, AGENT)
    await seed(store, { state: 'running', idempotency: 'pure' })

    const result = await reconcileOrphanedTasks({ taskStore: store, logger })

    expect(result.dispositions[0]?.action).toBe('requeued')
    expect((await store.pickPending())?.frontmatter.state).toBe('pending')
  })

  it('tells a requeued task it was interrupted, so the model does not redo landed work', async () => {
    const store = new TaskStore(home, AGENT)
    const id = await seed(store, {
      state: 'running',
      idempotency: 'checkpointed',
      body: 'I already sent the message to hobby.',
    })

    await reconcileOrphanedTasks({ taskStore: store, logger })

    const after = await store.get(id)
    // The original record survives ...
    expect(after?.body).toContain('I already sent the message to hobby.')
    // ... and the model is told what state it is picking up in. Without
    // this the model re-narrates the whole task as if it never started.
    expect(after?.body).toContain('Interrupted')
    expect(after?.body).toMatch(/files\s+written are written, messages sent are sent/)
  })

  it('errors a destructive task instead of requeuing it, so nothing irreversible repeats', async () => {
    const store = new TaskStore(home, AGENT)
    const id = await seed(store, { state: 'running', idempotency: 'destructive' })

    const result = await reconcileOrphanedTasks({ taskStore: store, logger })

    expect(result.dispositions[0]?.action).toBe('errored')
    const after = await store.get(id)
    expect(after?.frontmatter.state).toBe('errored')
    expect(after?.frontmatter.error?.class).toBe(ORPHANED_TASK_ERROR_CLASS)
    // It must NOT come back through the loop on its own.
    expect(await store.pickPending()).toBeNull()
  })

  it('an errored orphan explains itself to the operator rather than dying silently', async () => {
    const store = new TaskStore(home, AGENT)
    const id = await seed(store, { state: 'running', idempotency: 'destructive' })

    await reconcileOrphanedTasks({ taskStore: store, logger })

    const msg = (await store.get(id))?.frontmatter.error?.message ?? ''
    expect(msg).toContain('Agent process stopped')
    expect(msg).toContain('destructive')
    expect(msg).toContain('resubmit')
  })

  it('leaves tasks in every other state untouched', async () => {
    const store = new TaskStore(home, AGENT)
    const pending = await seed(store, { state: 'pending' })
    const done = await seed(store, { state: 'done' })
    const blocked = await seed(store, { state: 'blocked_on_agent' })
    const detector = await seed(store, { state: 'blocked_on_detector' })

    const result = await reconcileOrphanedTasks({ taskStore: store, logger })

    expect(result.dispositions).toHaveLength(0)
    expect((await store.get(pending))?.frontmatter.state).toBe('pending')
    expect((await store.get(done))?.frontmatter.state).toBe('done')
    expect((await store.get(blocked))?.frontmatter.state).toBe('blocked_on_agent')
    expect((await store.get(detector))?.frontmatter.state).toBe('blocked_on_detector')
  })

  it('reclaims every orphan when a process died more than once', async () => {
    // The box this was diagnosed on had two `running` tasks for one
    // Agent, which is impossible in a single process lifetime ... proof
    // of repeated deaths. A sweep that only handled the first would
    // leave the rest lost.
    const store = new TaskStore(home, AGENT)
    await seed(store, { state: 'running', idempotency: 'checkpointed' })
    await seed(store, { state: 'running', idempotency: 'pure' })
    await seed(store, { state: 'running', idempotency: 'destructive' })

    const result = await reconcileOrphanedTasks({ taskStore: store, logger })

    expect(result.dispositions).toHaveLength(3)
    expect(result.dispositions.filter((d) => d.action === 'requeued')).toHaveLength(2)
    expect(result.dispositions.filter((d) => d.action === 'errored')).toHaveLength(1)
  })

  it('does not resurrect an orphan the operator has long since moved on from', async () => {
    // The box this was diagnosed on had orphans going back three weeks.
    // Requeuing those on the next restart would have Agents abruptly
    // acting on questions whose context is gone ... a different and
    // worse surprise than the silence being fixed.
    const store = new TaskStore(home, AGENT)
    const id = await seed(store, { state: 'running', idempotency: 'checkpointed' })
    await store.update(id, (fm) => ({
      ...fm,
      created: new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString(),
    }))

    const result = await reconcileOrphanedTasks({ taskStore: store, logger })

    expect(result.dispositions[0]).toMatchObject({ action: 'errored', reason: 'stale' })
    expect(await store.pickPending()).toBeNull()
    expect((await store.get(id))?.frontmatter.error?.message).toMatch(/more than a day/)
  })

  it('still requeues a task that was legitimately in flight for hours', async () => {
    // Eight-hour autonomous runs are a design target. A restart eight
    // hours into one must not throw the work away.
    const store = new TaskStore(home, AGENT)
    const id = await seed(store, { state: 'running', idempotency: 'checkpointed' })
    await store.update(id, (fm) => ({
      ...fm,
      created: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
    }))

    const result = await reconcileOrphanedTasks({ taskStore: store, logger })

    expect(result.dispositions[0]?.action).toBe('requeued')
    expect((await store.pickPending())?.frontmatter.id).toBe(id)
  })

  it('treats an unreadable created timestamp as stale rather than resuming blind', async () => {
    const store = new TaskStore(home, AGENT)
    const id = await seed(store, { state: 'running', idempotency: 'pure' })
    await store.update(id, (fm) => ({ ...fm, created: 'not-a-date' }))

    const result = await reconcileOrphanedTasks({ taskStore: store, logger })

    expect(result.dispositions[0]).toMatchObject({ action: 'errored', reason: 'stale' })
  })

  it('reports destructive and stale as distinct reasons', async () => {
    const store = new TaskStore(home, AGENT)
    await seed(store, { state: 'running', idempotency: 'destructive' })
    const oldId = await seed(store, { state: 'running', idempotency: 'pure' })
    await store.update(oldId, (fm) => ({
      ...fm,
      created: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    }))

    const result = await reconcileOrphanedTasks({ taskStore: store, logger })

    expect(result.dispositions.map((d) => d.reason).sort()).toEqual(['destructive', 'stale'])
  })

  it('is a no-op on a clean boot', async () => {
    const store = new TaskStore(home, AGENT)
    await seed(store, { state: 'done' })

    const result = await reconcileOrphanedTasks({ taskStore: store, logger })

    expect(result.dispositions).toHaveLength(0)
  })

  it('never throws when the task store is unreadable, so a bad sweep cannot block boot', async () => {
    const store = new TaskStore(home, AGENT)
    await rm(home, { recursive: true, force: true })

    await expect(reconcileOrphanedTasks({ taskStore: store, logger })).resolves.toEqual({
      dispositions: [],
    })
  })
})
