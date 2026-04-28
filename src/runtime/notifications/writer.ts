/**
 * Notification writer + Ask wait helpers (Epic 7 PR D).
 *
 * Companion to reader.ts. Emitters that already exist (Epic 2
 * detector trips, Epic 4.5 BudgetTracker, Epic 4 Phase A
 * provisioning pipeline) write notifications inline; this module
 * canonicalizes the write path so future emitters don't reinvent
 * the YAML+frontmatter format and so the Ask wait flow has a
 * shared implementation.
 *
 * The Ask flow:
 *
 *   1. Tool calls `emitNotification({ requires_response: true, ... })`.
 *   2. The notification file appears at state/notifications/<id>.md
 *      with state: pending.
 *   3. Tool calls `waitForResponse(home, id)` — async; resolves when
 *      the file's frontmatter state flips to 'answered' (returns
 *      the response text) or 'dismissed' (throws).
 *   4. The user-facing CLI flow (`2200 notification respond <id>`)
 *      writes the new state via reader's `markAnswered`.
 *
 * The wait uses fs.watch on the file's directory plus a polling
 * fallback (some filesystems don't fire events reliably). The
 * fallback poll interval is 250ms by default.
 */
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import { atomicWriteFile } from '../util/atomic-write.js'
import { homePaths } from '../storage/layout.js'
import { newNotificationId } from '../util/id.js'
import {
  notificationPath,
  readNotification,
  type NotificationTier,
  type NotificationState,
} from './reader.js'

const FRONTMATTER_DELIM = '---'
const DEFAULT_POLL_INTERVAL_MS = 250

export interface EmitNotificationArgs {
  home: string
  agentName: string
  tier: NotificationTier
  kind: string
  body?: string
  requiresResponse?: boolean
  /** Emitter-specific frontmatter fields (cap_usd, token_id, trip_id, etc.). */
  extras?: Record<string, unknown>
  /** Override the id (testing). */
  id?: string
  /** Override the timestamp (testing). */
  ts?: string
}

export interface EmitNotificationResult {
  id: string
  path: string
}

/**
 * Write a notification file with the canonical frontmatter shape.
 * Atomic. Returns the id and path. The state starts at 'pending';
 * `requires_response: true` makes this an Ask that the loop can
 * wait on via waitForResponse.
 */
export async function emitNotification(
  args: EmitNotificationArgs,
): Promise<EmitNotificationResult> {
  const id = args.id ?? newNotificationId()
  const ts = args.ts ?? new Date().toISOString()
  const fm: Record<string, unknown> = {
    schema_version: 1,
    id,
    ts,
    tier: args.tier,
    agent: args.agentName,
    kind: args.kind,
    state: 'pending' satisfies NotificationState,
  }
  if (args.requiresResponse === true) fm['requires_response'] = true
  if (args.extras) {
    for (const [k, v] of Object.entries(args.extras)) {
      // Don't let extras override the canonical fields.
      if (k in fm) continue
      fm[k] = v
    }
  }
  const yaml = stringifyYaml(fm, { lineWidth: 0 }).trimEnd()
  const body = args.body ?? ''
  const content = `${FRONTMATTER_DELIM}\n${yaml}\n${FRONTMATTER_DELIM}\n${body}`
  const path = notificationPath(args.home, id)
  await mkdir(dirname(path), { recursive: true })
  await atomicWriteFile(path, content)
  // ensure the parent dir is on the watcher's radar before any
  // waitForResponse call (cheap idempotent mkdir).
  await mkdir(homePaths(args.home).stateNotifications, { recursive: true })
  return { id, path }
}

export class NotificationDismissedError extends Error {
  constructor(public readonly id: string) {
    super(`notification ${id} was dismissed without a response`)
    this.name = 'NotificationDismissedError'
  }
}

export interface WaitForResponseOptions {
  /** Polling fallback in case fs events miss. Default 250ms. */
  pollIntervalMs?: number
  /** Hard cap on wait time. Defaults to no timeout (wait forever). */
  timeoutMs?: number
  /** AbortSignal for cooperative cancellation. */
  signal?: AbortSignal
}

/**
 * Wait for a pending notification to be answered or dismissed.
 *
 * Resolves with the response text on `markAnswered`. Throws
 * NotificationDismissedError on `markDismissed`. Throws on timeout
 * (when set) or abort (when signal triggers).
 *
 * Implementation: a simple polling loop on the notification file
 * (every pollIntervalMs). fs.watch was considered for sub-second
 * latency but adds a portability tax (Linux/macOS recursive watch
 * differences) for negligible gain on the Ask path... users
 * typically take seconds-to-minutes to respond to an Ask, so a
 * 250ms poll is plenty.
 */
export async function waitForResponse(
  home: string,
  id: string,
  opts: WaitForResponseOptions = {},
): Promise<string> {
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const startedAt = Date.now()
  for (;;) {
    if (opts.signal?.aborted === true) {
      throw new Error(`waitForResponse(${id}) aborted`)
    }
    if (opts.timeoutMs !== undefined && Date.now() - startedAt > opts.timeoutMs) {
      throw new Error(`waitForResponse(${id}) timed out after ${String(opts.timeoutMs)}ms`)
    }
    let rec
    try {
      rec = await readNotification(home, id)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // File deleted underneath us. Treat as dismissed.
        throw new NotificationDismissedError(id)
      }
      throw err
    }
    if (rec.frontmatter.state === 'answered') {
      return rec.frontmatter.response ?? ''
    }
    if (rec.frontmatter.state === 'dismissed') {
      throw new NotificationDismissedError(id)
    }
    await sleep(pollMs)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Resolve `<home>/state/notifications`. Re-export for test convenience.
 */
export function notificationsDir(home: string): string {
  return homePaths(home).stateNotifications
}
