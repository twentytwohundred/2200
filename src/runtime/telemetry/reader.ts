/**
 * Telemetry reader and aggregator (Epic 4.5 PR F).
 *
 * Walks the per-Agent JSONL files written by the TelemetryWriter
 * and produces the data backing the `2200 usage` CLI: per-Agent,
 * per-model, per-provider, and per-task rollups for a chosen date
 * range.
 *
 * The reader is read-only and stateless. It does not coordinate with
 * a running supervisor or BudgetTracker; the JSONL files are the
 * single source of truth for spend.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { agentTelemetryDir, homePaths } from '../storage/layout.js'
import type { TelemetryRecord } from './writer.js'

export interface DateRange {
  /** UTC day, "YYYY-MM-DD". Inclusive. */
  start: string
  /** UTC day, "YYYY-MM-DD". Inclusive. */
  end: string
}

/** Inputs for `readTelemetry`. All filters are optional. */
export interface ReadTelemetryOptions {
  /** Filter to one Agent's records. Reads all when undefined. */
  agentName?: string
  /** Date range. Inclusive on both ends. */
  range: DateRange
}

/** Sum of token counts; the dashboard prints these. */
export interface TokenTotals {
  input_tokens: number
  output_tokens: number
  cached_tokens: number
}

/** Aggregate over any group of records: agent, model, provider, day, task. */
export interface UsageBucket {
  /** The grouping key (agent name, "provider/model", provider, day, or task id). */
  key: string
  cost_usd: number
  /** Records that had cost_usd: null are tracked separately for surfacing. */
  cost_unknown_count: number
  tokens: TokenTotals
  records: number
}

export interface UsageAggregations {
  byAgent: UsageBucket[]
  byProvider: UsageBucket[]
  byModel: UsageBucket[]
  byDay: UsageBucket[]
  byTask: UsageBucket[]
  total: UsageBucket
}

/**
 * Compute the inclusive UTC date range for the named preset. Dates
 * are returned as "YYYY-MM-DD" strings; the `now` parameter is
 * injectable for tests.
 */
export function rangeForPreset(
  preset: 'day' | 'week' | 'month',
  now: Date = new Date(),
): DateRange {
  const end = now.toISOString().slice(0, 10)
  const startDate = new Date(now)
  if (preset === 'day') {
    return { start: end, end }
  }
  const days = preset === 'week' ? 6 : 29
  startDate.setUTCDate(startDate.getUTCDate() - days)
  return { start: startDate.toISOString().slice(0, 10), end }
}

/**
 * Resolve a `--since YYYY-MM-DD` flag into an inclusive range that
 * ends today.
 */
export function rangeSince(since: string, now: Date = new Date()): DateRange {
  return { start: since, end: now.toISOString().slice(0, 10) }
}

/**
 * Walk every UTC-day JSONL file in the requested range for the named
 * Agents and return a flat array of records. Lines that fail to
 * parse (torn last line on crash) are skipped.
 */
export async function readTelemetry(
  home: string,
  opts: ReadTelemetryOptions,
): Promise<TelemetryRecord[]> {
  const agents = opts.agentName ? [opts.agentName] : await listAgentsWithTelemetry(home)
  const days = enumerateDays(opts.range)
  const out: TelemetryRecord[] = []
  for (const agent of agents) {
    for (const day of days) {
      const path = join(agentTelemetryDir(home, agent), `${day}.jsonl`)
      let raw: string
      try {
        raw = await readFile(path, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw err
      }
      for (const line of raw.split('\n')) {
        if (line.length === 0) continue
        try {
          out.push(JSON.parse(line) as TelemetryRecord)
        } catch {
          // Tolerate torn final line.
        }
      }
    }
  }
  return out
}

/** Discover Agent names from the telemetry root, even ones without an Identity loaded. */
export async function listAgentsWithTelemetry(home: string): Promise<string[]> {
  const root = homePaths(home).stateTelemetry
  try {
    return (await readdir(root)).sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

/**
 * Build one bucket per group key. The aggregator below applies this
 * to five different keying strategies.
 */
function bucketize(
  records: TelemetryRecord[],
  keyFn: (r: TelemetryRecord) => string,
): UsageBucket[] {
  const map = new Map<string, UsageBucket>()
  for (const r of records) {
    const key = keyFn(r)
    let bucket = map.get(key)
    if (!bucket) {
      bucket = {
        key,
        cost_usd: 0,
        cost_unknown_count: 0,
        tokens: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 },
        records: 0,
      }
      map.set(key, bucket)
    }
    if (typeof r.cost_usd === 'number') {
      bucket.cost_usd += r.cost_usd
    } else {
      bucket.cost_unknown_count += 1
    }
    bucket.tokens.input_tokens += r.input_tokens
    bucket.tokens.output_tokens += r.output_tokens
    bucket.tokens.cached_tokens += r.cached_tokens ?? 0
    bucket.records += 1
  }
  return Array.from(map.values()).sort((a, b) => b.cost_usd - a.cost_usd)
}

/**
 * Compute every grouping at once. Cheap relative to the JSONL parse,
 * and the dashboard wants several views available without re-reading
 * the data.
 */
export function aggregate(records: TelemetryRecord[]): UsageAggregations {
  const byAgent = bucketize(records, (r) => r.agent_id)
  const byProvider = bucketize(records, (r) => r.provider)
  const byModel = bucketize(records, (r) => `${r.provider}/${r.model_id}`)
  const byDay = bucketize(records, (r) => r.ts.slice(0, 10))
  const byTask = bucketize(records, (r) => r.task_id ?? '(no task)')

  const total: UsageBucket = {
    key: 'total',
    cost_usd: 0,
    cost_unknown_count: 0,
    tokens: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 },
    records: records.length,
  }
  for (const r of records) {
    if (typeof r.cost_usd === 'number') total.cost_usd += r.cost_usd
    else total.cost_unknown_count += 1
    total.tokens.input_tokens += r.input_tokens
    total.tokens.output_tokens += r.output_tokens
    total.tokens.cached_tokens += r.cached_tokens ?? 0
  }

  return { byAgent, byProvider, byModel, byDay, byTask, total }
}

/** Inclusive enumeration of UTC day strings between start and end. */
function enumerateDays(range: DateRange): string[] {
  const out: string[] = []
  const start = new Date(`${range.start}T00:00:00.000Z`)
  const end = new Date(`${range.end}T00:00:00.000Z`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return out
  for (let d = new Date(start); d.getTime() <= end.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}
