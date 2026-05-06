import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  EXTENSION_SCHEDULE_SCHEMA_VERSION,
  deleteExtensionSchedule,
  extensionScheduleJobKey,
  listAllExtensionSchedules,
  listExtensionSchedules,
  nextExtensionFireTime,
  reconcileExtensionSchedules,
  recordExtensionScheduleFired,
  validateCron,
  writeExtensionSchedule,
} from '../../../src/runtime/extensions/schedules.js'
import { ScheduleError } from '../../../src/runtime/scheduler/schedule.js'
import { mkdir, writeFile } from 'node:fs/promises'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-ext-sched-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('validateCron / nextExtensionFireTime', () => {
  it('accepts standard 5-field cron', () => {
    expect(() => {
      validateCron('*/5 * * * *')
    }).not.toThrow()
  })

  it('rejects malformed cron with ScheduleError', () => {
    expect(() => {
      validateCron('not a cron')
    }).toThrow(ScheduleError)
  })

  it('computes a future fire time for a valid cron', () => {
    const now = new Date('2026-05-06T12:00:00Z')
    const next = nextExtensionFireTime('0 */1 * * *', now)
    expect(next).toBe('2026-05-06T13:00:00.000Z')
  })

  it('returns null for a cron parser cannot parse', () => {
    expect(nextExtensionFireTime('invalid cron')).toBeNull()
  })
})

describe('writeExtensionSchedule', () => {
  it('writes the entry with computed next_fire_at', async () => {
    const fixed = new Date('2026-05-06T12:00:00Z')
    const entry = await writeExtensionSchedule({
      home,
      extensionName: 'demo',
      extensionVersion: '0.1.0',
      schedule: { id: 'tick-1', cron: '0 */1 * * *', description: 'every hour' },
      now: () => fixed,
    })
    expect(entry.schema_version).toBe(EXTENSION_SCHEDULE_SCHEMA_VERSION)
    expect(entry.id).toBe('tick-1')
    expect(entry.cron).toBe('0 */1 * * *')
    expect(entry.next_fire_at).toBe('2026-05-06T13:00:00.000Z')
    expect(entry.last_fired_at).toBeNull()
    expect(entry.enabled).toBe(true)
  })

  it('refuses an invalid cron at write time', async () => {
    await expect(
      writeExtensionSchedule({
        home,
        extensionName: 'bad',
        extensionVersion: '0.1.0',
        schedule: { id: 'tick-1', cron: 'not a cron' },
      }),
    ).rejects.toBeInstanceOf(ScheduleError)
  })

  it('preserves last_fired_at + enabled when provided', async () => {
    const fixed = new Date('2026-05-06T12:00:00Z')
    const entry = await writeExtensionSchedule({
      home,
      extensionName: 'preserve',
      extensionVersion: '0.2.0',
      schedule: { id: 'tick-1', cron: '0 */1 * * *' },
      now: () => fixed,
      preserve: { last_fired_at: '2026-05-05T20:00:00.000Z', enabled: false },
    })
    expect(entry.last_fired_at).toBe('2026-05-05T20:00:00.000Z')
    expect(entry.enabled).toBe(false)
    // disabled entries get null next_fire_at so the scheduler skips arming
    expect(entry.next_fire_at).toBeNull()
  })
})

describe('listExtensionSchedules', () => {
  it('returns [] for missing dir', async () => {
    expect(await listExtensionSchedules(home, 'nope')).toEqual([])
  })

  it('returns entries sorted by id', async () => {
    await writeExtensionSchedule({
      home,
      extensionName: 'multi',
      extensionVersion: '0.1.0',
      schedule: { id: 'beta', cron: '*/5 * * * *' },
    })
    await writeExtensionSchedule({
      home,
      extensionName: 'multi',
      extensionVersion: '0.1.0',
      schedule: { id: 'alpha', cron: '0 * * * *' },
    })
    const list = await listExtensionSchedules(home, 'multi')
    expect(list.map((e) => e.id)).toEqual(['alpha', 'beta'])
  })

  it('skips malformed entries silently', async () => {
    await writeExtensionSchedule({
      home,
      extensionName: 'mixed',
      extensionVersion: '0.1.0',
      schedule: { id: 'good', cron: '*/5 * * * *' },
    })
    const dir = join(home, 'state', 'extensions', 'mixed', 'schedules')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'broken.json'), 'not json', 'utf8')
    const list = await listExtensionSchedules(home, 'mixed')
    expect(list.map((e) => e.id)).toEqual(['good'])
  })
})

