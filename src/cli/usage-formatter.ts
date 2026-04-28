/**
 * Formatters for `2200 usage` (Epic 4.5 PR F).
 *
 * Pure printers... given a set of buckets and a range, produce a
 * monospace-aligned table on stdout. Console output is the reason
 * these live here rather than in the reader; the data layer should
 * not know about ANSI colors or column widths.
 *
 * Color discipline (per [[2026-04-24-cost-behavior-shape]] color-blindness
 * obligation): every color cue has a non-color companion (a status
 * marker like `*`, `!`, or `(over)`). Users with monochrome terminals
 * or color-blindness still get the signal.
 */
import type { DateRange, UsageBucket } from '../runtime/telemetry/reader.js'
import { agentPaths } from '../runtime/storage/layout.js'
import { loadIdentity } from '../runtime/identity/loader.js'

export function formatUsd(n: number): string {
  if (n >= 100) return `$${n.toFixed(2)}`
  if (n >= 1) return `$${n.toFixed(2)}`
  if (n >= 0.01) return `$${n.toFixed(3)}`
  if (n === 0) return '$0.00'
  return `$${n.toFixed(4)}`
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function formatPct(numerator: number, denominator: number): string {
  if (denominator <= 0) return '  -'
  const pct = (numerator / denominator) * 100
  if (pct >= 100) return `${pct.toFixed(0)}%!`
  if (pct >= 1) return `${pct.toFixed(0)}%`
  if (pct === 0) return '0%'
  return '<1%'
}

function rangeLine(range: DateRange): string {
  return range.start === range.end
    ? `Range: ${range.start}`
    : `Range: ${range.start} to ${range.end}`
}

/**
 * The default rendering: one row per Agent, with cap + pct progress.
 * Reads each Agent's cost_caps.daily_usd from its Identity to print
 * the cap column. Works only for today's view; other ranges have no
 * sensible single-cap meaning, and should call printSimpleBuckets.
 */
export async function printByAgent(
  home: string,
  buckets: UsageBucket[],
  total: UsageBucket,
  range: DateRange,
  now: Date,
): Promise<void> {
  const today = now.toISOString().slice(0, 10)
  const isTodayOnly = range.start === today && range.end === today

  // Read each Agent's cap from its Identity. Agents without an Identity
  // file (e.g., brand-new telemetry from a now-deleted Agent) get '-'.
  const caps = new Map<string, number | null>()
  for (const b of buckets) {
    caps.set(b.key, await loadCapForAgent(home, b.key))
  }

  console.log(rangeLine(range))
  console.log('')

  if (isTodayOnly) {
    console.log(pad(['Agent', 'Spend', 'Cap', 'Pct', 'Tasks', 'Tokens (in/out/cached)']))
    console.log(divider(['Agent', 'Spend', 'Cap', 'Pct', 'Tasks', 'Tokens (in/out/cached)']))
    for (const b of buckets) {
      const cap = caps.get(b.key) ?? null
      const pct = cap !== null ? formatPct(b.cost_usd, cap) : '  -'
      console.log(
        pad([
          b.key,
          formatUsd(b.cost_usd),
          cap !== null ? formatUsd(cap) : '-',
          pct,
          String(b.records),
          tokensColumn(b),
        ]),
      )
    }
    if (buckets.length > 1) {
      console.log(divider(['Agent', 'Spend', 'Cap', 'Pct', 'Tasks', 'Tokens (in/out/cached)']))
      const sumCap = sumCaps(caps)
      console.log(
        pad([
          'total',
          formatUsd(total.cost_usd),
          sumCap !== null ? formatUsd(sumCap) : '-',
          sumCap !== null ? formatPct(total.cost_usd, sumCap) : '  -',
          String(total.records),
          tokensColumn(total),
        ]),
      )
    }
  } else {
    // Multi-day view: omit cap and pct columns.
    console.log(pad(['Agent', 'Spend', 'Tasks', 'Tokens (in/out/cached)']))
    console.log(divider(['Agent', 'Spend', 'Tasks', 'Tokens (in/out/cached)']))
    for (const b of buckets) {
      console.log(pad([b.key, formatUsd(b.cost_usd), String(b.records), tokensColumn(b)]))
    }
    if (buckets.length > 1) {
      console.log(divider(['Agent', 'Spend', 'Tasks', 'Tokens (in/out/cached)']))
      console.log(
        pad(['total', formatUsd(total.cost_usd), String(total.records), tokensColumn(total)]),
      )
    }
  }
}

/**
 * Generic single-key rollup: provider, model, day, task. No cap column.
 */
export function printSimpleBuckets(
  keyHeader: string,
  buckets: UsageBucket[],
  total: UsageBucket,
  range: DateRange,
): void {
  console.log(rangeLine(range))
  console.log('')
  console.log(pad([keyHeader, 'Spend', 'Calls', 'Tokens (in/out/cached)']))
  console.log(divider([keyHeader, 'Spend', 'Calls', 'Tokens (in/out/cached)']))
  for (const b of buckets) {
    console.log(pad([b.key, formatUsd(b.cost_usd), String(b.records), tokensColumn(b)]))
  }
  if (buckets.length > 1) {
    console.log(divider([keyHeader, 'Spend', 'Calls', 'Tokens (in/out/cached)']))
    console.log(
      pad(['total', formatUsd(total.cost_usd), String(total.records), tokensColumn(total)]),
    )
  }
}

// --- helpers -----------------------------------------------------------------

function tokensColumn(b: UsageBucket): string {
  const t = b.tokens
  return `${formatTokens(t.input_tokens)} / ${formatTokens(t.output_tokens)} / ${formatTokens(t.cached_tokens)}`
}

const COL_WIDTHS = [16, 10, 10, 8, 8, 30]

function pad(cells: string[]): string {
  return cells
    .map((cell, i) => {
      const w = COL_WIDTHS[i] ?? 12
      return cell.padEnd(w)
    })
    .join(' ')
    .trimEnd()
}

function divider(headers: string[]): string {
  return headers
    .map((_, i) => {
      const w = COL_WIDTHS[i] ?? 12
      return '-'.repeat(w)
    })
    .join(' ')
}

async function loadCapForAgent(home: string, agentName: string): Promise<number | null> {
  try {
    const id = await loadIdentity(agentPaths(home, agentName).identity)
    return id.frontmatter.cost_caps.daily_usd
  } catch {
    return null
  }
}

function sumCaps(caps: Map<string, number | null>): number | null {
  let total = 0
  let any = false
  for (const v of caps.values()) {
    if (v !== null) {
      total += v
      any = true
    }
  }
  return any ? total : null
}
