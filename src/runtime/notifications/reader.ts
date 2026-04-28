/**
 * Notification reader and state-machine helpers (Epic 7 PR B).
 *
 * Notifications are markdown files at `<home>/state/notifications/<id>.md`
 * with YAML frontmatter. They are written by various emitters
 * (Epic 2 detector trips, Epic 4.5 BudgetTracker thresholds, Epic 4
 * Phase A provisioning success/failure) and read by the user via
 * `2200 notification` (the CLI surface lands in PR C).
 *
 * Frontmatter shape (canonical, every emitter conforms):
 *
 *   schema_version: 1
 *   id: <notif_id>
 *   ts: <iso>
 *   tier: passive | normal | important | critical
 *   agent: <agent_name>
 *   kind: <emitter-specific kind, free-form>
 *   state: pending | answered | dismissed
 *   requires_response?: bool      (Epic 7: tier-1/2 ask flow)
 *   [emitter-specific fields]
 *
 * Body: markdown (free-form). Typically explains the notification
 * with action hints ("Override with: 2200 agent budget override...").
 *
 * State machine:
 *
 *   pending → answered    (via markAnswered + a response file)
 *   pending → dismissed   (via markDismissed)
 *
 * The on-disk frontmatter is the single source of truth; concurrent
 * processes coordinate via atomic writes.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { z } from 'zod'
import { atomicWriteFile } from '../util/atomic-write.js'
import { homePaths } from '../storage/layout.js'

const FRONTMATTER_DELIM = '---'
const FRONTMATTER_RE = /^---\n([\s\S]+?)\n---\n([\s\S]*)$/

export const NotificationTierSchema = z.enum(['passive', 'normal', 'important', 'critical'])
export type NotificationTier = z.infer<typeof NotificationTierSchema>

export const NotificationStateSchema = z.enum(['pending', 'answered', 'dismissed'])
export type NotificationState = z.infer<typeof NotificationStateSchema>

/**
 * Frontmatter common across all emitters. Emitters add their own
 * kind-specific fields under arbitrary keys; we tolerate them via a
 * passthrough on the raw record.
 */
export const NotificationFrontmatterSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().min(1),
  ts: z.string().min(1),
  tier: NotificationTierSchema,
  agent: z.string().min(1),
  kind: z.string().min(1),
  state: NotificationStateSchema,
  /** Tier-1/2 ask: when true, the emitting Agent's loop pauses on a response file. */
  requires_response: z.boolean().optional(),
  /** Set when state becomes 'answered'. The response text the user provided. */
  response: z.string().optional(),
  /** Set when state becomes 'answered' or 'dismissed'. ISO. */
  resolved_at: z.string().optional(),
})
export type NotificationFrontmatter = z.infer<typeof NotificationFrontmatterSchema>

export interface NotificationRecord {
  /** Absolute path to the .md file. */
  path: string
  frontmatter: NotificationFrontmatter
  /** Pass-through frontmatter fields beyond the canonical schema (emitter-specific). */
  extras: Record<string, unknown>
  body: string
}

/**
 * Filters for `listNotifications`. Composed: every set filter ANDs.
 */
export interface ListFilters {
  state?: NotificationState | NotificationState[]
  tier?: NotificationTier | NotificationTier[]
  agent?: string
  /** Only return entries with `requires_response: true`. */
  asksOnly?: boolean
}

/**
 * Read one notification by id. Throws if missing or malformed.
 * Used by `notification show` and `respond / dismiss` flows.
 */
export async function readNotification(home: string, id: string): Promise<NotificationRecord> {
  const path = notificationPath(home, id)
  return readNotificationAt(path)
}

/** Read by absolute path. Useful for tests. */
export async function readNotificationAt(path: string): Promise<NotificationRecord> {
  const text = await readFile(path, 'utf8')
  const m = FRONTMATTER_RE.exec(text)
  if (m?.[1] === undefined) {
    throw new Error(`notification at ${path} has no YAML frontmatter`)
  }
  const yamlText = m[1]
  const body = m[2] ?? ''
  const parsed = parseYaml(yamlText) as Record<string, unknown>
  const fm = NotificationFrontmatterSchema.parse(parsed)
  const extras: Record<string, unknown> = {}
  for (const k of Object.keys(parsed)) {
    if (!(k in fm)) extras[k] = parsed[k]
  }
  return { path, frontmatter: fm, extras, body }
}

