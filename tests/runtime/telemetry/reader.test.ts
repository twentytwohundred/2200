/**
 * Tests for the telemetry reader + aggregator (Epic 4.5 PR F).
 *
 * Cover:
 *  - rangeForPreset day/week/month + rangeSince produce inclusive UTC days
 *  - readTelemetry walks every UTC-day file in range across multiple Agents
 *  - readTelemetry honors agentName filter
 *  - listAgentsWithTelemetry returns sorted directory listing, [] when empty
 *  - aggregate produces byAgent / byProvider / byModel / byDay / byTask plus total
 *  - cost_unknown_count tracks null cost rows separately
 *  - sort by descending cost within each grouping
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  aggregate,
  readTelemetry,
  rangeForPreset,
  rangeSince,
  listAgentsWithTelemetry,
  type DateRange,
} from '../../../src/runtime/telemetry/reader.js'
import { agentTelemetryDir } from '../../../src/runtime/storage/layout.js'
import { initHome } from '../../../src/runtime/storage/init.js'
import type { TelemetryRecord } from '../../../src/runtime/telemetry/writer.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-reader-'))
  await initHome(home)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

interface SeedRecord {
  agent: string
  day: string
  ts?: string
  task_id?: string | null
  provider?: string
  model_id?: string
  cost_usd?: number | null
  input_tokens?: number
  output_tokens?: number
  cached_tokens?: number | null
}

async function seed(records: SeedRecord[]): Promise<void> {
  const byPath = new Map<string, string[]>()
  for (const r of records) {
    const dir = agentTelemetryDir(home, r.agent)
    const path = join(dir, `${r.day}.jsonl`)
    if (!byPath.has(path)) byPath.set(path, [])
    const rec: TelemetryRecord = {
      schema_version: 1,
      ts: r.ts ?? `${r.day}T12:00:00.000Z`,
      task_id: r.task_id === undefined ? `task_${r.agent}_${r.day}` : r.task_id,
      agent_id: r.agent,
      provider: r.provider ?? 'anthropic',
      model_id: r.model_id ?? 'claude-opus-4-7',
      input_tokens: r.input_tokens ?? 100,
      output_tokens: r.output_tokens ?? 50,
      cached_tokens: r.cached_tokens ?? null,
      cost_usd: r.cost_usd === undefined ? 0.01 : r.cost_usd,
      status: 'ok',
      duration_ms: 250,
    }
    byPath.get(path)!.push(JSON.stringify(rec))
  }
  for (const [path, lines] of byPath) {
    const dir = path.replace(/\/[^/]+$/, '')
    await mkdir(dir, { recursive: true })
    await writeFile(path, lines.join('\n') + '\n', 'utf8')
  }
}

describe('rangeForPreset', () => {
  const now = new Date('2026-04-28T12:00:00.000Z')

  it('day: start === end === today (UTC)', () => {
    expect(rangeForPreset('day', now)).toEqual({ start: '2026-04-28', end: '2026-04-28' })
  })

  it('week: 7 days inclusive ending today', () => {
    expect(rangeForPreset('week', now)).toEqual({ start: '2026-04-22', end: '2026-04-28' })
  })

  it('month: 30 days inclusive ending today', () => {
    expect(rangeForPreset('month', now)).toEqual({ start: '2026-03-30', end: '2026-04-28' })
  })

  it('rangeSince: starts at the given date, ends today', () => {
    expect(rangeSince('2026-04-20', now)).toEqual({ start: '2026-04-20', end: '2026-04-28' })
  })
})

describe('readTelemetry', () => {
  it('returns [] when no Agents have telemetry', async () => {
    const range: DateRange = { start: '2026-04-28', end: '2026-04-28' }
    expect(await readTelemetry(home, { range })).toEqual([])
  })

  it('reads every UTC-day file in range across multiple Agents', async () => {
    await seed([
      { agent: 'hobby', day: '2026-04-26', cost_usd: 1.0 },
      { agent: 'hobby', day: '2026-04-27', cost_usd: 2.0 },
      { agent: 'hobby', day: '2026-04-28', cost_usd: 3.0 },
      { agent: 'simon', day: '2026-04-28', cost_usd: 0.5 },
    ])
    const range: DateRange = { start: '2026-04-26', end: '2026-04-28' }
    const records = await readTelemetry(home, { range })
    expect(records).toHaveLength(4)
  })

  it('honors agentName filter', async () => {
    await seed([
      { agent: 'hobby', day: '2026-04-28', cost_usd: 1.0 },
      { agent: 'simon', day: '2026-04-28', cost_usd: 0.5 },
    ])
    const range: DateRange = { start: '2026-04-28', end: '2026-04-28' }
    const records = await readTelemetry(home, { range, agentName: 'hobby' })
    expect(records).toHaveLength(1)
    expect(records[0]!.agent_id).toBe('hobby')
  })

  it('skips out-of-range days even when files exist', async () => {
    await seed([
      { agent: 'hobby', day: '2026-04-25', cost_usd: 1.0 },
      { agent: 'hobby', day: '2026-04-28', cost_usd: 2.0 },
    ])
    const range: DateRange = { start: '2026-04-27', end: '2026-04-28' }
    const records = await readTelemetry(home, { range })
    expect(records).toHaveLength(1)
    expect(records[0]!.cost_usd).toBe(2.0)
  })

  it('tolerates a torn last line on disk', async () => {
    const dir = agentTelemetryDir(home, 'hobby')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, '2026-04-28.jsonl'),
      `${JSON.stringify({ schema_version: 1, agent_id: 'hobby', cost_usd: 1.0, ts: '2026-04-28T12:00:00.000Z', task_id: 't', provider: 'a', model_id: 'm', input_tokens: 1, output_tokens: 1, cached_tokens: null, status: 'ok', duration_ms: 1 })}\n{"schema_version":1,"cost_usd":2`,
      'utf8',
    )
    const range: DateRange = { start: '2026-04-28', end: '2026-04-28' }
    const records = await readTelemetry(home, { range })
    expect(records).toHaveLength(1)
  })
})

describe('listAgentsWithTelemetry', () => {
  it('returns [] for an empty home', async () => {
    expect(await listAgentsWithTelemetry(home)).toEqual([])
  })

  it('returns sorted Agent names from the telemetry root', async () => {
    await seed([
      { agent: 'simon', day: '2026-04-28', cost_usd: 0.5 },
      { agent: 'hobby', day: '2026-04-28', cost_usd: 1.0 },
    ])
    expect(await listAgentsWithTelemetry(home)).toEqual(['hobby', 'simon'])
  })
})

describe('aggregate', () => {
  it('byAgent rolls up multiple records to one bucket per Agent', async () => {
    await seed([
      { agent: 'hobby', day: '2026-04-28', cost_usd: 1.0, input_tokens: 100, output_tokens: 50 },
      { agent: 'hobby', day: '2026-04-28', cost_usd: 2.5, input_tokens: 200, output_tokens: 60 },
      { agent: 'simon', day: '2026-04-28', cost_usd: 0.5, input_tokens: 50, output_tokens: 10 },
    ])
    const range: DateRange = { start: '2026-04-28', end: '2026-04-28' }
    const records = await readTelemetry(home, { range })
    const agg = aggregate(records)
    expect(agg.byAgent).toHaveLength(2)
    const hobby = agg.byAgent.find((b) => b.key === 'hobby')!
    expect(hobby.cost_usd).toBeCloseTo(3.5, 6)
    expect(hobby.records).toBe(2)
    expect(hobby.tokens.input_tokens).toBe(300)
    expect(hobby.tokens.output_tokens).toBe(110)
  })

  it('sorts buckets by descending cost', async () => {
    await seed([
      { agent: 'simon', day: '2026-04-28', cost_usd: 0.5 },
      { agent: 'hobby', day: '2026-04-28', cost_usd: 5.0 },
      { agent: 'poe', day: '2026-04-28', cost_usd: 1.0 },
    ])
    const range: DateRange = { start: '2026-04-28', end: '2026-04-28' }
    const agg = aggregate(await readTelemetry(home, { range }))
    expect(agg.byAgent.map((b) => b.key)).toEqual(['hobby', 'poe', 'simon'])
  })

  it('byModel keys on provider/model_id', async () => {
    await seed([
      {
        agent: 'hobby',
        day: '2026-04-28',
        provider: 'anthropic',
        model_id: 'claude-opus-4-7',
        cost_usd: 1.0,
      },
      {
        agent: 'hobby',
        day: '2026-04-28',
        provider: 'deepseek',
        model_id: 'deepseek-chat',
        cost_usd: 0.5,
      },
    ])
    const range: DateRange = { start: '2026-04-28', end: '2026-04-28' }
    const agg = aggregate(await readTelemetry(home, { range }))
    expect(agg.byModel.map((b) => b.key).sort()).toEqual([
      'anthropic/claude-opus-4-7',
      'deepseek/deepseek-chat',
    ])
  })

  it('byDay rolls up across multiple days', async () => {
    await seed([
      { agent: 'hobby', day: '2026-04-26', cost_usd: 1.0 },
      { agent: 'hobby', day: '2026-04-27', cost_usd: 2.0 },
      { agent: 'hobby', day: '2026-04-28', cost_usd: 3.0 },
    ])
    const range: DateRange = { start: '2026-04-26', end: '2026-04-28' }
    const agg = aggregate(await readTelemetry(home, { range }))
    expect(agg.byDay).toHaveLength(3)
    expect(agg.byDay.find((b) => b.key === '2026-04-28')!.cost_usd).toBeCloseTo(3.0, 6)
  })

  it('cost_unknown_count tracks records with cost_usd: null separately', async () => {
    await seed([
      { agent: 'hobby', day: '2026-04-28', cost_usd: 1.0 },
      { agent: 'hobby', day: '2026-04-28', cost_usd: null },
      { agent: 'hobby', day: '2026-04-28', cost_usd: null },
    ])
    const range: DateRange = { start: '2026-04-28', end: '2026-04-28' }
    const agg = aggregate(await readTelemetry(home, { range }))
    expect(agg.byAgent[0]!.cost_usd).toBeCloseTo(1.0, 6)
    expect(agg.byAgent[0]!.cost_unknown_count).toBe(2)
    expect(agg.byAgent[0]!.records).toBe(3)
    expect(agg.total.cost_unknown_count).toBe(2)
  })
})
