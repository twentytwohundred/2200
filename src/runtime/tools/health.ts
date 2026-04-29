/**
 * Per-Agent tool health (Epic 9 Phase C-2).
 *
 * Reads the run records the dispatcher writes to
 *
 *   <brain>/.records/run/<task_id>/<call_id>.md
 *
 * and aggregates them per-tool: total calls, last call, success /
 * failure counts, recent failure window, dormant flag.
 *
 * Output:
 *   - `aggregateToolHealth(brainDir, opts?) -> ToolHealthSummary` ...
 *     pure aggregation; no I/O outside reading the records.
 *   - `renderToolHealthMd(summary, opts?) -> string` ... markdown for
 *     `<brain>/tool_health.md`.
 *
 * Phase C-2 ships the aggregator, the markdown rendering, and a CLI
 * command that surfaces them. The dispatcher already writes the
 * underlying RunRecords; no schema change needed. Phase C-3 will add
 * cost-behavior loop detection on top of this same dataset.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as YAML from 'yaml'
import { recordsRoot } from './records.js'

const DEFAULT_DORMANT_THRESHOLD_DAYS = 30
const DEFAULT_RECENT_FAILURE_WINDOW = 20

export interface ToolHealthEntry {
  tool: string
  total_calls: number
  ok_calls: number
  error_calls: number
  /** ISO timestamp of the most recent call, null if never called. */
  last_called_at: string | null
  /** ISO timestamp of the most recent failure. */
  last_error_at: string | null
  /** Failure rate over the last N calls (DEFAULT_RECENT_FAILURE_WINDOW). 0..1. */
  recent_failure_rate: number
  /** Mean duration in ms across all recorded calls. */
  mean_duration_ms: number
  /** True when no call observed within the dormant threshold. */
  dormant: boolean
}

export interface ToolHealthSummary {
  agent: string
  generated_at: string
  total_records: number
  /** Tools with calls, sorted by name. */
  tools: ToolHealthEntry[]
  /** Convenience: dormant subset (last call older than threshold or never). */
  dormant: ToolHealthEntry[]
  /** Convenience: failing subset (recent_failure_rate > 0.25, at least 4 recent calls). */
  failing: ToolHealthEntry[]
  options: {
    dormant_threshold_days: number
    recent_failure_window: number
  }
}

export interface AggregateOptions {
  /** Treat tools as dormant after this many days of inactivity. */
  dormantThresholdDays?: number
  /** Window over which `recent_failure_rate` is computed. */
  recentFailureWindow?: number
  /** Inject for tests. Default = new Date(). */
  now?: () => Date
}

interface RawCall {
  tool: string
  ts_end: string
  duration_ms: number
  ok: boolean
}

export async function aggregateToolHealth(
  brainDir: string,
  agentName: string,
  opts: AggregateOptions = {},
): Promise<ToolHealthSummary> {
  const dormantDays = opts.dormantThresholdDays ?? DEFAULT_DORMANT_THRESHOLD_DAYS
  const recentWindow = opts.recentFailureWindow ?? DEFAULT_RECENT_FAILURE_WINDOW
  const now = opts.now ? opts.now() : new Date()
  const dormantCutoff = now.getTime() - dormantDays * 24 * 60 * 60_000

  const calls = await readAllRunRecords(brainDir)
  const byTool = new Map<string, RawCall[]>()
  for (const call of calls) {
    const list = byTool.get(call.tool) ?? []
    list.push(call)
    byTool.set(call.tool, list)
  }

  const tools: ToolHealthEntry[] = []
  for (const [tool, list] of byTool) {
    list.sort((a, b) => Date.parse(a.ts_end) - Date.parse(b.ts_end))
    const total = list.length
    const okCount = list.filter((c) => c.ok).length
    const errCount = total - okCount
    const last = list[list.length - 1]
    const lastErr = [...list].reverse().find((c) => !c.ok)
    const recent = list.slice(-recentWindow)
    const recentErrors = recent.filter((c) => !c.ok).length
    const recentFailureRate = recent.length === 0 ? 0 : recentErrors / recent.length
    const meanDuration = total === 0 ? 0 : list.reduce((sum, c) => sum + c.duration_ms, 0) / total
    const lastCalledAt = last?.ts_end ?? null
    const dormant = lastCalledAt === null ? true : Date.parse(lastCalledAt) < dormantCutoff
    tools.push({
      tool,
      total_calls: total,
      ok_calls: okCount,
      error_calls: errCount,
      last_called_at: lastCalledAt,
      last_error_at: lastErr?.ts_end ?? null,
      recent_failure_rate: recentFailureRate,
      mean_duration_ms: meanDuration,
      dormant,
    })
  }
  tools.sort((a, b) => a.tool.localeCompare(b.tool))

  const dormantList = tools.filter((t) => t.dormant)
  const failing = tools.filter(
    (t) => t.recent_failure_rate > 0.25 && Math.min(t.total_calls, recentWindow) >= 4,
  )

  return {
    agent: agentName,
    generated_at: now.toISOString(),
    total_records: calls.length,
    tools,
    dormant: dormantList,
    failing,
    options: {
      dormant_threshold_days: dormantDays,
      recent_failure_window: recentWindow,
    },
  }
}

