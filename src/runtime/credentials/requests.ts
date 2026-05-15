/**
 * CredentialRequestStore: persistence + transitions + rate-cap state
 * for the `request_credential` substrate (decision:
 * 2026-05-14-request-credential-substrate).
 *
 * Records live at <home>/state/credential-requests/<id>.json. The
 * directory is flat; the addressed Agent is encoded in each record
 * rather than the path (mirroring the notification store). The
 * rolling rate-cap state lives in the same directory under
 * `.rate-<agent>.json` (leading dot keeps it sorted away from request
 * records during operator inspection).
 *
 * The value-payload of a credential never enters this module. Fulfill
 * writes value-to-vault; this store only flips state and timestamps.
 */
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import {
  credentialRequestPath,
  credentialRequestRatePath,
  homePaths,
} from '../storage/layout.js'
import { atomicWriteJson } from '../util/atomic-write.js'
import {
  CredentialRequestError,
  CredentialRequestSchema,
  DEFAULT_RATE_PER_HOUR,
  RateCapStateSchema,
  type CredentialRequest,
  type CredentialRequestState,
  type ExpiredReason,
  type RateCapState,
} from './request-types.js'

const RATE_WINDOW_MS = 60 * 60 * 1000

export interface ListFilter {
  agent?: string
  state?: CredentialRequestState
  chat_id?: string
}

export interface RateCapResult {
  /** True if the request is permitted; false if the cap has been hit. */
  ok: boolean
  /** New count after this attempt (whether it was permitted or not). */
  count: number
  /** Cap applied at decision time. */
  cap: number
  /** ISO 8601 UTC of the window currently in effect. */
  window_start: string
}

export class CredentialRequestStore {
  constructor(private readonly home: string) {}

  /** Resolve the records directory; tests call this. */
  dir(): string {
    return homePaths(this.home).stateCredentialRequests
  }

  /** Persist a fresh request. Caller passes a fully-constructed record. */
  async create(rec: CredentialRequest): Promise<void> {
    const parsed = CredentialRequestSchema.parse(rec)
    await mkdir(this.dir(), { recursive: true })
    await atomicWriteJson(credentialRequestPath(this.home, parsed.id), parsed)
  }

