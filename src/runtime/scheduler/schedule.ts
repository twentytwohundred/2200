/**
 * Schedule entry persistence + cron parsing (Epic 6 PR A).
 *
 * A schedule entry tells the supervisor's Scheduler (PR B) when to
 * enqueue a synthetic task for a specific Agent. Each entry lives at
 *
 *   <home>/state/agents/<agent_name>/schedules/<schedule_id>.json
 *
 * One file per entry so schedules add/remove/enable cleanly without
 * touching shared state. The Scheduler scans this directory at startup
 * and re-scans on disk events from the CLI.
 *
 * Two firing shapes supported at v1:
 *   - cron: standard 5-field cron expression in a configurable timezone
 *           (default UTC). Backed by `cron-parser`.
 *   - interval_seconds: simple "every N seconds" interval. Useful for
 *           short-tick checks ("read pub messages every 60 seconds").
 *
 * `prompt` is the synthetic task body the Scheduler enqueues. The
 * Agent loop receives it like any other task, runs the model→tool
 * cycle, and emits notifications / writes Brain notes / etc. as
 * normal.
 *
 * `enabled` lets users pause a schedule without deleting it.
 *
 * Catch-up policy on missed firings (e.g., the supervisor was down
 * when the schedule should have fired): v1 always SKIPS missed
 * firings. The Scheduler computes the next fire time forward from
 * `Date.now()`, so a schedule that should have fired hourly while
 * the supervisor was offline for a day fires once when the
 * supervisor comes back, not 24 times. Operators who need
 * "catch up missed firings" can re-run via `2200 schedule run-once`.
 */
