/**
 * Tests for the schedule entry shape + persistence (Epic 6 PR A).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  nextFireTime,
  readSchedule,
  recordFired,
  ScheduleError,
  setScheduleEnabled,
  validateTiming,
} from '../../../src/runtime/scheduler/schedule.js'
import { initHome } from '../../../src/runtime/storage/init.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-schedule-'))
  await initHome(home)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('validateTiming', () => {
  it('accepts a standard 5-field cron expression', () => {
    expect(() => {
      validateTiming({ kind: 'cron', expression: '*/15 * * * *', timezone: 'UTC' })
    }).not.toThrow()
  })

  it('rejects a malformed cron expression', () => {
    expect(() => {
      validateTiming({ kind: 'cron', expression: 'not a cron', timezone: 'UTC' })
    }).toThrow(ScheduleError)
  })

  it('accepts an interval timing', () => {
    expect(() => {
      validateTiming({ kind: 'interval', interval_seconds: 300 })
    }).not.toThrow()
  })
})

describe('nextFireTime', () => {
  it('interval timing fires N seconds from now', () => {
    const now = new Date('2026-04-29T12:00:00.000Z')
    const next = nextFireTime({ kind: 'interval', interval_seconds: 60 }, now)
    expect(next).toBe('2026-04-29T12:01:00.000Z')
  })

  it('cron timing computes the next match in the configured timezone', () => {
    // "every day at midnight UTC"
    const now = new Date('2026-04-29T15:00:00.000Z')
    const next = nextFireTime({ kind: 'cron', expression: '0 0 * * *', timezone: 'UTC' }, now)
    expect(next).toBe('2026-04-30T00:00:00.000Z')
  })

  it('cron in non-UTC zone respects the zone', () => {
    // "every day at 9am America/New_York" — fires at 13:00 or 14:00 UTC
    // depending on DST. Pick a non-DST date for determinism.
    const now = new Date('2026-01-15T15:00:00.000Z') // DST off in NY
    const next = nextFireTime(
      { kind: 'cron', expression: '0 9 * * *', timezone: 'America/New_York' },
      now,
    )
    expect(next).toBe('2026-01-16T14:00:00.000Z')
  })
})

describe('createSchedule + persistence', () => {
  it('writes a JSON file at the canonical path and round-trips through readSchedule', async () => {
    const entry = await createSchedule({
      home,
      agentName: 'hobby',
      description: 'check inbox',
      prompt: 'read pub messages and summarize anything new',
      timing: { kind: 'interval', interval_seconds: 900 },
      id: 'sched_abc',
      now: () => new Date('2026-04-29T12:00:00.000Z'),
    })
    expect(entry.id).toBe('sched_abc')
    expect(entry.next_fire_at).toBe('2026-04-29T12:15:00.000Z')

    const reread = await readSchedule(home, 'hobby', 'sched_abc')
    expect(reread.prompt).toBe('read pub messages and summarize anything new')
    expect(reread.timing).toEqual({ kind: 'interval', interval_seconds: 900 })
  })

  it('refuses to create a schedule with an invalid cron expression', async () => {
    await expect(
      createSchedule({
        home,
        agentName: 'hobby',
        prompt: 'noop',
        timing: { kind: 'cron', expression: 'this is not a cron', timezone: 'UTC' },
      }),
    ).rejects.toThrow(ScheduleError)
  })

  it('defaults enabled: true when not specified', async () => {
    const entry = await createSchedule({
      home,
      agentName: 'hobby',
      prompt: 'hi',
      timing: { kind: 'interval', interval_seconds: 60 },
    })
    expect(entry.enabled).toBe(true)
  })
})

describe('listSchedules', () => {
  it('returns [] when the schedules dir does not exist', async () => {
    expect(await listSchedules(home, 'no-such-agent')).toEqual([])
  })

  it('lists schedules sorted by created_at ascending', async () => {
    const t = (iso: string) => () => new Date(iso)
    await createSchedule({
      home,
      agentName: 'hobby',
      prompt: 'a',
      timing: { kind: 'interval', interval_seconds: 60 },
      id: 'sched_a',
      now: t('2026-04-29T10:00:00.000Z'),
    })
    await createSchedule({
      home,
      agentName: 'hobby',
      prompt: 'b',
      timing: { kind: 'interval', interval_seconds: 60 },
      id: 'sched_b',
      now: t('2026-04-29T11:00:00.000Z'),
    })
    await createSchedule({
      home,
      agentName: 'hobby',
      prompt: 'c',
      timing: { kind: 'interval', interval_seconds: 60 },
      id: 'sched_c',
      now: t('2026-04-29T09:00:00.000Z'),
    })
    const list = await listSchedules(home, 'hobby')
    expect(list.map((e) => e.id)).toEqual(['sched_c', 'sched_a', 'sched_b'])
  })

  it('isolates schedules per Agent', async () => {
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
    const hobby = await listSchedules(home, 'hobby')
    const simon = await listSchedules(home, 'simon')
    expect(hobby.map((e) => e.id)).toEqual(['sched_h'])
    expect(simon.map((e) => e.id)).toEqual(['sched_s'])
  })
})

describe('setScheduleEnabled', () => {
  it('disabling clears next_fire_at; re-enabling recomputes it', async () => {
    const created = await createSchedule({
      home,
      agentName: 'hobby',
      prompt: 'p',
      timing: { kind: 'interval', interval_seconds: 60 },
      id: 'sched_t',
      now: () => new Date('2026-04-29T12:00:00.000Z'),
    })
    expect(created.next_fire_at).toBe('2026-04-29T12:01:00.000Z')

    const disabled = await setScheduleEnabled(home, 'hobby', 'sched_t', false)
    expect(disabled.enabled).toBe(false)
    expect(disabled.next_fire_at).toBeNull()

    const reenabled = await setScheduleEnabled(
      home,
      'hobby',
      'sched_t',
      true,
      () => new Date('2026-04-29T13:00:00.000Z'),
    )
    expect(reenabled.enabled).toBe(true)
    expect(reenabled.next_fire_at).toBe('2026-04-29T13:01:00.000Z')
  })
})

describe('recordFired', () => {
  it('updates last_fired_at and recomputes next_fire_at forward', async () => {
    await createSchedule({
      home,
      agentName: 'hobby',
      prompt: 'p',
      timing: { kind: 'interval', interval_seconds: 60 },
      id: 'sched_f',
      now: () => new Date('2026-04-29T12:00:00.000Z'),
    })
    const fired = await recordFired(
      home,
      'hobby',
      'sched_f',
      () => new Date('2026-04-29T12:30:00.000Z'),
    )
    expect(fired.last_fired_at).toBe('2026-04-29T12:30:00.000Z')
    expect(fired.next_fire_at).toBe('2026-04-29T12:31:00.000Z')
  })
})

describe('deleteSchedule', () => {
  it('removes the file', async () => {
    await createSchedule({
      home,
      agentName: 'hobby',
      prompt: 'p',
      timing: { kind: 'interval', interval_seconds: 60 },
      id: 'sched_del',
    })
    await deleteSchedule(home, 'hobby', 'sched_del')
    const list = await listSchedules(home, 'hobby')
    expect(list).toHaveLength(0)
  })

  it('is idempotent when the schedule does not exist', async () => {
    await expect(deleteSchedule(home, 'hobby', 'missing')).resolves.not.toThrow()
  })
})
