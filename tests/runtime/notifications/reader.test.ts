/**
 * Tests for the notification reader and state-machine helpers
 * (Epic 7 PR B).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listNotifications,
  markAnswered,
  markDismissed,
  notificationExists,
  notificationPath,
  readNotification,
} from '../../../src/runtime/notifications/reader.js'
import { homePaths } from '../../../src/runtime/storage/layout.js'
import { initHome } from '../../../src/runtime/storage/init.js'

const FIXED = '2026-04-29T12:00:00.000Z'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-notif-reader-'))
  await initHome(home)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

interface SeedNotif {
  id: string
  ts?: string
  tier?: 'passive' | 'normal' | 'important' | 'critical'
  agent?: string
  kind?: string
  state?: 'pending' | 'answered' | 'dismissed'
  requires_response?: boolean
  body?: string
  extras?: Record<string, string>
}

async function seed(n: SeedNotif): Promise<string> {
  const fm: Record<string, unknown> = {
    schema_version: 1,
    id: n.id,
    ts: n.ts ?? FIXED,
    tier: n.tier ?? 'passive',
    agent: n.agent ?? 'hobby',
    kind: n.kind ?? 'detector_trip',
    state: n.state ?? 'pending',
  }
  if (n.requires_response !== undefined) fm['requires_response'] = n.requires_response
  if (n.extras) for (const k of Object.keys(n.extras)) fm[k] = n.extras[k]
  const yamlLines = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
  const content = `---\n${yamlLines.join('\n')}\n---\n${n.body ?? 'body'}`
  const path = notificationPath(home, n.id)
  await mkdir(homePaths(home).stateNotifications, { recursive: true })
  await writeFile(path, content, 'utf8')
  return path
}

describe('readNotification', () => {
  it('parses canonical frontmatter and surfaces emitter-specific extras', async () => {
    await seed({
      id: 'notif_a',
      tier: 'important',
      agent: 'hobby',
      kind: 'budget_warn',
      extras: { cap_usd: '25', cumulative_usd: '20' },
      body: 'Hobby is at 80% of cap.',
    })
    const rec = await readNotification(home, 'notif_a')
    expect(rec.frontmatter.id).toBe('notif_a')
    expect(rec.frontmatter.tier).toBe('important')
    expect(rec.frontmatter.kind).toBe('budget_warn')
    expect(rec.frontmatter.state).toBe('pending')
    expect(rec.extras['cap_usd']).toBe('25')
    expect(rec.body.trim()).toBe('Hobby is at 80% of cap.')
  })

  it('rejects a notification with no frontmatter delimiters', async () => {
    const path = notificationPath(home, 'no_fm')
    await mkdir(homePaths(home).stateNotifications, { recursive: true })
    await writeFile(path, '# just a markdown body\n', 'utf8')
    await expect(readNotification(home, 'no_fm')).rejects.toThrow(/no YAML frontmatter/)
  })

  it('rejects an unknown tier', async () => {
    await seed({ id: 'bad', tier: 'urgent' as 'passive' })
    await expect(readNotification(home, 'bad')).rejects.toThrow()
  })
})

describe('listNotifications', () => {
  it('returns [] when the notifications dir is empty', async () => {
    expect(await listNotifications(home)).toEqual([])
  })

  it('orders by ts ascending', async () => {
    await seed({ id: 'a', ts: '2026-04-29T10:00:00.000Z' })
    await seed({ id: 'b', ts: '2026-04-29T08:00:00.000Z' })
    await seed({ id: 'c', ts: '2026-04-29T09:00:00.000Z' })
    const list = await listNotifications(home)
    expect(list.map((r) => r.frontmatter.id)).toEqual(['b', 'c', 'a'])
  })

  it('filters by state', async () => {
    await seed({ id: 'p', state: 'pending' })
    await seed({ id: 'a', state: 'answered' })
    await seed({ id: 'd', state: 'dismissed' })
    const pending = await listNotifications(home, { state: 'pending' })
    expect(pending.map((r) => r.frontmatter.id)).toEqual(['p'])
    const both = await listNotifications(home, { state: ['pending', 'answered'] })
    expect(both.map((r) => r.frontmatter.id).sort()).toEqual(['a', 'p'])
  })

  it('filters by tier', async () => {
    await seed({ id: 'x', tier: 'passive' })
    await seed({ id: 'y', tier: 'critical' })
    const high = await listNotifications(home, { tier: ['important', 'critical'] })
    expect(high.map((r) => r.frontmatter.id)).toEqual(['y'])
  })

  it('filters by agent', async () => {
    await seed({ id: 'h', agent: 'hobby' })
    await seed({ id: 's', agent: 'simon' })
    const hobby = await listNotifications(home, { agent: 'hobby' })
    expect(hobby.map((r) => r.frontmatter.id)).toEqual(['h'])
  })

  it('asksOnly returns only requires_response: true entries', async () => {
    await seed({ id: 'ask1', requires_response: true })
    await seed({ id: 'inform1' })
    await seed({ id: 'ask2', requires_response: true })
    const asks = await listNotifications(home, { asksOnly: true })
    expect(asks.map((r) => r.frontmatter.id).sort()).toEqual(['ask1', 'ask2'])
  })

  it('skips malformed files rather than aborting the whole list', async () => {
    await seed({ id: 'good' })
    const badPath = notificationPath(home, 'bad')
    await writeFile(badPath, '# no frontmatter here', 'utf8')
    const list = await listNotifications(home)
    expect(list.map((r) => r.frontmatter.id)).toEqual(['good'])
  })
})

describe('markAnswered', () => {
  it('transitions pending → answered, persists response and resolved_at', async () => {
    await seed({
      id: 'q1',
      tier: 'important',
      requires_response: true,
      body: 'Should I proceed?',
    })
    const updated = await markAnswered(home, 'q1', 'yes, go ahead', () => new Date(FIXED))
    expect(updated.frontmatter.state).toBe('answered')
    expect(updated.frontmatter.response).toBe('yes, go ahead')
    expect(updated.frontmatter.resolved_at).toBe(FIXED)
    // Round-trip: re-read from disk picks up the new state.
    const reread = await readNotification(home, 'q1')
    expect(reread.frontmatter.state).toBe('answered')
    expect(reread.frontmatter.response).toBe('yes, go ahead')
  })

  it('preserves emitter-specific extras on the answered record', async () => {
    await seed({
      id: 'q2',
      tier: 'important',
      requires_response: true,
      extras: { task_id: 'task_42' },
    })
    await markAnswered(home, 'q2', 'go', () => new Date(FIXED))
    const reread = await readNotification(home, 'q2')
    expect(reread.extras['task_id']).toBe('task_42')
  })

  it('refuses to answer a non-pending notification', async () => {
    await seed({ id: 'q3', state: 'answered' })
    await expect(markAnswered(home, 'q3', 'late')).rejects.toThrow(/answered/)
  })
})

describe('markDismissed', () => {
  it('transitions pending → dismissed, sets resolved_at, no response', async () => {
    await seed({ id: 'd1' })
    const updated = await markDismissed(home, 'd1', () => new Date(FIXED))
    expect(updated.frontmatter.state).toBe('dismissed')
    expect(updated.frontmatter.resolved_at).toBe(FIXED)
    expect(updated.frontmatter.response).toBeUndefined()
  })

  it('refuses to dismiss a non-pending notification', async () => {
    await seed({ id: 'd2', state: 'dismissed' })
    await expect(markDismissed(home, 'd2')).rejects.toThrow(/dismissed/)
  })
})

describe('notificationExists', () => {
  it('returns false for missing, true after seed', async () => {
    expect(await notificationExists(home, 'nope')).toBe(false)
    await seed({ id: 'present' })
    expect(await notificationExists(home, 'present')).toBe(true)
  })
})