  /** Read + parse a record by id. */
  async get(id: string): Promise<CredentialRequest> {
    let raw: string
    try {
      raw = await readFile(credentialRequestPath(this.home, id), 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new CredentialRequestError(`credential request "${id}" not found`, 'NOT_FOUND')
      }
      throw new CredentialRequestError(
        `could not read credential request "${id}": ${err instanceof Error ? err.message : String(err)}`,
        'IO_ERROR',
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw new CredentialRequestError(
        `credential request "${id}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        'CORRUPT',
      )
    }
    const result = CredentialRequestSchema.safeParse(parsed)
    if (!result.success) {
      throw new CredentialRequestError(
        `credential request "${id}" failed schema validation: ${result.error.message}`,
        'CORRUPT',
      )
    }
    return result.data
  }

  /** List records matching the filter. Malformed files are skipped silently. */
  async list(filter: ListFilter = {}): Promise<CredentialRequest[]> {
    let entries: string[]
    try {
      entries = await readdir(this.dir())
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const out: CredentialRequest[] = []
    for (const file of entries.sort()) {
      if (!file.endsWith('.json')) continue
      if (file.startsWith('.rate-')) continue
      const id = file.slice(0, -5)
      try {
        const rec = await this.get(id)
        if (filter.agent !== undefined && rec.agent !== filter.agent) continue
        if (filter.state !== undefined && rec.state !== filter.state) continue
        if (filter.chat_id !== undefined && rec.chat_id !== filter.chat_id) continue
        out.push(rec)
      } catch {
        // skip malformed entries; operator's `ls` still sees them
      }
    }
    return out
  }

  /** Atomic-style state transition. Refuses to leave a terminal state. */
  async transition(
    id: string,
    next: Exclude<CredentialRequestState, 'pending'>,
    fields: {
      now: string
      decline_reason?: string
      expired_reason?: ExpiredReason
    },
  ): Promise<CredentialRequest> {
    const current = await this.get(id)
    if (current.state !== 'pending') {
      throw new CredentialRequestError(
        `cannot transition credential request "${id}" from ${current.state} to ${next}; terminal states are final`,
        'INVALID_TRANSITION',
      )
    }
    const updated: CredentialRequest = {
      ...current,
      state: next,
      fulfilled_at: next === 'fulfilled' ? fields.now : current.fulfilled_at,
      declined_at: next === 'declined' ? fields.now : current.declined_at,
      decline_reason: next === 'declined' ? (fields.decline_reason ?? null) : current.decline_reason,
      expired_at: next === 'expired' ? fields.now : current.expired_at,
      expired_reason: next === 'expired' ? (fields.expired_reason ?? 'timeout') : current.expired_reason,
    }
    await atomicWriteJson(credentialRequestPath(this.home, id), updated)
    return updated
  }

  /**
   * Delete a record by id. Returns true if a file was removed. Used by
   * operator cleanup / test teardown; the request lifecycle itself
   * never deletes.
   */
  async delete(id: string): Promise<boolean> {
    try {
      await unlink(credentialRequestPath(this.home, id))
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw err
    }
  }

  // -------------------------------------------------------------------------
  // Rate cap
  // -------------------------------------------------------------------------

  /**
   * Atomically check and increment the rolling 1-hour rate cap for an
   * Agent. Returns `{ ok: false }` when the cap is already at limit
   * for the current window; in that case the count is NOT
   * incremented. Otherwise increments and returns `{ ok: true }`.
   *
   * A new window opens when `now - window_start >= 1h`, resetting
   * count to 1.
   *
   * Concurrency note: the rate file uses atomic-write, but a true
   * read-modify-write race is possible if two tool calls fire in the
   * same millisecond from the same Agent. The window is large enough
   * and the rate cap loose enough that one slipped through write is
   * acceptable for v1; if rate enforcement ever needs to be exact,
   * gate it behind a fcntl flock or move the state to SQLite.
   */
  async checkAndIncrementRate(args: {
    agent: string
    cap: number
    now: Date
  }): Promise<RateCapResult> {
    const cap = Math.max(1, args.cap)
    const nowMs = args.now.getTime()
    const path = credentialRequestRatePath(this.home, args.agent)
    let state: RateCapState | null = null
    try {
      const raw = await readFile(path, 'utf-8')
      const parsed = RateCapStateSchema.safeParse(JSON.parse(raw))
      if (parsed.success) state = parsed.data
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Corrupt file: treat as fresh window. The next write fixes it.
      }
    }

    if (state === null || nowMs - Date.parse(state.window_start) >= RATE_WINDOW_MS) {
      // New window.
      const nextState: RateCapState = {
        schema_version: 1,
        agent: args.agent,
        window_start: args.now.toISOString(),
        count: 1,
      }
      await mkdir(this.dir(), { recursive: true })
      await atomicWriteJson(path, nextState)
      return { ok: true, count: 1, cap, window_start: nextState.window_start }
    }

    if (state.count >= cap) {
      return { ok: false, count: state.count, cap, window_start: state.window_start }
    }

    const nextState: RateCapState = { ...state, count: state.count + 1 }
    await atomicWriteJson(path, nextState)
    return { ok: true, count: nextState.count, cap, window_start: state.window_start }
  }

  /** Read-only inspection of an Agent's current rate-cap state. */
  async readRateState(agent: string): Promise<RateCapState | null> {
    const path = credentialRequestRatePath(this.home, agent)
    try {
      const raw = await readFile(path, 'utf-8')
      const parsed = RateCapStateSchema.safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : null
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }
}

/**
 * Resolve an Agent's rate cap. Identity-frontmatter override wins; the
 * caller-supplied global default is the fallback. The default is
 * DEFAULT_RATE_PER_HOUR when no global is provided.
 */
export function resolveRateCap(args: {
  globalDefault?: number
  identityOverride?: number | null
}): number {
  if (args.identityOverride !== undefined && args.identityOverride !== null) {
    return Math.max(1, args.identityOverride)
  }
  if (args.globalDefault !== undefined) return Math.max(1, args.globalDefault)
  return DEFAULT_RATE_PER_HOUR
}

export interface WaitForResolutionOptions {
  /** Polling cadence; defaults to 250ms (mirrors waitForResponse). */
  pollIntervalMs?: number
  /** Optional abort signal for cooperative cancellation. */
  signal?: AbortSignal
  /**
   * Hard cap on the wait. When the deadline hits and the record is
   * still 'pending', the function returns the record without
   * transitioning state. The caller is responsible for sweeping the
   * record to 'expired' if that's desired (the runtime tool handles
   * this; the sweeper handles requests it didn't initiate).
   */
  timeoutMs?: number
}

const DEFAULT_POLL_MS = 250

/**
 * Poll a request record until it leaves the 'pending' state, or
 * `timeoutMs` elapses, or `signal` aborts. Returns the latest record
 * read. Does NOT transition state on its own.
 *
 * Implementation matches the pattern in notifications/writer.ts:
 * polling is plenty for human-paced events, fs.watch buys nothing
 * worthwhile here.
 */
export async function waitForResolution(
  store: CredentialRequestStore,
  id: string,
  opts: WaitForResolutionOptions = {},
): Promise<CredentialRequest> {
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS
  const startedAt = Date.now()
  for (;;) {
    if (opts.signal?.aborted === true) {
      throw new Error(`waitForResolution(${id}) aborted`)
    }
    const rec = await store.get(id)
    if (rec.state !== 'pending') return rec
    if (opts.timeoutMs !== undefined && Date.now() - startedAt >= opts.timeoutMs) {
      return rec
    }
    await sleep(pollMs)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
