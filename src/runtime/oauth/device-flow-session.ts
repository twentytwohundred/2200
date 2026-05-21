/**
 * In-process session manager for browser-driven device-flow sign-ins.
 *
 * The CLI's `2200 oauth xai login` blocks in a single process and
 * polls inline. The browser cannot block; it pokes the daemon, gets a
 * session id, then polls a status endpoint at its own cadence. This
 * module holds the per-session state (PKCE verifier, device_code,
 * provider config, expiry) that needs to survive across those polls.
 *
 * Sessions live in memory only. A daemon restart cancels in-flight
 * sign-ins ... acceptable: the user just clicks "Sign in" again.
 * Session state contains the PKCE verifier and (briefly) the device
 * code, both of which are flow-scoped secrets; persisting them across
 * restarts would create a sealed-file lifecycle we do not need.
 *
 * Garbage collection: when a session is created we schedule a removal
 * at `expires_at + 60s`. The lazy GC inside `get()` also evicts any
 * stale session it encounters, so the timer can be missed (test
 * environments) without leaking memory.
 */
import { randomBytes } from 'node:crypto'
import type { DeviceFlowProviderConfig } from './device-flow.js'

/** Result of a single token-endpoint poll. */
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

interface SessionRecord {
  readonly id: string
  readonly provider: DeviceFlowProviderConfig
  readonly deviceCode: string
  readonly userCode: string
  readonly verificationUri: string
  readonly verificationUriComplete: string | undefined
  readonly expiresAtMs: number
  readonly codeVerifier: string
  /** Token endpoint URL pinned at session-create time. */
  readonly tokenUrl: string
  /** Bumped by RFC 8628 slow_down responses. */
  intervalSec: number
  /** Last successful access_token, so subsequent polls are idempotent. */
  completed: PollResult | undefined
}

export interface CreateSessionInput {
  readonly provider: DeviceFlowProviderConfig
  readonly deviceCode: string
  readonly userCode: string
  readonly verificationUri: string
  readonly verificationUriComplete?: string
  readonly expiresAtMs: number
  readonly codeVerifier: string
  readonly intervalSec: number
}

/** Public view of a session; safe to return to the browser. */
export interface SessionPublic {
  readonly session_id: string
  readonly user_code: string
  readonly verification_uri: string
  readonly verification_uri_complete: string | undefined
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
      provider: input.provider,
      deviceCode: input.deviceCode,
      userCode: input.userCode,
      verificationUri: input.verificationUri,
      verificationUriComplete: input.verificationUriComplete,
      expiresAtMs: input.expiresAtMs,
      codeVerifier: input.codeVerifier,
      tokenUrl: input.provider.tokenUrl,
      intervalSec: input.intervalSec,
      completed: undefined,
    }
    this.sessions.set(id, rec)
    return {
      session_id: id,
      user_code: rec.userCode,
      verification_uri: rec.verificationUri,
      verification_uri_complete: rec.verificationUriComplete,
      expires_at: new Date(rec.expiresAtMs).toISOString(),
      poll_interval_sec: rec.intervalSec,
    }
  }

  get(id: string): SessionRecord | undefined {
    const rec = this.sessions.get(id)
    if (!rec) return undefined
    // Lazy GC: a session that's >1min past its expiry is gone.
    if (rec.completed === undefined && this.nowFn() > rec.expiresAtMs + 60_000) {
      this.sessions.delete(id)
      return undefined
    }
    return rec
  }

  /**
   * Update the polling interval (RFC 8628 slow_down). Persisted on the
   * session record so subsequent polls honor the bump.
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
    return this.sessions.delete(id)
  }

  /** Visible only for tests. */
  size(): number {
    return this.sessions.size
  }
}