/**
 * List notifications under `<home>/state/notifications/` ordered by
 * timestamp ascending. Filters compose via AND.
 */
export async function listNotifications(
  home: string,
  filters: ListFilters = {},
): Promise<NotificationRecord[]> {
  const dir = homePaths(home).stateNotifications
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }

  const states = toSet(filters.state)
  const tiers = toSet(filters.tier)

  const out: NotificationRecord[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const path = join(dir, entry)
    let rec: NotificationRecord
    try {
      rec = await readNotificationAt(path)
    } catch {
      // Tolerate a malformed notification file rather than abort the
      // whole list. The CLI surfaces a count of unreadable entries
      // separately if needed.
      continue
    }
    if (states && !states.has(rec.frontmatter.state)) continue
    if (tiers && !tiers.has(rec.frontmatter.tier)) continue
    if (filters.agent !== undefined && rec.frontmatter.agent !== filters.agent) continue
    if (filters.asksOnly === true && rec.frontmatter.requires_response !== true) continue
    out.push(rec)
  }

  out.sort((a, b) => a.frontmatter.ts.localeCompare(b.frontmatter.ts))
  return out
}

/**
 * Mark a notification as `answered` and persist the user's response.
 * The response is a string (free-form). Atomic write; the file is
 * left intact on schema validation failure of the merged frontmatter.
 */
export async function markAnswered(
  home: string,
  id: string,
  response: string,
  now: () => Date = () => new Date(),
): Promise<NotificationRecord> {
  return mutateNotification(home, id, (rec) => {
    if (rec.frontmatter.state !== 'pending') {
      throw new Error(
        `notification ${id} is in state "${rec.frontmatter.state}", not "pending"; cannot answer`,
      )
    }
    return {
      ...rec.frontmatter,
      state: 'answered' as const,
      response,
      resolved_at: now().toISOString(),
    }
  })
}

/**
 * Mark a notification as `dismissed`. The Agent is NOT unblocked
 * by dismissal of an Ask; that is the user's deliberate choice to
 * close without answering. The Agent's pause-on-ask loop must
 * detect this state and decide its own behavior (typically: error
 * out the task with "user dismissed without answering").
 */
export async function markDismissed(
  home: string,
  id: string,
  now: () => Date = () => new Date(),
): Promise<NotificationRecord> {
  return mutateNotification(home, id, (rec) => {
    if (rec.frontmatter.state !== 'pending') {
      throw new Error(
        `notification ${id} is in state "${rec.frontmatter.state}", not "pending"; cannot dismiss`,
      )
    }
    return {
      ...rec.frontmatter,
      state: 'dismissed' as const,
      resolved_at: now().toISOString(),
    }
  })
}

/**
 * Generic mutation helper: read, transform frontmatter, write atomically.
 * Preserves emitter-specific `extras` and the markdown body.
 */
async function mutateNotification(
  home: string,
  id: string,
  transform: (rec: NotificationRecord) => NotificationFrontmatter,
): Promise<NotificationRecord> {
  const path = notificationPath(home, id)
  const rec = await readNotificationAt(path)
  const nextFm = transform(rec)
  const merged = { ...nextFm, ...rec.extras }
  // schema_version, id, ts come from frontmatter; extras might
  // override them only if a malformed write happened. We re-validate.
  NotificationFrontmatterSchema.parse(merged)
  await mkdir(dirname(path), { recursive: true })
  const yaml = stringifyYaml(merged, { lineWidth: 0 }).trimEnd()
  const content = `${FRONTMATTER_DELIM}\n${yaml}\n${FRONTMATTER_DELIM}\n${rec.body}`
  await atomicWriteFile(path, content)
  return { ...rec, frontmatter: nextFm, extras: rec.extras }
}

/** Resolve `<home>/state/notifications/<id>.md`. */
export function notificationPath(home: string, id: string): string {
  return join(homePaths(home).stateNotifications, `${id}.md`)
}

/** Returns null when the file does not exist; useful for status checks. */
export async function notificationExists(home: string, id: string): Promise<boolean> {
  try {
    await stat(notificationPath(home, id))
    return true
  } catch {
    return false
  }
}

function toSet<T extends string>(v: T | T[] | undefined): Set<T> | undefined {
  if (v === undefined) return undefined
  if (Array.isArray(v)) return new Set(v)
  return new Set([v])
}
