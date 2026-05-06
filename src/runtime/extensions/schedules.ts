/**
 * Per-Extension schedule persistence (Epic 12 Phase B-2).
 *
 * Each Extension that declares `schedules[]` in its manifest gets one
 * file per schedule on disk:
 *
 *   <home>/state/extensions/<name>/schedules/<schedule_id>.json
 *
 * The on-disk shape carries everything the Scheduler service needs to
 * arm a timer (cron expression, last + next fire ISO, enabled flag)
 * plus the Extension name + manifest version that produced it. The
 * Scheduler scans this directory at startup alongside the per-Agent
 * schedules and arms timers for both.
 *
 * Reconcile-on-update semantics:
 *   - Schedules listed in the new manifest but not on disk: persist
 *     fresh entries with `next_fire_at` computed from now.
 *   - Schedules on disk but not in the new manifest: deleted.
 *   - Schedules in both: keep `last_fired_at` and `enabled`, refresh
 *     `cron` / `description` / `extension_version` from the manifest,
 *     recompute `next_fire_at` if the cron changed.
 *
 * Schedule firing semantics live in `Scheduler` (see service.ts) and
 * `runHook` with `hook: 'tick'` (see hooks.ts) ... per the decision
 * record at `wiki/decisions/2026-05-06-extension-schedules-fire-tick-hook.md`.
 */
import { readFile, readdir, mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { CronExpressionParser } from 'cron-parser'
import { atomicWriteJson } from '../util/atomic-write.js'
import { extensionSchedulesDir } from '../storage/layout.js'
import { ScheduleError } from '../scheduler/schedule.js'
import type { ExtensionSchedule } from './types.js'

export const EXTENSION_SCHEDULE_SCHEMA_VERSION = 1 as const

export const ExtensionScheduleEntrySchema = z.object({
  schema_version: z.literal(EXTENSION_SCHEDULE_SCHEMA_VERSION),
  /** Extension this schedule belongs to. Mirrors the parent dir name. */
  extension_name: z.string().min(1),
  /** Manifest version of the Extension at the time the entry was written. */
  extension_version: z.string().min(1),
  /** Schedule id from the manifest. Unique within the Extension. */
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, {
      message: 'schedule id must be lowercase alphanumeric/dashes, starting with a letter or digit',
    }),
  /** 5-field cron expression (UTC). */
  cron: z.string().min(1),
  /** Optional human description from the manifest. */
  description: z.string().default(''),
  enabled: z.boolean().default(true),
  created_at: z.string().min(1),
  /** ISO timestamp of the most recent successful fire. Null until first fire. */
  last_fired_at: z.string().nullable().default(null),
  /** ISO timestamp of the next computed fire time. Recomputed on load. */
  next_fire_at: z.string().nullable().default(null),
})
export type ExtensionScheduleEntry = z.infer<typeof ExtensionScheduleEntrySchema>

/**
 * Parse a cron expression to validate it. Throws ScheduleError on
 * malformed input. Re-uses the per-Agent cron error class so callers
 * that catch ScheduleError handle both schedule kinds the same way.
 */
