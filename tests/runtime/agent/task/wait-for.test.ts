/**
 * Tests for the task continuation primitive (decision:
 * 2026-05-16-task-continuation-primitive):
 *   - wait_for round-trips through the YAML serializer
 *   - newPendingTask defaults wait_for to null
 *   - findWaiting matches against the right source_kind / source_ref / sender
 *   - findWaiting filters expired waits out
 *   - findWaiting respects task state (only blocked_on_agent matches)
 *   - findWaiting picks the oldest wait when multiple match (FIFO)
 *   - findExpiredWaits returns only expired blocked waits, oldest first
 *   - buildContinuationSection produces the documented shape
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TaskStore, parseTask, serializeTask } from '../../../../src/runtime/agent/task/store.js'
import {
  newPendingTask,
  type TaskRecord,
  type WaitFor,
} from '../../../../src/runtime/agent/task/types.js'
import {
  buildContinuationSection,
  buildTimeoutContinuationSection,
} from '../../../../src/runtime/agent/task/continuation.js'
import { newTaskId } from '../../../../src/runtime/util/id.js'

let home: string
const AGENT = 'simon'

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-wait-for-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function makeTask(opts?: {
  state?: 'pending' | 'blocked_on_agent' | 'done'
  wait_for?: WaitFor
  createdISO?: string
}): TaskRecord {
  const t = newPendingTask({ id: newTaskId(), agent: AGENT, title: 't', body: 'b' })
  if (opts?.state) t.frontmatter.state = opts.state
  if (opts?.wait_for !== undefined) t.frontmatter.wait_for = opts.wait_for
  if (opts?.createdISO) t.frontmatter.created = opts.createdISO
  return t
}

function pubWait(over: Partial<NonNullable<WaitFor>> = {}): NonNullable<WaitFor> {
  return {
    source_kind: 'pub',
    source_ref: { pub: 'studio' },
    expected_from: 'hobby',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    context_note: 'asked hobby on doug behalf',
    waiting_since: new Date().toISOString(),
    ...over,
  }
}

describe('wait_for serialization', () => {
  it('defaults to null on a fresh task', () => {
    const t = newPendingTask({ id: newTaskId(), agent: AGENT, title: 'x', body: 'y' })
    expect(t.frontmatter.wait_for).toBeNull()
  })

  it('round-trips a populated wait_for through YAML', () => {
    const t = makeTask({ state: 'blocked_on_agent', wait_for: pubWait() })
    const raw = serializeTask(t)
    const parsed = parseTask(raw, '/x.md')
    expect(parsed.frontmatter.wait_for).toEqual(t.frontmatter.wait_for)
  })

  it('round-trips a connector wait_for with conversation_id', () => {
    const t = makeTask({
      state: 'blocked_on_agent',
      wait_for: {
        source_kind: 'connector',
        source_ref: { connector_id: 'discord', conversation_id: '1505...' },
        expected_from: '264380...',
        expires_at: new Date().toISOString(),
        context_note: 'forwarded to hobby; relay back to doug',
        waiting_since: new Date().toISOString(),
      },
    })
    const raw = serializeTask(t)
    const parsed = parseTask(raw, '/x.md')
    expect(parsed.frontmatter.wait_for?.source_kind).toBe('connector')
    expect(parsed.frontmatter.wait_for?.source_ref.connector_id).toBe('discord')
    expect(parsed.frontmatter.wait_for?.source_ref.conversation_id).toBe('1505...')
  })

  it('loads legacy task files (no wait_for field) as null', () => {
    // Build a v1 task file by hand without the field, ensure the parser
    // tolerates it. The schema marks wait_for as optional.default(null).
    const yaml = `---
schema_version: 1
id: task_00000000000000000000000000000001
agent: ${AGENT}
created: ${new Date().toISOString()}
state: pending
idempotency: pure
priority: 0
title: legacy
checkpoint: null
detector_block: null
resumed_from_trip: null
delegated_by: null
delegating_task_id: null
delegation_depth: 0
outcome: null
error: null
audit: null
agent_state_at_terminal: null
source: null
---

legacy body
`
    const parsed = parseTask(yaml, '/legacy.md')
    expect(parsed.frontmatter.wait_for).toBeNull()
  })
})

describe('TaskStore.findWaiting (pub)', () => {
  it('matches a blocked_on_agent task with the right pub + expected_from', async () => {
    const store = new TaskStore(home, AGENT)
    const t = makeTask({ state: 'blocked_on_agent', wait_for: pubWait() })
    await store.save(t)
    const match = await store.findWaiting({ kind: 'pub', pub: 'studio', sender: 'hobby' })
    expect(match?.frontmatter.id).toBe(t.frontmatter.id)
  })

  it('matches case-insensitively on expected_from', async () => {
    const store = new TaskStore(home, AGENT)
    const t = makeTask({
      state: 'blocked_on_agent',
      wait_for: pubWait({ expected_from: 'Hobby' }),
    })
    await store.save(t)
    const match = await store.findWaiting({ kind: 'pub', pub: 'studio', sender: 'hobby' })
    expect(match?.frontmatter.id).toBe(t.frontmatter.id)
  })

  it('does not match when expected_from differs', async () => {
    const store = new TaskStore(home, AGENT)
    await store.save(makeTask({ state: 'blocked_on_agent', wait_for: pubWait() }))
    const match = await store.findWaiting({ kind: 'pub', pub: 'studio', sender: 'doug' })
    expect(match).toBeNull()
  })

  it('does not match when pub differs', async () => {
    const store = new TaskStore(home, AGENT)
    await store.save(makeTask({ state: 'blocked_on_agent', wait_for: pubWait() }))
    const match = await store.findWaiting({ kind: 'pub', pub: 'ship-room', sender: 'hobby' })
    expect(match).toBeNull()
  })

  it('does not match a task that is not in blocked_on_agent state', async () => {
    const store = new TaskStore(home, AGENT)
    await store.save(makeTask({ state: 'pending', wait_for: pubWait() }))
    await store.save(makeTask({ state: 'done', wait_for: pubWait() }))
    const match = await store.findWaiting({ kind: 'pub', pub: 'studio', sender: 'hobby' })
    expect(match).toBeNull()
  })

  it('filters out expired waits', async () => {
    const store = new TaskStore(home, AGENT)
    await store.save(
      makeTask({
        state: 'blocked_on_agent',
        wait_for: pubWait({ expires_at: new Date(Date.now() - 1000).toISOString() }),
      }),
    )
    const match = await store.findWaiting({ kind: 'pub', pub: 'studio', sender: 'hobby' })
    expect(match).toBeNull()
  })

  it('returns the oldest wait when multiple match (FIFO)', async () => {
    const store = new TaskStore(home, AGENT)
    const earlierWaitingSince = new Date(Date.now() - 60_000).toISOString()
    const laterWaitingSince = new Date(Date.now() - 10_000).toISOString()
    const earlier = makeTask({
      state: 'blocked_on_agent',
      wait_for: pubWait({ waiting_since: earlierWaitingSince }),
    })
    const later = makeTask({
      state: 'blocked_on_agent',
      wait_for: pubWait({ waiting_since: laterWaitingSince }),
    })
    await store.save(later)
    await store.save(earlier)
    const match = await store.findWaiting({ kind: 'pub', pub: 'studio', sender: 'hobby' })
    expect(match?.frontmatter.id).toBe(earlier.frontmatter.id)
  })
})

describe('TaskStore.findWaiting (connector)', () => {
  it('matches by connector_id + conversation_id + sender', async () => {
    const store = new TaskStore(home, AGENT)
    const t = makeTask({
      state: 'blocked_on_agent',
      wait_for: {
        source_kind: 'connector',
        source_ref: { connector_id: 'discord', conversation_id: '1505...' },
        expected_from: '264380...',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        context_note: 'awaiting doug reply on discord',
        waiting_since: new Date().toISOString(),
      },
    })
    await store.save(t)
    const match = await store.findWaiting({
      kind: 'connector',
      connector_id: 'discord',
      conversation_id: '1505...',
      sender: '264380...',
    })
    expect(match?.frontmatter.id).toBe(t.frontmatter.id)
  })

  it('does not match when conversation_id differs', async () => {
    const store = new TaskStore(home, AGENT)
    const t = makeTask({
      state: 'blocked_on_agent',
      wait_for: {
        source_kind: 'connector',
        source_ref: { connector_id: 'discord', conversation_id: '1505...' },
        expected_from: '264380...',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        context_note: 'x',
        waiting_since: new Date().toISOString(),
      },
    })
    await store.save(t)
    const match = await store.findWaiting({
      kind: 'connector',
      connector_id: 'discord',
      conversation_id: '9999...',
      sender: '264380...',
    })
    expect(match).toBeNull()
  })
})

describe('TaskStore.findWaiting (chat)', () => {
  it('matches by chat_id; expected_from is always "user"', async () => {
    const store = new TaskStore(home, AGENT)
    const t = makeTask({
      state: 'blocked_on_agent',
      wait_for: {
        source_kind: 'chat',
        source_ref: { chat_id: 'chat_abc' },
        expected_from: 'user',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        context_note: 'awaiting user reply',
        waiting_since: new Date().toISOString(),
      },
    })
    await store.save(t)
    const match = await store.findWaiting({ kind: 'chat', chat_id: 'chat_abc' })
    expect(match?.frontmatter.id).toBe(t.frontmatter.id)
  })

  it('does not match a chat wait when chat_id differs', async () => {
    const store = new TaskStore(home, AGENT)
    const t = makeTask({
      state: 'blocked_on_agent',
      wait_for: {
        source_kind: 'chat',
        source_ref: { chat_id: 'chat_abc' },
        expected_from: 'user',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        context_note: 'x',
        waiting_since: new Date().toISOString(),
      },
    })
    await store.save(t)
    const match = await store.findWaiting({ kind: 'chat', chat_id: 'chat_xyz' })
    expect(match).toBeNull()
  })
})

describe('TaskStore.findExpiredWaits', () => {
  it('returns only expired blocked waits, oldest waiting_since first', async () => {
    const store = new TaskStore(home, AGENT)
    const past1 = new Date(Date.now() - 600_000).toISOString()
    const past2 = new Date(Date.now() - 300_000).toISOString()
    const future = new Date(Date.now() + 60_000).toISOString()
    const a = makeTask({
      state: 'blocked_on_agent',
      wait_for: pubWait({
        expires_at: past2,
        waiting_since: new Date(Date.now() - 300_000).toISOString(),
      }),
    })
    const b = makeTask({
      state: 'blocked_on_agent',
      wait_for: pubWait({
        expires_at: past1,
        waiting_since: new Date(Date.now() - 600_000).toISOString(),
      }),
    })
    const c = makeTask({
      state: 'blocked_on_agent',
      wait_for: pubWait({ expires_at: future }),
    })
    const d = makeTask({ state: 'pending', wait_for: pubWait({ expires_at: past1 }) })
    await store.save(a)
    await store.save(b)
    await store.save(c)
    await store.save(d)
    const expired = await store.findExpiredWaits()
    expect(expired.map((t) => t.frontmatter.id)).toEqual([b.frontmatter.id, a.frontmatter.id])
  })
})

describe('continuation rendering', () => {
  it('includes the source kind, sender, context note, and reply hint', () => {
    const section = buildContinuationSection({
      source_kind: 'pub',
      sender_label: 'hobby',
      context_note: 'doug asked in discord; relay back',
      body_text: 'I need a deployment branch',
      reply_hint: 'reply via discord_send',
    })
    expect(section).toContain('## Continuation: response arrived')
    expect(section).toContain('**Source:** pub')
    expect(section).toContain('hobby')
    expect(section).toContain('doug asked in discord; relay back')
    expect(section).toContain('I need a deployment branch')
    expect(section).toContain('reply via discord_send')
  })

  it('renders the timeout variant with waited_for_seconds', () => {
    const section = buildTimeoutContinuationSection({
      context_note: 'doug asked in discord',
      expected_from: 'hobby',
      source_kind: 'pub',
      waited_for_seconds: 1800,
      reply_hint: 'forward via discord_send',
    })
    expect(section).toContain('## Continuation: response timed out')
    expect(section).toContain('1800')
    expect(section).toContain('hobby')
  })
})