describe('listAllExtensionSchedules', () => {
  it('aggregates across every extension dir', async () => {
    // Two distinct extensions each with one schedule. The function
    // walks <home>/extensions/* (the static dirs) so we mkdir those
    // before persisting state.
    await mkdir(join(home, 'extensions', 'foo'), { recursive: true })
    await mkdir(join(home, 'extensions', 'bar'), { recursive: true })
    await writeExtensionSchedule({
      home,
      extensionName: 'foo',
      extensionVersion: '0.1.0',
      schedule: { id: 'tick-1', cron: '*/5 * * * *' },
    })
    await writeExtensionSchedule({
      home,
      extensionName: 'bar',
      extensionVersion: '0.2.0',
      schedule: { id: 'tick-1', cron: '0 */1 * * *' },
    })
    const all = await listAllExtensionSchedules(home)
    expect(all.map((e) => `${e.extension_name}:${e.id}`).sort()).toEqual([
      'bar:tick-1',
      'foo:tick-1',
    ])
  })

  it('returns [] when no extensions exist', async () => {
    expect(await listAllExtensionSchedules(home)).toEqual([])
  })
})

describe('deleteExtensionSchedule', () => {
  it('removes the file', async () => {
    await writeExtensionSchedule({
      home,
      extensionName: 'go',
      extensionVersion: '0.1.0',
      schedule: { id: 'tick-1', cron: '*/5 * * * *' },
    })
    await deleteExtensionSchedule(home, 'go', 'tick-1')
    expect(await listExtensionSchedules(home, 'go')).toEqual([])
  })

  it('tolerates absent file', async () => {
    await expect(deleteExtensionSchedule(home, 'nope', 'tick-1')).resolves.not.toThrow()
  })
})

describe('recordExtensionScheduleFired', () => {
  it('updates last_fired_at + recomputes next_fire_at', async () => {
    const t0 = new Date('2026-05-06T12:00:00Z')
    await writeExtensionSchedule({
      home,
      extensionName: 'fired',
      extensionVersion: '0.1.0',
      schedule: { id: 'tick-1', cron: '0 */1 * * *' },
      now: () => t0,
    })
    const t1 = new Date('2026-05-06T13:00:00Z')
    const updated = await recordExtensionScheduleFired(home, 'fired', 'tick-1', () => t1)
    expect(updated.last_fired_at).toBe('2026-05-06T13:00:00.000Z')
    expect(updated.next_fire_at).toBe('2026-05-06T14:00:00.000Z')
  })
})

describe('reconcileExtensionSchedules', () => {
  it('writes new + deletes removed + preserves overlap', async () => {
    // Seed two pre-existing entries.
    await writeExtensionSchedule({
      home,
      extensionName: 'recon',
      extensionVersion: '0.1.0',
      schedule: { id: 'keeper', cron: '0 * * * *' },
    })
    await writeExtensionSchedule({
      home,
      extensionName: 'recon',
      extensionVersion: '0.1.0',
      schedule: { id: 'goner', cron: '*/5 * * * *' },
    })
    // Manifest now has keeper (unchanged) + freshie (new), no goner.
    const final = await reconcileExtensionSchedules({
      home,
      extensionName: 'recon',
      extensionVersion: '0.2.0',
      manifestSchedules: [
        { id: 'keeper', cron: '0 * * * *' },
        { id: 'freshie', cron: '*/15 * * * *' },
      ],
    })
    expect(final.map((e) => e.id)).toEqual(['freshie', 'keeper'])
    const onDisk = await listExtensionSchedules(home, 'recon')
    expect(onDisk.map((e) => e.id)).toEqual(['freshie', 'keeper'])
    // extension_version refreshes on reconcile
    expect(onDisk.every((e) => e.extension_version === '0.2.0')).toBe(true)
  })

  it('preserves last_fired_at + enabled across reconcile for unchanged ids', async () => {
    await writeExtensionSchedule({
      home,
      extensionName: 'pres',
      extensionVersion: '0.1.0',
      schedule: { id: 'tick-1', cron: '0 * * * *' },
    })
    await recordExtensionScheduleFired(
      home,
      'pres',
      'tick-1',
      () => new Date('2026-05-06T13:00:00Z'),
    )
    const final = await reconcileExtensionSchedules({
      home,
      extensionName: 'pres',
      extensionVersion: '0.2.0',
      manifestSchedules: [{ id: 'tick-1', cron: '0 * * * *' }],
    })
    expect(final[0]?.last_fired_at).toBe('2026-05-06T13:00:00.000Z')
  })
})

describe('extensionScheduleJobKey', () => {
  it('produces the documented composite key shape', () => {
    expect(extensionScheduleJobKey('foo', 'bar')).toBe('extension:foo:bar')
  })
})