import { readFile, readdir, mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { CronExpressionParser } from 'cron-parser'
import { atomicWriteJson } from '../util/atomic-write.js'
import { agentSchedulesDir } from '../storage/layout.js'
import { newScheduleId } from '../util/id.js'

export const SCHEDULE_SCHEMA_VERSION = 1

/**
 * Cron form: 5-field standard cron in a named IANA timezone (or UTC).
 * Validation goes through `CronExpressionParser.parse` so we reject
 * malformed expressions at write time.
 */
export const ScheduleCronSchema = z.object({
  kind: z.literal('cron'),
  expression: z.string().min(1),
  /** IANA timezone string. Defaults to UTC. */
  timezone: z.string().default('UTC'),
})

/** Interval form: every N seconds. Minimum 5s to prevent thrash. */
export const ScheduleIntervalSchema = z.object({
  kind: z.literal('interval'),
  interval_seconds: z.number().int().min(5),
})

export const ScheduleTimingSchema = z.discriminatedUnion('kind', [
  ScheduleCronSchema,
  ScheduleIntervalSchema,
])
export type ScheduleTiming = z.infer<typeof ScheduleTimingSchema>

export const ScheduleEntrySchema = z.object({
  schema_version: z.literal(1),
  id: z.string().min(1),
  /** Agent that fires the synthetic task. Must match the parent dir's name. */
  agent: z.string().min(1),
  /** Free-form description; surfaced in `2200 schedule list`. */
  description: z.string().default(''),
  /** Synthetic task body the Scheduler enqueues on firing. */
  prompt: z.string().min(1),
  timing: ScheduleTimingSchema,
  enabled: z.boolean().default(true),
  created_at: z.string().min(1),
  /** ISO timestamp of the most recent successful fire. Null until first fire. */
  last_fired_at: z.string().nullable().default(null),
  /**
   * ISO timestamp of the next computed fire time. Recomputed by the
   * Scheduler on load and after every fire.
   */
  next_fire_at: z.string().nullable().default(null),
})
export type ScheduleEntry = z.infer<typeof ScheduleEntrySchema>

export class ScheduleError extends Error {}

/**
 * Validate the timing block by parsing the cron expression (for
 * cron timing) so a malformed schedule never reaches disk.
 */
export function validateTiming(timing: ScheduleTiming): void {
  if (timing.kind === 'cron') {
    try {
      CronExpressionParser.parse(timing.expression, { tz: timing.timezone })
    } catch (err) {
      throw new ScheduleError(
        `invalid cron expression "${timing.expression}" (tz: ${timing.timezone}): ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}

/**
 * Compute the next fire timestamp (ISO, UTC) for a schedule. Looks
 * forward from `now`. Returns null when the timing produces no
 * future occurrences (cron expressions can be exhausted in theory;
 * intervals never are).
 */
export function nextFireTime(timing: ScheduleTiming, now: Date = new Date()): string | null {
  if (timing.kind === 'interval') {
    const next = new Date(now.getTime() + timing.interval_seconds * 1000)
    return next.toISOString()
  }
  // cron
  try {
    const it = CronExpressionParser.parse(timing.expression, {
      tz: timing.timezone,
      currentDate: now,
    })
    const next = it.next()
    return next.toDate().toISOString()
  } catch {
    return null
  }
}

export interface CreateScheduleArgs {
  home: string
  agentName: string
  description?: string
  prompt: string
  timing: ScheduleTiming
  enabled?: boolean
  /** Override id (testing). */
  id?: string
  /** Override created_at (testing). */
  now?: () => Date
}

/**
 * Create + persist a new schedule entry. Validates the timing block
 * (parsing the cron expression if applicable) before writing.
 */
export async function createSchedule(args: CreateScheduleArgs): Promise<ScheduleEntry> {
  validateTiming(args.timing)
  const now = args.now ?? (() => new Date())
  const id = args.id ?? newScheduleId()
  const entry: ScheduleEntry = {
    schema_version: SCHEDULE_SCHEMA_VERSION,
    id,
    agent: args.agentName,
    description: args.description ?? '',
    prompt: args.prompt,
    timing: args.timing,
    enabled: args.enabled ?? true,
    created_at: now().toISOString(),
    last_fired_at: null,
    next_fire_at: nextFireTime(args.timing, now()),
  }
  await persistSchedule(args.home, entry)
  return entry
}

/**
 * Load all schedule entries for an Agent. Tolerates malformed files
 * (logs a warning equivalent at the call site; this function returns
 * only valid entries).
 */
export async function listSchedules(home: string, agentName: string): Promise<ScheduleEntry[]> {
  const dir = agentSchedulesDir(home, agentName)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: ScheduleEntry[] = []
  for (const e of entries) {
    if (!e.endsWith('.json')) continue
    const path = join(dir, e)
    try {
      const raw = await readFile(path, 'utf8')
      const parsed = ScheduleEntrySchema.parse(JSON.parse(raw))
      out.push(parsed)
    } catch {
      // Tolerate; the CLI's `schedule list` reports bad entries
      // separately if it cares.
    }
  }
  out.sort((a, b) => a.created_at.localeCompare(b.created_at))
  return out
}

export async function readSchedule(
  home: string,
  agentName: string,
  scheduleId: string,
): Promise<ScheduleEntry> {
  const path = schedulePath(home, agentName, scheduleId)
  const raw = await readFile(path, 'utf8')
  return ScheduleEntrySchema.parse(JSON.parse(raw))
}

export async function deleteSchedule(
  home: string,
  agentName: string,
  scheduleId: string,
): Promise<void> {
  const path = schedulePath(home, agentName, scheduleId)
  try {
    await unlink(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

/**
 * Update an existing schedule's `enabled` flag. Recomputes
 * next_fire_at when re-enabling.
 */
export async function setScheduleEnabled(
  home: string,
  agentName: string,
  scheduleId: string,
  enabled: boolean,
  now: () => Date = () => new Date(),
): Promise<ScheduleEntry> {
  const current = await readSchedule(home, agentName, scheduleId)
  const updated: ScheduleEntry = {
    ...current,
    enabled,
    next_fire_at: enabled ? nextFireTime(current.timing, now()) : null,
  }
  await persistSchedule(home, updated)
  return updated
}

/**
 * Mark a schedule fired. Updates last_fired_at to `now` and
 * recomputes next_fire_at forward from `now`. Called by the
 * Scheduler service (PR B) after enqueueing the synthetic task.
 */
export async function recordFired(
  home: string,
  agentName: string,
  scheduleId: string,
  now: () => Date = () => new Date(),
): Promise<ScheduleEntry> {
  const current = await readSchedule(home, agentName, scheduleId)
  const ts = now().toISOString()
  const updated: ScheduleEntry = {
    ...current,
    last_fired_at: ts,
    next_fire_at: nextFireTime(current.timing, new Date(ts)),
  }
  await persistSchedule(home, updated)
  return updated
}

/** Atomic file write for one schedule entry. */
async function persistSchedule(home: string, entry: ScheduleEntry): Promise<void> {
  const dir = agentSchedulesDir(home, entry.agent)
  await mkdir(dir, { recursive: true })
  await atomicWriteJson(schedulePath(home, entry.agent, entry.id), entry)
}

/** Resolve `<home>/state/agents/<agent>/schedules/<id>.json`. */
export function schedulePath(home: string, agentName: string, scheduleId: string): string {
  return join(agentSchedulesDir(home, agentName), `${scheduleId}.json`)
}
