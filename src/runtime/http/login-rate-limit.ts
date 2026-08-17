/**
 * Login rate-limit / lockout for the web API.
 *
 * Defense-in-depth at the box, independent of Cloudflare. A 256-bit bearer
 * already makes online brute-force infeasible, but a per-client lockout stops
 * credential-stuffing noise, caps log spam, and gives a straight answer to
 * "what stops repeated guessing?" ... after N failed attempts in a window, the
 * client is locked out for a cooldown (HTTP 429 + Retry-After).
 *
 * Keyed per client, not globally, so one attacker can't lock everyone out.
 * Behind the tunnel every request arrives from `cloudflared` on loopback, so
 * the real client is read from Cloudflare's `CF-Connecting-IP` header (which
 * Cloudflare sets and a client cannot forge through the tunnel); on a direct
 * LAN/loopback connection there's no such header and we fall back to the socket
 * address. In-memory + per-daemon ... a restart clears it, which is fine for a
 * throttle (and a restart isn't attacker-triggerable pre-auth).
 */
export interface RateLimitDecision {
  allowed: boolean
  /** Seconds until the lockout lifts (only when `allowed` is false). */
  retryAfterSeconds: number
}

export interface LoginRateLimiterOptions {
  /** Failed attempts within `windowMs` that trip a lockout. */
  maxFailures: number
  /** Sliding window for counting failures. */
  windowMs: number
  /** How long a tripped lockout lasts. */
  lockoutMs: number
  /** Injectable clock (ms). Defaults to Date.now. */
  now?: () => number
}

interface Entry {
  failures: number
  windowStart: number
  lockedUntil: number
}

export class LoginRateLimiter {
  private readonly entries = new Map<string, Entry>()
  private readonly maxFailures: number
  private readonly windowMs: number
  private readonly lockoutMs: number
  private readonly now: () => number

  constructor(opts: LoginRateLimiterOptions) {
    this.maxFailures = opts.maxFailures
    this.windowMs = opts.windowMs
    this.lockoutMs = opts.lockoutMs
    this.now = opts.now ?? Date.now
  }

  /** Is this client currently allowed to attempt auth? */
  check(key: string): RateLimitDecision {
    const e = this.entries.get(key)
    if (!e) return { allowed: true, retryAfterSeconds: 0 }
    const t = this.now()
    if (e.lockedUntil > t) {
      return { allowed: false, retryAfterSeconds: Math.ceil((e.lockedUntil - t) / 1000) }
    }
    return { allowed: true, retryAfterSeconds: 0 }
  }

  /** Record a failed auth attempt; may trip a lockout. */
  recordFailure(key: string): void {
    const t = this.now()
    const e = this.entries.get(key)
    if (!e || t - e.windowStart > this.windowMs) {
      // Fresh window.
      this.entries.set(key, { failures: 1, windowStart: t, lockedUntil: 0 })
      return
    }
    e.failures += 1
    if (e.failures >= this.maxFailures) {
      e.lockedUntil = t + this.lockoutMs
      // Reset the counter so the NEXT window after the lockout starts clean.
      e.failures = 0
      e.windowStart = t + this.lockoutMs
    }
  }

  /** A successful auth clears the client's failure state. */
  recordSuccess(key: string): void {
    this.entries.delete(key)
  }

  /**
   * Drop entries that are neither locked out nor inside an active failure
   * window, so the map can't grow unbounded under a spray of unique keys.
   * Cheap; call opportunistically.
   */
  sweep(): void {
    const t = this.now()
    for (const [key, e] of this.entries) {
      if (e.lockedUntil <= t && t - e.windowStart > this.windowMs) {
        this.entries.delete(key)
      }
    }
  }

  /** Test/introspection: number of tracked clients. */
  size(): number {
    return this.entries.size
  }
}

/**
 * The client key to rate-limit on: Cloudflare's real-client header behind the
 * tunnel, else the socket address. `trustProxy` is off, so `req.ip` is the true
 * peer; the CF header is only present (and authoritative) when the request came
 * through our Cloudflare tunnel.
 */
export function loginRateLimitKey(req: {
  headers: Record<string, string | string[] | undefined>
  ip: string
}): string {
  const cf = req.headers['cf-connecting-ip']
  if (typeof cf === 'string' && cf.length > 0) return `cf:${cf}`
  return `ip:${req.ip}`
}
