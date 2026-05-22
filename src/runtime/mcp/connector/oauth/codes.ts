/**
 * Authorization-code store (in-memory, 60s TTL, one-time-use).
 *
 * Authorization codes are ephemeral and never persisted to disk.
 * Issued at `/authorize`, exchanged at `/token` within 60 seconds,
 * burned on first use. Lost on supervisor restart — that's by
 * design: a code outliving its issuer's lifetime is a replay window
 * we don't want.
 *
 * Per RFC 6749 §4.1.2 + §10.5: codes MUST be short-lived (≤10 min;
 * recommended ≤1 min), one-time-use, bound to the client_id and
 * redirect_uri. We add the PKCE `code_challenge` here too so the
 * `/token` exchange can verify the verifier without a separate
 * lookup.
 */
import { randomBytes } from 'node:crypto'

const CODE_RANDOM_BYTES = 32 // → 43 base64url chars
const DEFAULT_TTL_MS = 60_000 // 60 seconds

export interface AuthorizationCodeRecord {
  code: string
  client_id: string
  redirect_uri: string
  scopes: string[]
  code_challenge: string
  /** S256 only; we never accept `plain`. Stored so we don't silently flip methods. */
  code_challenge_method: 'S256'
  issued_at_ms: number
  expires_at_ms: number
}

export interface IssueCodeArgs {
  clientId: string
  redirectUri: string
  scopes: string[]
  codeChallenge: string
  /** Override (tests). */
  ttlMs?: number
  /** Override clock (tests). */
  now?: () => number
}

/** Mint a fresh authorization code. */
function mintCode(): string {
  return randomBytes(CODE_RANDOM_BYTES).toString('base64url')
}

/**
 * Per-process store. Single-instance per supervisor; not safe across
 * restarts (intentionally — codes shouldn't outlive their issuer).
 */
export class AuthorizationCodeStore {
  private readonly codes = new Map<string, AuthorizationCodeRecord>()
  private readonly now: () => number
  private gcTimer: ReturnType<typeof setInterval> | undefined

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now
  }

  /** Issue a fresh code for an authorize request. Returns the code value. */
  issue(args: IssueCodeArgs): string {
    const code = mintCode()
    const ttl = args.ttlMs ?? DEFAULT_TTL_MS
    const issuedAt = (args.now ?? this.now)()
    this.codes.set(code, {
      code,
      client_id: args.clientId,
      redirect_uri: args.redirectUri,
      scopes: args.scopes,
      code_challenge: args.codeChallenge,
      code_challenge_method: 'S256',
      issued_at_ms: issuedAt,
      expires_at_ms: issuedAt + ttl,
    })
    return code
  }

  /**
   * Consume a code: returns the record if present and not expired,
   * removing it from the store either way (one-time-use). Returns
   * null if missing or expired.
   */
  consume(code: string): AuthorizationCodeRecord | null {
    const record = this.codes.get(code)
    if (record === undefined) return null
    this.codes.delete(code)
    if (this.now() >= record.expires_at_ms) return null
    return record
  }

  /** Start a periodic sweep that drops expired codes. Optional; consume() also handles expiry. */
  startGc(intervalMs = 30_000): void {
    if (this.gcTimer !== undefined) return
    this.gcTimer = setInterval(() => {
      const now = this.now()
      for (const [code, record] of this.codes.entries()) {
        if (now >= record.expires_at_ms) this.codes.delete(code)
      }
    }, intervalMs)
    this.gcTimer.unref()
  }

  stopGc(): void {
    if (this.gcTimer !== undefined) {
      clearInterval(this.gcTimer)
      this.gcTimer = undefined
    }
  }

  /** Test helper: number of codes currently stored (expired or not). */
  size(): number {
    return this.codes.size
  }
}
