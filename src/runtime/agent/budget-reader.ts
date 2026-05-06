/**
 * Per-Agent budget reader (Epic 4.5 + Epic 15 Phase B Budget screen).
 *
 * The BudgetTracker (Epic 4.5) writes per-day state to:
 *
 *   <home>/state/budget/<agent_name>/<YYYY-MM-DD>.json
 *
 * Plus an optional `override.json` sibling that lifts the daily block
 * for a user-chosen window. This module exposes a read-only view over
 * those files for the HTTP API and any future inspector ... mirrors
 * the pulse reader pattern.
 *
 * The supervisor lives in a different process from the AgentProcess
 * that owns the BudgetTracker, so reading directly from the
 * tracker's in-memory state is not possible. Reading from disk is
 * the cross-process surface ... atomic-write-on-the-other-side means
 * a torn state never appears here.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { agentBudgetDir } from '../storage/layout.js'

export const BUDGET_STATE_SCHEMA_VERSION = 1 as const

export const BudgetStateSchema = z.object({
  schema_version: z.literal(BUDGET_STATE_SCHEMA_VERSION),
  /** UTC day, "YYYY-MM-DD". */
  day: z.string().min(1),
  agent: z.string().min(1),
  cumulative_usd: z.number().nonnegative(),
  cap_usd: z.number().nonnegative(),
  warn_at_pct: z.number().nonnegative(),
  warned_today: z.boolean(),
  blocked: z.boolean(),
  /** ISO timestamp of the most recent record. Null until first record. */
  last_recorded_at: z.string().nullable(),
})
export type BudgetState = z.infer<typeof BudgetStateSchema>

export const BudgetOverrideSchema = z.object({
  schema_version: z.number().int().nonnegative(),
  /** Until-when the override holds. ISO. */
  until: z.string().min(1),
  /** Optional reason the user supplied. */
  reason: z.string().optional(),
})
export type BudgetOverride = z.infer<typeof BudgetOverrideSchema>

/**
 * Compose UTC `YYYY-MM-DD` string from a Date. Inlined rather than
 * imported from BudgetTracker so the reader has no dependency on the
 * tracker module (which lives on the AgentProcess side).
 */
export function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10)
}

/**
 * Read a single day's budget state. Returns null when the file does
 * not exist (Agent has never spent on that day). Throws on malformed
 * JSON or schema mismatch.
 */
export async function readBudgetStateForDay(
  home: string,
  agentName: string,
  day: string,
): Promise<BudgetState | null> {
  const path = join(agentBudgetDir(home, agentName), `${day}.json`)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const parsed = JSON.parse(raw) as unknown
  return BudgetStateSchema.parse(parsed)
}

/**
 * Read the override file, or null when none. Used by the API to
 * surface "block lifted until X" alongside the day's state.
 */
export async function readBudgetOverride(
  home: string,
  agentName: string,
): Promise<BudgetOverride | null> {
  const path = join(agentBudgetDir(home, agentName), 'override.json')
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const parsed = JSON.parse(raw) as unknown
  return BudgetOverrideSchema.parse(parsed)
}

/**
 * Convenience: read today's state (or null when no spend yet today).
 */
export async function readBudgetStateToday(
  home: string,
  agentName: string,
  now: () => Date = () => new Date(),
): Promise<BudgetState | null> {
  return await readBudgetStateForDay(home, agentName, utcDay(now()))
}

/**
 * List every day-file under the Agent's budget dir, oldest first.
 * Used by the Budget screen to populate the spend-history sparkline.
 * Tolerates a missing dir (returns []) and skips any entry that fails
 * to parse against the schema (logs are not the reader's job).
 */
export async function listBudgetHistory(home: string, agentName: string): Promise<BudgetState[]> {
  const dir = agentBudgetDir(home, agentName)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: BudgetState[] = []
  for (const name of entries) {
    if (name === 'override.json') continue
    if (!name.endsWith('.json')) continue
    const day = name.slice(0, name.length - '.json'.length)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
    try {
      const path = join(dir, name)
      const raw = await readFile(path, 'utf8')
      const parsed = BudgetStateSchema.parse(JSON.parse(raw))
      out.push(parsed)
    } catch {
      // Skip malformed entries; the reader's contract is best-effort.
    }
  }
  out.sort((a, b) => a.day.localeCompare(b.day))
  return out
}
