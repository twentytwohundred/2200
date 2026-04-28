/**
 * Tests for the JSONL TelemetryWriter (Epic 4.5).
 *
 * Cover:
 *  - Single-record write produces a parseable JSONL line at the
 *    expected path.
 *  - Schema_version + every required field present.
 *  - Multiple records on the same day append (no overwrites).
 *  - Day rollover: a record with a different ts goes to a different
 *    file.
 *  - cached_tokens null when omitted; populated when supplied.
 *  - Missing pricing (cost_usd: null) round-trips correctly.
 *  - Error status records still write.
 *  - Concurrent writes (two records in parallel) both land.
 *  - Per-Agent isolation: writers for different Agents land in
 *    different directories.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TelemetryWriter,
  TELEMETRY_RECORD_SCHEMA_VERSION,
  type TelemetryRecord,
} from '../../../src/runtime/telemetry/writer.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-telemetry-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function parseLines(text: string): TelemetryRecord[] {
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as TelemetryRecord)
}

describe('TelemetryWriter (single record)', () => {
  it('writes one JSONL record with all required fields populated', async () => {
    const writer = new TelemetryWriter(home, 'hobby')
    await writer.recordModelCall({
      taskId: 'task_01H',
      provider: 'anthropic',
      modelId: 'claude-opus-4-7',
      inputTokens: 200,
      outputTokens: 50,
      cachedTokens: 1800,
      costUsd: 0.0327,
      status: 'ok',
      durationMs: 4521,
      ts: '2026-04-28T15:23:14.521Z',
    })

    const path = join(home, 'state', 'telemetry', 'hobby', '2026-04-28.jsonl')
    const text = await readFile(path, 'utf8')
    const records = parseLines(text)
    expect(records).toHaveLength(1)
    const r = records[0]!
    expect(r.schema_version).toBe(TELEMETRY_RECORD_SCHEMA_VERSION)
    expect(r.ts).toBe('2026-04-28T15:23:14.521Z')
    expect(r.task_id).toBe('task_01H')
    expect(r.agent_id).toBe('hobby')
    expect(r.provider).toBe('anthropic')
    expect(r.model_id).toBe('claude-opus-4-7')
    expect(r.input_tokens).toBe(200)
    expect(r.output_tokens).toBe(50)
    expect(r.cached_tokens).toBe(1800)
    expect(r.cost_usd).toBe(0.0327)
    expect(r.status).toBe('ok')
    expect(r.duration_ms).toBe(4521)
  })

  it('records null cached_tokens when not supplied', async () => {
    const writer = new TelemetryWriter(home, 'simon')
    await writer.recordModelCall({
      taskId: null,
      provider: 'kimi',
      modelId: 'moonshot-v1-128k',
      inputTokens: 500,
      outputTokens: 25,
      costUsd: 0.0006,
      status: 'ok',
      durationMs: 800,
      ts: '2026-04-28T01:00:00.000Z',
    })
    const path = join(home, 'state', 'telemetry', 'simon', '2026-04-28.jsonl')
    const records = parseLines(await readFile(path, 'utf8'))
    expect(records[0]!.cached_tokens).toBeNull()
    expect(records[0]!.task_id).toBeNull()
  })

  it('records null cost_usd when pricing is unknown', async () => {
    const writer = new TelemetryWriter(home, 'hobby')
    await writer.recordModelCall({
      taskId: 'task_x',
      provider: 'unknown',
      modelId: 'unknown-99',
      inputTokens: 100,
      outputTokens: 10,
      costUsd: null,
      status: 'ok',
      durationMs: 250,
      ts: '2026-04-28T05:00:00.000Z',
    })
    const path = join(home, 'state', 'telemetry', 'hobby', '2026-04-28.jsonl')
    const records = parseLines(await readFile(path, 'utf8'))
    expect(records[0]!.cost_usd).toBeNull()
  })

  it('records error-status calls (zero tokens, null cost)', async () => {
    const writer = new TelemetryWriter(home, 'hobby')
    await writer.recordModelCall({
      taskId: 'task_x',
      provider: 'anthropic',
      modelId: 'claude-opus-4-7',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      status: 'error',
      durationMs: 12,
      ts: '2026-04-28T06:00:00.000Z',
    })
    const path = join(home, 'state', 'telemetry', 'hobby', '2026-04-28.jsonl')
    const records = parseLines(await readFile(path, 'utf8'))
    expect(records[0]!.status).toBe('error')
    expect(records[0]!.input_tokens).toBe(0)
    expect(records[0]!.cost_usd).toBeNull()
  })
})

describe('TelemetryWriter (multiple records)', () => {
  it('appends multiple records on the same day in order', async () => {
    const writer = new TelemetryWriter(home, 'hobby')
    for (let i = 0; i < 3; i += 1) {
      await writer.recordModelCall({
        taskId: `task_${String(i)}`,
        provider: 'deepseek',
        modelId: 'deepseek-chat',
        inputTokens: 100 + i,
        outputTokens: 10 + i,
        costUsd: 0.01 + i * 0.01,
        status: 'ok',
        durationMs: 200 + i * 10,
        ts: `2026-04-28T0${String(i)}:00:00.000Z`,
      })
    }
    const path = join(home, 'state', 'telemetry', 'hobby', '2026-04-28.jsonl')
    const records = parseLines(await readFile(path, 'utf8'))
    expect(records).toHaveLength(3)
    expect(records.map((r) => r.task_id)).toEqual(['task_0', 'task_1', 'task_2'])
    expect(records.map((r) => r.input_tokens)).toEqual([100, 101, 102])
  })

  it('partitions across days based on the UTC date in ts', async () => {
    const writer = new TelemetryWriter(home, 'hobby')
    await writer.recordModelCall({
      taskId: 't1',
      provider: 'anthropic',
      modelId: 'claude-opus-4-7',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      status: 'ok',
      durationMs: 1,
      ts: '2026-04-28T23:59:59.999Z',
    })
    await writer.recordModelCall({
      taskId: 't2',
      provider: 'anthropic',
      modelId: 'claude-opus-4-7',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      status: 'ok',
      durationMs: 1,
      ts: '2026-04-29T00:00:00.000Z',
    })
    const dir = join(home, 'state', 'telemetry', 'hobby')
    const entries = await readdir(dir)
    expect(entries.sort()).toEqual(['2026-04-28.jsonl', '2026-04-29.jsonl'])
    const day1 = parseLines(await readFile(join(dir, '2026-04-28.jsonl'), 'utf8'))
    const day2 = parseLines(await readFile(join(dir, '2026-04-29.jsonl'), 'utf8'))
    expect(day1.map((r) => r.task_id)).toEqual(['t1'])
    expect(day2.map((r) => r.task_id)).toEqual(['t2'])
  })

  it('handles concurrent writes without dropping records', async () => {
    const writer = new TelemetryWriter(home, 'hobby')
    const writes = Array.from({ length: 10 }, (_, i) =>
      writer.recordModelCall({
        taskId: `task_${String(i)}`,
        provider: 'anthropic',
        modelId: 'claude-opus-4-7',
        inputTokens: i,
        outputTokens: i,
        costUsd: i * 0.001,
        status: 'ok',
        durationMs: 100,
        ts: '2026-04-28T12:00:00.000Z',
      }),
    )
    await Promise.all(writes)
    const path = join(home, 'state', 'telemetry', 'hobby', '2026-04-28.jsonl')
    const records = parseLines(await readFile(path, 'utf8'))
    expect(records).toHaveLength(10)
    // Order is not guaranteed under concurrent writes, but every task_id should be present.
    expect(records.map((r) => r.task_id).sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `task_${String(i)}`).sort(),
    )
  })
})

describe('TelemetryWriter (per-Agent isolation)', () => {
  it('writes different agents to different directories', async () => {
    const hobby = new TelemetryWriter(home, 'hobby')
    const simon = new TelemetryWriter(home, 'simon')
    await hobby.recordModelCall({
      taskId: 'h1',
      provider: 'anthropic',
      modelId: 'claude-opus-4-7',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      status: 'ok',
      durationMs: 1,
      ts: '2026-04-28T05:00:00.000Z',
    })
    await simon.recordModelCall({
      taskId: 's1',
      provider: 'anthropic',
      modelId: 'claude-opus-4-7',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      status: 'ok',
      durationMs: 1,
      ts: '2026-04-28T05:00:00.000Z',
    })

    const hobbyDir = join(home, 'state', 'telemetry', 'hobby')
    const simonDir = join(home, 'state', 'telemetry', 'simon')
    const hobbyRecords = parseLines(await readFile(join(hobbyDir, '2026-04-28.jsonl'), 'utf8'))
    const simonRecords = parseLines(await readFile(join(simonDir, '2026-04-28.jsonl'), 'utf8'))
    expect(hobbyRecords[0]!.agent_id).toBe('hobby')
    expect(hobbyRecords[0]!.task_id).toBe('h1')
    expect(simonRecords[0]!.agent_id).toBe('simon')
    expect(simonRecords[0]!.task_id).toBe('s1')
  })
})