export function validateCron(expr: string): void {
  try {
    CronExpressionParser.parse(expr, { tz: 'UTC' })
  } catch (err) {
    throw new ScheduleError(
      `invalid cron expression "${expr}": ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/** Compute the next fire time for an extension schedule's cron. */
export function nextExtensionFireTime(cron: string, now: Date = new Date()): string | null {
  try {
    const it = CronExpressionParser.parse(cron, { tz: 'UTC', currentDate: now })
    return it.next().toDate().toISOString()
  } catch {
    return null
  }
}

function scheduleFilePath(home: string, name: string, scheduleId: string): string {
  return join(extensionSchedulesDir(home, name), `${scheduleId}.json`)
}

/**
 * Read one extension schedule by id. Throws on missing file or schema
 * failure. Caller decides whether to swallow ENOENT (uncommon path).
 */
export async function readExtensionSchedule(
  home: string,
  extensionName: string,
  scheduleId: string,
): Promise<ExtensionScheduleEntry> {
  const path = scheduleFilePath(home, extensionName, scheduleId)
  const raw = await readFile(path, 'utf8')
  return ExtensionScheduleEntrySchema.parse(JSON.parse(raw))
}

/**
 * List all schedules for one Extension. Tolerates missing dir +
 * malformed individual entries (skipped silently; the Scheduler logs
 * its own warning at scan time if it cares).
 */
export async function listExtensionSchedules(
  home: string,
  extensionName: string,
): Promise<ExtensionScheduleEntry[]> {
  const dir = extensionSchedulesDir(home, extensionName)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: ExtensionScheduleEntry[] = []
  for (const e of entries) {
    if (!e.endsWith('.json')) continue
    const path = join(dir, e)
    try {
      const raw = await readFile(path, 'utf8')
      out.push(ExtensionScheduleEntrySchema.parse(JSON.parse(raw)))
    } catch {
      // Tolerate malformed entry; scheduler logs its own warning at
      // scan time when it needs to attribute the skip.
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}

/**
 * Scan every Extension under <home>/extensions and aggregate their
 * schedule entries. Used by the Scheduler service to arm timers across
 * the full set of Extensions in one pass.
 */
export async function listAllExtensionSchedules(home: string): Promise<ExtensionScheduleEntry[]> {
  const root = join(home, 'extensions')
  let names: string[]
  try {
    names = await readdir(root)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: ExtensionScheduleEntry[] = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    const list = await listExtensionSchedules(home, name)
    out.push(...list)
  }
  return out
}

export interface PersistArgs {
  home: string
  extensionName: string
  extensionVersion: string
  schedule: ExtensionSchedule
  /** Override (testing). Defaults to () => new Date(). */
  now?: () => Date
  /** Preserve last_fired_at + enabled when reconciling an update. */
  preserve?: { last_fired_at: string | null; enabled: boolean } | null
}

/**
 * Write one schedule entry. Validates the cron before persisting so a
 * malformed schedule never reaches disk. Optionally preserves the
 * fire history + enabled flag from a prior version of the same id
 * during update reconciliation.
 */
export async function writeExtensionSchedule(args: PersistArgs): Promise<ExtensionScheduleEntry> {
  validateCron(args.schedule.cron)
  const now = args.now ?? (() => new Date())
  await mkdir(extensionSchedulesDir(args.home, args.extensionName), { recursive: true })
  const enabled = args.preserve?.enabled ?? true
  const entry: ExtensionScheduleEntry = {
    schema_version: EXTENSION_SCHEDULE_SCHEMA_VERSION,
    extension_name: args.extensionName,
    extension_version: args.extensionVersion,
    id: args.schedule.id,
    cron: args.schedule.cron,
    description: args.schedule.description ?? '',
    enabled,
    created_at: now().toISOString(),
    last_fired_at: args.preserve?.last_fired_at ?? null,
    next_fire_at: enabled ? nextExtensionFireTime(args.schedule.cron, now()) : null,
  }
  await atomicWriteJson(scheduleFilePath(args.home, args.extensionName, args.schedule.id), entry)
  return entry
}

export async function deleteExtensionSchedule(
  home: string,
  extensionName: string,
  scheduleId: string,
): Promise<void> {
  try {
    await unlink(scheduleFilePath(home, extensionName, scheduleId))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

/**
 * Mark a schedule fired. Updates last_fired_at to now() and
 * recomputes next_fire_at forward. Called by the Scheduler service
 * after running the tick hook.
 */
export async function recordExtensionScheduleFired(
  home: string,
  extensionName: string,
  scheduleId: string,
  now: () => Date = () => new Date(),
): Promise<ExtensionScheduleEntry> {
  const current = await readExtensionSchedule(home, extensionName, scheduleId)
  const ts = now().toISOString()
  const updated: ExtensionScheduleEntry = {
    ...current,
    last_fired_at: ts,
    next_fire_at: nextExtensionFireTime(current.cron, new Date(ts)),
  }
  await atomicWriteJson(scheduleFilePath(home, extensionName, scheduleId), updated)
  return updated
}

/**
 * Reconcile manifest schedules vs. existing on-disk entries during
 * an update or fresh install:
 *
 *   - new in manifest, not on disk → write new
 *   - on disk, not in manifest → delete
 *   - in both → keep last_fired_at + enabled, refresh cron /
 *     description / extension_version, recompute next_fire_at
 *
 * Returns the resulting set of entries (post-reconcile).
 */
export async function reconcileExtensionSchedules(args: {
  home: string
  extensionName: string
  extensionVersion: string
  manifestSchedules: readonly ExtensionSchedule[]
  now?: () => Date
}): Promise<ExtensionScheduleEntry[]> {
  const existing = await listExtensionSchedules(args.home, args.extensionName)
  const existingById = new Map(existing.map((e) => [e.id, e]))
  const manifestIds = new Set(args.manifestSchedules.map((s) => s.id))

  // Delete schedules removed from the manifest.
  for (const e of existing) {
    if (!manifestIds.has(e.id)) {
      await deleteExtensionSchedule(args.home, args.extensionName, e.id)
    }
  }

  // Write / refresh the rest.
  const out: ExtensionScheduleEntry[] = []
  for (const s of args.manifestSchedules) {
    const prior = existingById.get(s.id)
    const persistArgs: PersistArgs = {
      home: args.home,
      extensionName: args.extensionName,
      extensionVersion: args.extensionVersion,
      schedule: s,
      ...(args.now !== undefined ? { now: args.now } : {}),
      preserve: prior ? { last_fired_at: prior.last_fired_at, enabled: prior.enabled } : null,
    }
    const written = await writeExtensionSchedule(persistArgs)
    out.push(written)
  }
  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}

/** Composite job key the Scheduler uses to track Extension timers. */
export function extensionScheduleJobKey(extensionName: string, scheduleId: string): string {
  return `extension:${extensionName}:${scheduleId}`
}
