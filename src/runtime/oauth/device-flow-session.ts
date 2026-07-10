/**
 * In-process session manager for browser-driven subscription sign-ins.
 *
 * The CLI's `2200 oauth <provider> login` blocks in a single process
 * and polls inline. The browser cannot block; it pokes the daemon,
 * gets a session id, then polls a status endpoint at its own cadence.
 * This module holds the per-session state that needs to survive
 * across those polls.
 *
 * Two session shapes:
 *   - 'device':    a device-code flow. `pollState` is the opaque
 *                  per-provider poll payload (PKCE verifier, device
 *                  code / device_auth_id, pinned token URL ...) that
 *                  the subscription registry's pollDeviceFlowOnce
 *                  consumes. The HTTP status route drives one poll per
 *                  browser request.
 *   - 'loopback':  an authorization-code flow running against the
 *                  daemon-hosted redirect listener. Nothing to poll
 *                  upstream; the background exchange promise records
 *                  a completion and the status route just reads it.
 *
 * Sessions live in memory only. A daemon restart cancels in-flight
 * sign-ins ... acceptable: the user just clicks "Sign in" again.
 * Session state contains flow-scoped secrets (PKCE verifier, device
 * code); persisting them across restarts would create a sealed-file
 * lifecycle we do not need.
 *
 * Garbage collection: the lazy GC inside `get()` evicts any session
 * >1 min past its expiry, so sessions cannot leak memory even when no
 * timer fires (test environments).
 */
import { randomBytes } from 'node:crypto'

/** Result of a single status poll, as returned to the browser. */
export type PollResult =
  | { status: 'pending' }
  | {
      status: 'completed'
      access_token: string
      refresh_token: string
      expires_at_ms: number
      granted_scopes: readonly string[]
    }
  | { status: 'failed'; error: string; description?: string }

export interface SessionRecord {
  readonly id: string
  /** Subscription registry slug, e.g. 'xai-oauth'. */
  readonly slug: string
  readonly flow: 'device' | 'loopback'
  /** Device flow only. */
  readonly userCode: string | undefined
  readonly verificationUri: string | undefined
  readonly verificationUriComplete: string | undefined
  /** Loopback flow only: URL the browser opens to run consent. */
  readonly authorizationUrl: string | undefined
  readonly expiresAtMs: number
  /** Opaque per-provider poll payload (device flow only). */
  readonly pollState: Readonly<Record<string, string>>
  /** Bumped by slow_down responses. */
  intervalSec: number
  /** Terminal poll result, so subsequent polls are idempotent. */
  completed: PollResult | undefined
  /** Loopback only: abort hook that closes the redirect listener. */
  readonly cancel: (() => void) | undefined
}

export interface CreateSessionInput {
  readonly slug: string
  readonly flow: 'device' | 'loopback'
  readonly userCode?: string
  readonly verificationUri?: string
  readonly verificationUriComplete?: string
  readonly authorizationUrl?: string
  readonly expiresAtMs: number
  readonly intervalSec: number
  readonly pollState?: Readonly<Record<string, string>>
  readonly cancel?: () => void
}

/** Public view of a session; safe to return to the browser. */
export interface SessionPublic {
  readonly session_id: string
  readonly flow: 'device' | 'loopback'
  readonly user_code: string | undefined
  readonly verification_uri: string | undefined
  readonly verification_uri_complete: string | undefined
  readonly authorization_url: string | undefined
  readonly expires_at: string
  readonly poll_interval_sec: number
}

export class DeviceFlowSessionManager {
  private readonly sessions = new Map<string, SessionRecord>()

  /** Inject the clock for tests; default Date.now. */
  constructor(private readonly nowFn: () => number = () => Date.now()) {}

  create(input: CreateSessionInput): SessionPublic {
    const id = randomBytes(16).toString('hex')
    const rec: SessionRecord = {
      id,
      slug: input.slug,
      flow: input.flow,
      userCode: input.userCode,
      verificationUri: input.verificationUri,
      verificationUriComplete: input.verificationUriComplete,
      authorizationUrl: input.authorizationUrl,
      expiresAtMs: input.expiresAtMs,
      pollState: input.pollState ?? {},
      intervalSec: input.intervalSec,
      completed: undefined,
      cancel: input.cancel,
    }
    this.sessions.set(id, rec)
    return this.toPublic(rec)
  }

  get(id: string): SessionRecord | undefined {
    const rec = this.sessions.get(id)
    if (!rec) return undefined
    // Lazy GC: a session that's >1min past its expiry is gone.
    if (rec.completed === undefined && this.nowFn() > rec.expiresAtMs + 60_000) {
      rec.cancel?.()
      this.sessions.delete(id)
      return undefined
    }
    return rec
  }

  /**
   * Update the polling interval (slow_down). Persisted on the session
   * record so subsequent polls honor the bump.
   */
  bumpInterval(id: string, deltaSec: number): void {
    const rec = this.sessions.get(id)
    if (!rec) return
    rec.intervalSec = Math.min(rec.intervalSec + deltaSec, 60)
  }

  /** Cache the terminal poll result so re-polls are idempotent. */
  recordCompletion(id: string, result: PollResult): void {
    const rec = this.sessions.get(id)
    if (!rec) return
    rec.completed = result
  }

  /** Drop a session (logout, error, or test cleanup). */
  remove(id: string): boolean {
    const rec = this.sessions.get(id)
    rec?.cancel?.()
    return this.sessions.delete(id)
  }

  /** Visible only for tests. */
  size(): number {
    return this.sessions.size
  }

  private toPublic(rec: SessionRecord): SessionPublic {
    return {
      session_id: rec.id,
      flow: rec.flow,
      user_code: rec.userCode,
      verification_uri: rec.verificationUri,
      verification_uri_complete: rec.verificationUriComplete,
      authorization_url: rec.authorizationUrl,
      expires_at: new Date(rec.expiresAtMs).toISOString(),
      poll_interval_sec: rec.intervalSec,
    }
  }
}