async function readAllRunRecords(brainDir: string): Promise<RawCall[]> {
  const root = join(recordsRoot(brainDir), 'run')
  const calls: RawCall[] = []
  let taskDirs: string[]
  try {
    taskDirs = await readdir(root)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return calls
    throw err
  }
  for (const taskDir of taskDirs) {
    const taskRoot = join(root, taskDir)
    let files: string[]
    try {
      files = await readdir(taskRoot)
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.md')) continue
      const path = join(taskRoot, file)
      try {
        const raw = await readFile(path, 'utf-8')
        const fm = parseFrontmatter(raw)
        if (fm === null) continue
        const tool = typeof fm['tool'] === 'string' ? fm['tool'] : null
        const tsEnd = typeof fm['ts_end'] === 'string' ? fm['ts_end'] : null
        const dur = typeof fm['duration_ms'] === 'number' ? fm['duration_ms'] : 0
        const errorBlock = fm['error']
        const ok = errorBlock === null || errorBlock === undefined
        if (tool === null || tsEnd === null) continue
        calls.push({ tool, ts_end: tsEnd, duration_ms: dur, ok })
      } catch {
        // skip torn / unreadable record
      }
    }
  }
  return calls
}

function parseFrontmatter(raw: string): Record<string, unknown> | null {
  const m = /^---\n([\s\S]*?)\n---/u.exec(raw)
  if (!m || typeof m[1] !== 'string') return null
  try {
    const parsed: unknown = YAML.parse(m[1])
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
  } catch {
    return null
  }
  return null
}

/**
 * Markdown renderer for `<brain>/tool_health.md`. The format is intended
 * to be human-skimmable and `git diff`-able. Sorted sections; no
 * timestamp inside the rendering body so identical aggregations diff
 * cleanly day to day (the `generated_at` lives in the header for
 * provenance only).
 */
export function renderToolHealthMd(summary: ToolHealthSummary): string {
  const lines: string[] = []
  lines.push(`# Tool health for ${summary.agent}`)
  lines.push('')
  lines.push(`Generated: ${summary.generated_at}`)
  lines.push(
    `Records analyzed: ${String(summary.total_records)} run record${summary.total_records === 1 ? '' : 's'}`,
  )
  lines.push(
    `Dormant threshold: ${String(summary.options.dormant_threshold_days)} days; recent-failure window: ${String(summary.options.recent_failure_window)} calls.`,
  )
  lines.push('')

  if (summary.failing.length > 0) {
    lines.push('## Failing')
    lines.push('')
    lines.push('| Tool | Recent failure rate | Total | Errors | Last error |')
    lines.push('|---|---|---|---|---|')
    for (const t of summary.failing) {
      lines.push(
        `| \`${t.tool}\` | ${pct(t.recent_failure_rate)} | ${String(t.total_calls)} | ${String(t.error_calls)} | ${t.last_error_at ?? '...'} |`,
      )
    }
    lines.push('')
  }

  if (summary.dormant.length > 0) {
    lines.push('## Dormant')
    lines.push('')
    lines.push('| Tool | Last called | Total |')
    lines.push('|---|---|---|')
    for (const t of summary.dormant) {
      lines.push(`| \`${t.tool}\` | ${t.last_called_at ?? 'never'} | ${String(t.total_calls)} |`)
    }
    lines.push('')
  }

  lines.push('## All tools')
  lines.push('')
  if (summary.tools.length === 0) {
    lines.push('_(no tool calls recorded yet)_')
  } else {
    lines.push('| Tool | Total | Errors | Mean ms | Last called |')
    lines.push('|---|---|---|---|---|')
    for (const t of summary.tools) {
      lines.push(
        `| \`${t.tool}\` | ${String(t.total_calls)} | ${String(t.error_calls)} | ${t.mean_duration_ms.toFixed(0)} | ${t.last_called_at ?? '...'} |`,
      )
    }
  }

  return `${lines.join('\n')}\n`
}

function pct(v: number): string {
  return `${(v * 100).toFixed(0)}%`
}
