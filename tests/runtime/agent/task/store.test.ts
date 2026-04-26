/**
 * Tests for the task store: serialize/parse round-trip, list ordering, pickup
 * priority, atomic update.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TaskStore,
  parseTask,
  serializeTask,
  taskPath,
  tasksDir,
  TaskParseError,
} from '../../../../src/runtime/agent/task/store.js'
import { newPendingTask, type TaskRecord } from '../../../../src/runtime/agent/task/types.js'
import { newTaskId } from '../../../../src/runtime/util/id.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-task-store-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function makeTask(
  overrides: Partial<{ priority: number; createdISO: string; title: string }> = {},
): TaskRecord {
  const t = newPendingTask({
    id: newTaskId(),
    agent: 'hobby',
    title: overrides.title ?? 'a test task',
    body: 'do the thing',
    priority: overrides.priority ?? 0,
  })
  if (overrides.createdISO) {
    t.frontmatter.created = overrides.createdISO
  }
  return t
}

describe('serialize/parse round-trip', () => {
  it('round-trips a fresh pending task', () => {
    const t = makeTask()
    const raw = serializeTask(t)
    const parsed = parseTask(raw, '/test/path.md')
    expect(parsed.frontmatter).toEqual(t.frontmatter)
    expect(parsed.body.trim()).toEqual(t.body.trim())
  })

  it('handles multiline body', () => {
    const t = makeTask()
    t.body = 'line one\nline two\nline three'
    const raw = serializeTask(t)
    const parsed = parseTask(raw, '/x.md')
    expect(parsed.body.trim()).toBe('line one\nline two\nline three')
  })

  it('throws TaskParseError on missing leading delimiter', () => {
    expect(() => parseTask('no frontmatter here', '/x.md')).toThrow(TaskParseError)
  })

  it('throws TaskParseError on missing closing delimiter', () => {
    expect(() => parseTask('---\nschema_version: 1\nbody', '/x.md')).toThrow(TaskParseError)
  })

  it('throws TaskParseError on schema-invalid frontmatter', () => {
    const bad = '---\nschema_version: 1\nid: not-a-task-id\n---\nbody\n'
    expect(() => parseTask(bad, '/x.md')).toThrow(TaskParseError)
  })

  it('throws TaskParseError on schema_version mismatch', () => {
    const bad =
      '---\nschema_version: 99\nid: task_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nagent: hobby\ncreated: "2026-04-26T00:00:00Z"\nstate: pending\nidempotency: pure\npriority: 0\ntitle: t\ncheckpoint: null\ndetector_block: null\noutcome: null\nerror: null\nagent_state_at_terminal: null\n---\n'
    expect(() => parseTask(bad, '/x.md')).toThrow(TaskParseError)
  })
})

describe('TaskStore I/O', () => {
  it('saves and reads back a task', async () => {
    const store = new TaskStore(home, 'hobby')
    const t = makeTask()
    await store.save(t)
    const read = await store.get(t.frontmatter.id)
    expect(read).not.toBeNull()
    expect(read?.frontmatter).toEqual(t.frontmatter)
  })

  it('writes to <home>/agents/<name>/tasks/<id>.md', async () => {
    const store = new TaskStore(home, 'hobby')
    const t = makeTask()
    await store.save(t)
    const expected = taskPath(home, 'hobby', t.frontmatter.id)
    expect(expected).toContain(join('agents', 'hobby', 'tasks'))
    const raw = await readFile(expected, 'utf8')
    expect(raw).toContain('schema_version: 1')
  })

  it('returns null for a missing task', async () => {
    const store = new TaskStore(home, 'hobby')
    expect(await store.get('task_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeNull()
  })

  it('delete is a no-op for a missing task', async () => {
    const store = new TaskStore(home, 'hobby')
    await expect(store.delete('task_missing')).resolves.toBeUndefined()
  })

  it('delete removes an existing task', async () => {
    const store = new TaskStore(home, 'hobby')
    const t = makeTask()
    await store.save(t)
    await store.delete(t.frontmatter.id)
    expect(await store.get(t.frontmatter.id)).toBeNull()
  })

  it('list returns empty when tasks dir does not exist', async () => {
    const store = new TaskStore(home, 'hobby')
    expect(await store.list()).toEqual([])
  })

  it('list returns tasks sorted by created desc', async () => {
    const store = new TaskStore(home, 'hobby')
    const old = makeTask({ createdISO: '2026-04-25T00:00:00.000Z', title: 'old' })
    const mid = makeTask({ createdISO: '2026-04-25T12:00:00.000Z', title: 'mid' })
    const recent = makeTask({ createdISO: '2026-04-26T00:00:00.000Z', title: 'recent' })
    await store.save(old)
    await store.save(mid)
    await store.save(recent)
    const list = await store.list()
    expect(list.map((t) => t.frontmatter.title)).toEqual(['recent', 'mid', 'old'])
  })

  it('list skips files that do not parse', async () => {
    const store = new TaskStore(home, 'hobby')
    const ok = makeTask({ title: 'ok' })
    await store.save(ok)
    await mkdir(tasksDir(home, 'hobby'), { recursive: true })
    await writeFile(join(tasksDir(home, 'hobby'), 'task_garbage.md'), 'not valid frontmatter')
    const list = await store.list()
    expect(list.map((t) => t.frontmatter.title)).toEqual(['ok'])
  })
})

describe('pickPending', () => {
  it('returns null when there are no tasks', async () => {
    const store = new TaskStore(home, 'hobby')
    expect(await store.pickPending()).toBeNull()
  })

  it('returns null when no tasks are pending', async () => {
    const store = new TaskStore(home, 'hobby')
    const t = makeTask()
    t.frontmatter.state = 'done'
    await store.save(t)
    expect(await store.pickPending()).toBeNull()
  })

  it('picks the highest-priority pending task', async () => {
    const store = new TaskStore(home, 'hobby')
    const lo = makeTask({ priority: 0, title: 'lo' })
    const hi = makeTask({ priority: 5, title: 'hi' })
    await store.save(lo)
    await store.save(hi)
    const picked = await store.pickPending()
    expect(picked?.frontmatter.title).toBe('hi')
  })

  it('among ties, picks the oldest pending task', async () => {
    const store = new TaskStore(home, 'hobby')
    const old = makeTask({ priority: 1, createdISO: '2026-04-25T00:00:00.000Z', title: 'old' })
    const newer = makeTask({ priority: 1, createdISO: '2026-04-26T00:00:00.000Z', title: 'newer' })
    await store.save(newer)
    await store.save(old)
    const picked = await store.pickPending()
    expect(picked?.frontmatter.title).toBe('old')
  })

  it('ignores running, blocked, done, and errored tasks', async () => {
    const store = new TaskStore(home, 'hobby')
    const skip = (state: TaskRecord['frontmatter']['state']) => {
      const t = makeTask({ title: state })
      t.frontmatter.state = state
      return t
    }
    await store.save(skip('running'))
    await store.save(skip('blocked_on_user'))
    await store.save(skip('blocked_on_detector'))
    await store.save(skip('done'))
    await store.save(skip('errored'))
    expect(await store.pickPending()).toBeNull()
  })
})

describe('update', () => {
  it('mutates frontmatter and persists', async () => {
    const store = new TaskStore(home, 'hobby')
    const t = makeTask()
    await store.save(t)
    const updated = await store.update(t.frontmatter.id, (fm) => ({ ...fm, state: 'running' }))
    expect(updated?.frontmatter.state).toBe('running')
    const read = await store.get(t.frontmatter.id)
    expect(read?.frontmatter.state).toBe('running')
  })

  it('returns null when the task does not exist', async () => {
    const store = new TaskStore(home, 'hobby')
    expect(await store.update('task_missing', (fm) => fm)).toBeNull()
  })

  it('preserves the body across updates', async () => {
    const store = new TaskStore(home, 'hobby')
    const t = makeTask()
    t.body = 'preserved body content'
    await store.save(t)
    await store.update(t.frontmatter.id, (fm) => ({ ...fm, state: 'done' }))
    const read = await store.get(t.frontmatter.id)
    expect(read?.body.trim()).toBe('preserved body content')
  })
})
