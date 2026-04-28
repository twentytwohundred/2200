/**
 * Tests for the per-Agent BudgetTracker (Epic 4.5 PR D).
 *
 * Cover:
 *  - init() with no telemetry → cumulative 0, not blocked, state file written
 *  - init() with prior-day telemetry → ignored (different day)
 *  - init() replays today's JSONL → cumulative reflects sum
 *  - init() detects "already over cap" on cold start → blocked = true
 *  - record() updates cumulative, persists, fires no notification below warn
 *  - record() crosses warn threshold → fires tier-2 notification once only
 *  - record() crosses cap → fires tier-1 notification, sets blocked
 *  - record() with null cost → no-op
 *  - record() across day rollover resets cumulative + flags
 *  - isBlocked() returns true once cap is hit
 *  - snapshot() reflects current state including last_recorded_at
 *  - state file replay matches snapshot
 *  - notification frontmatter has the right tier/kind/agent
 *  - record() before init() throws
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BudgetTracker,
  type BudgetState,
  BUDGET_NOTIFICATION_KIND_BLOCK,
  BUDGET_NOTIFICATION_KIND_WARN,
} from '../../../src/runtime/agent/budget-tracker.js'
import { homePaths, agentTelemetryDir } from '../../../src/runtime/storage/layout.js'
import { initHome } from '../../../src/runtime/storage/init.js'
import { parse as parseYaml } from 'yaml'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-budget-'))
  await initHome(home)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

const fixedTime = (iso: string) => () => new Date(iso)

async function seedTelemetry(
  agentName: string,
  day: string,
  costsUsd: (number | null)[],
): Promise<void> {
  const dir = agentTelemetryDir(home, agentName)
  await mkdir(dir, { recursive: true })
  const lines = costsUsd.map((c, i) =>
    JSON.stringify({
      schema_version: 1,
      ts: `${day}T0${String(i)}:00:00.000Z`,
      task_id: `task_${String(i)}`,
      agent_id: agentName,
      provider: 'anthropic',
      model_id: 'claude-opus-4-7',
      input_tokens: 100,
      output_tokens: 50,
      cached_tokens: null,
      cost_usd: c,
      status: 'ok',
      duration_ms: 250,
    }),
  )
  await writeFile(join(dir, `${day}.jsonl`), lines.join('\n') + '\n', 'utf8')
}

async function readNotifications(): Promise<
  { frontmatter: Record<string, unknown>; body: string }[]
> {
  const dir = homePaths(home).stateNotifications
  const entries = await readdir(dir).catch(() => [])
  const out: { frontmatter: Record<string, unknown>; body: string }[] = []
  const re = /^---\n([\s\S]+?)\n---\n([\s\S]*)$/
  for (const e of entries) {
    if (!e.endsWith('.md')) continue
    const text = await readFile(join(dir, e), 'utf8')
    const m = re.exec(text)
    if (!m) continue
    out.push({ frontmatter: parseYaml(m[1]!) as Record<string, unknown>, body: m[2]! })
  }
  return out
}

async function readBudgetState(agentName: string, day: string): Promise<BudgetState> {
  const path = join(home, 'state', 'budget', agentName, `${day}.json`)
  return JSON.parse(await readFile(path, 'utf8')) as BudgetState
}

describe('BudgetTracker init() (cold start)', () => {
  it('with no telemetry, cumulative is 0 and not blocked; state file written', async () => {
    const tracker = new BudgetTracker({
      agentName: 'hobby',
      home,
      capUsd: 10,
      now: fixedTime('2026-04-28T12:00:00.000Z'),
    })
    await tracker.init()
    expect(tracker.getCumulative()).toBe(0)
    expect(tracker.isBlocked()).toBe(false)

    const state = await readBudgetState('hobby', '2026-04-28')
    expect(state).toEqual({
      schema_version: 1,
      day: '2026-04-28',
      agent: 'hobby',
      cumulative_usd: 0,
      cap_usd: 10,
      warn_at_pct: 80,
      warned_today: false,
      blocked: false,
      last_recorded_at: null,
    })
  })

  it("ignores yesterday's JSONL when computing today's cumulative", async () => {
    await seedTelemetry('hobby', '2026-04-27', [5.0, 3.0]) // yesterday
    const tracker = new BudgetTracker({
      agentName: 'hobby',
      home,
      capUsd: 10,
      now: fixedTime('2026-04-28T08:00:00.000Z'),
    })
    await tracker.init()
    expect(tracker.getCumulative()).toBe(0)
    expect(tracker.isBlocked()).toBe(false)
  })

  it("replays today's telemetry and sums cost_usd into cumulative", async () => {
    await seedTelemetry('hobby', '2026-04-28', [1.5, 2.25, 0.5])
    const tracker = new BudgetTracker({
      agentName: 'hobby',
      home,
      capUsd: 10,
      now: fixedTime('2026-04-28T12:00:00.000Z'),
    })
    await tracker.init()
    expect(tracker.getCumulative()).toBeCloseTo(4.25, 6)
  })

  it('skips telemetry lines with cost_usd: null', async () => {
    await seedTelemetry('hobby', '2026-04-28', [1.0, null, 2.0])
    const tracker = new BudgetTracker({
      agentName: 'hobby',
      home,
      capUsd: 10,
      now: fixedTime('2026-04-28T12:00:00.000Z'),
    })
    await tracker.init()
    expect(tracker.getCumulative()).toBeCloseTo(3.0, 6)
  })

  it('detects already-over-cap on cold start (e.g., process restart) and sets blocked', async () => {
    await seedTelemetry('hobby', '2026-04-28', [6.0, 5.0]) // sum = 11, cap 10
    const tracker = new BudgetTracker({
      agentName: 'hobby',
      home,
      capUsd: 10,
      now: fixedTime('2026-04-28T12:00:00.000Z'),
    })
    await tracker.init()
    expect(tracker.isBlocked()).toBe(true)
  })

  it('tolerates a torn last line in the JSONL (crash mid-write)', async () => {
    await seedTelemetry('hobby', '2026-04-28', [1.0])
    // Append a half-written line
    const dir = agentTelemetryDir(home, 'hobby')
    await writeFile(
      join(dir, '2026-04-28.jsonl'),
      `${JSON.stringify({ schema_version: 1, cost_usd: 1.0 })}\n{"schema_version":1,"cost_usd":2`,
      'utf8',
    )
    const tracker = new BudgetTracker({
      agentName: 'hobby',
      home,
      capUsd: 10,
      now: fixedTime('2026-04-28T12:00:00.000Z'),
    })
    await tracker.init()
    expect(tracker.getCumulative()).toBeCloseTo(1.0, 6)
  })
})

describe('BudgetTracker record() (warn threshold)', () => {
  it('crosses warn threshold once → fires tier-2 notification with budget_warn kind', async () => {
    const tracker = new BudgetTracker({
      agentName: 'hobby',
      home,
      capUsd: 10,
      warnAtPct: 80,
      now: fixedTime('2026-04-28T12:00:00.000Z'),
    })
    await tracker.init()
    await tracker.record(7.99) // below warn (8.0)
    let notifs = await readNotifications()
    expect(notifs).toHaveLength(0)

    await tracker.record(0.02) // crosses warn at 8.01
    notifs = await readNotifications()
    expect(notifs).toHaveLength(1)
    const fm = notifs[0]!.frontmatter
    expect(fm['tier']).toBe('important')
    expect(fm['kind']).toBe(BUDGET_NOTIFICATION_KIND_WARN)
    expect(fm['agent']).toBe('hobby')
    expect(fm['cap_usd']).toBe(10)
    expect(fm['warn_at_pct']).toBe(80)
    expect(notifs[0]!.body).toContain('80%')
    expect(notifs[0]!.body).toContain('hobby')
  })

  it('does not fire warn notification a second time within the same day', async () => {
    const tracker = new BudgetTracker({
      agentName: 'hobby',
      home,
      capUsd: 10,
      warnAtPct: 80,
      now: fixedTime('2026-04-28T12:00:00.000Z'),
    })
    await tracker.init()
    await tracker.record(8.01)
    await tracker.record(0.5)
    await tracker.record(0.5)
    const notifs = await readNotifications()
    // Exactly one warn notification; no block because still under cap.
    expect(
      notifs.filter((n) => n.frontmatter['kind'] === BUDGET_NOTIFICATION_KIND_WARN),
    ).toHaveLength(1)
    expect(
      notifs.filter((n) => n.frontmatter['kind'] === BUDGET_NOTIFICATION_KIND_BLOCK),
    ).toHaveLength(0)
  })

  it('fires both warn AND block when a single record crosses both thresholds', async () => {
    const tracker = new BudgetTracker({
      agentName: 'hobby',
      home,
      capUsd: 10,
      warnAtPct: 80,
      now: fixedTime('2026-04-28T12:00:00.000Z'),
    })
    await tracker.init()
    await tracker.record(15.0) // jumps from 0 over both 8.0 and 10.0
    const notifs = await readNotifications()
    expect(
      notifs.filter((n) => n.frontmatter['kind'] === BUDGET_NOTIFICATION_KIND_WARN),
    ).toHaveLength(1)
    expect(
      notifs.filter((n) => n.frontmatter['kind'] === BUDGET_NOTIFICATION_KIND_BLOCK),
    ).toHaveLength(1)
    expect(tracker.isBlocked()).toBe(true)
  })

  it('does not fire warn when init() finds we are already past warn (silent recovery)', async () => {
    await seedTelemetry('hobby', '2026-04-28', [9.0]) // already over warn
    const tracker = new BudgetTracker({
      agentName: 'hobby',
      home,
      capUsd: 10,
      warnAtPct: 80,
      now: fixedTime('2026-04-28T12:00:00.000Z'),
    })
    await tracker.init()
    await tracker.record(0.5) // total 9.5, still under cap
    const notifs = await readNotifications()
    // No notifications: warn already crossed before this process started
    // (no first-crossing event observed). The point of the warn is to
    // fire on the moment of crossing, not retroactively.
    expect(notifs).toHaveLength(0)
  })
})

describe('BudgetTracker record() (block threshold)', () => {
  it('crosses cap → fires tier-1 notification with budget_block kind, sets blocked', async () => {
    const tracker = new BudgetTracker({
      agentName: 'hobby',
      home,
      capUsd: 10,
      now: fixedTime('2026-04-28T12:00:00.000Z'),
    })
    await tracker.init()
    expect(tracker.isBlocked()).toBe(false)

    await tracker.record(11)
    expect(tracker.isBlocked()).toBe(true)

    const notifs = await readNotifications()
    const blockNotif = notifs.find((n) => n.frontmatter['kind'] === BUDGET_NOTIFICATION_KIND_BLOCK)
    expect(blockNotif).toBeDefined()
    expect(blockNotif!.frontmatter['tier']).toBe('critical')
    expect(blockNotif!.body).toContain('blocked')
    expect(blockNotif!.body).toContain('override')
  })

  it('does not re-fire block notification after subsequent records', async () => {
    const tracker = new BudgetTracker({
      agentName: 'hobby',
      home,
      capUsd: 10,
      now: fixedTime('2026-04-28T12:00:00.000Z'),
    })
    await tracker.init()
    await tracker.record(11)
    await tracker.record(2)
    await tracker.record(5)
    const notifs = await readNotifications()
    expect(
      notifs.filter((n) => n.frontmatter['kind'] === BUDGET_NOTIFICATION_KIND_BLOCK),
    ).toHaveLength(1)
  })
})

describe('BudgetTracker record() (no-op cases)', () => {
  it('null cost is a no-op (does not crash, does not change cumulative)', async () => {
    const tracker = new BudgetTracker({
      agentName: 'hobby',
      home,
      capUsd: 10,
      now: fixedTime('2026-04-28T12:00:00.000Z'),
    })
    await tracker.init()
    await tracker.record(null)
    expect(tracker.getCumulative()).toBe(0)
  })

  it('zero cost is a no-op', async () => {
    const tracker = new BudgetTracker({
      agentName: 'hobby',
      home,
      capUsd: 10,
      now: fixedTime('2026-04-28T12:00:00.000Z'),
    })
    await tracker.init()
    await tracker.record(0)
    expect(tracker.getCumulative()).toBe(0)
  })

  it('record() before init() throws', async () => {
    const tracker = new BudgetTracker({
      agentName: 'hobby',
      home,
      capUsd: 10,
      now: fixedTime('2026-04-28T12:00:00.000Z'),
    })
    await expect(tracker.record(1)).rejects.toThrow(/before init/)
  })
})

describe('BudgetTracker day rollover', () => {
  it('a record that crosses UTC midnight resets cumulative + flags', async () => {
    let now = new Date('2026-04-28T23:00:00.000Z')
    const tracker = new BudgetTracker({
      agentName: 'hobby',
      home,
      capUsd: 10,
      now: () => now,
    })
    await tracker.init()
    await tracker.record(11) // blocked on Apr 28
    expect(tracker.isBlocked()).toBe(true)

    now = new Date('2026-04-29T00:30:00.000Z') // new UTC day
    await tracker.record(1) // first record of Apr 29
    expect(tracker.getCumulative()).toBeCloseTo(1, 6)
    expect(tracker.isBlocked()).toBe(false)

    // Two state files now exist, one per day.
    const dir = join(home, 'state', 'budget', 'hobby')
    const entries = (await readdir(dir)).filter((e) => e.endsWith('.json'))
    expect(entries.sort()).toEqual(['2026-04-28.json', '2026-04-29.json'])
  })
})

describe('BudgetTracker snapshot() and state file', () => {
  it('snapshot fields match what the loader reads back from disk', async () => {
    const tracker = new BudgetTracker({
      agentName: 'hobby',
      home,
      capUsd: 25,
      warnAtPct: 50,
      now: fixedTime('2026-04-28T15:23:14.521Z'),
    })
    await tracker.init()
    await tracker.record(2.0)

    const snap = tracker.snapshot()
    expect(snap.cumulative_usd).toBe(2.0)
    expect(snap.cap_usd).toBe(25)
    expect(snap.warn_at_pct).toBe(50)
    expect(snap.warned_today).toBe(false)
    expect(snap.blocked).toBe(false)
    expect(snap.last_recorded_at).toBe('2026-04-28T15:23:14.521Z')

    const stored = await readBudgetState('hobby', '2026-04-28')
    expect(stored).toEqual(snap)
  })
})
