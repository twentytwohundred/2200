/**
 * In-memory store for `OnboardingSession` instances.
 *
 * Owned by the supervisor process; a single store backs all HTTP
 * requests for `POST /api/v1/onboarding`, `POST /:id/answer`,
 * `POST /:id/confirm`, and `DELETE /:id`. The store is in-memory only
 * ... an interview-in-progress is ephemeral until confirm() lands the
 * agent on disk. A supervisor restart drops every in-flight session,
 * which matches the CLI's flow: aborting `2200 agent spawn` mid-
 * interview also writes nothing.
 *
 * TTL: sessions expire after a sliding `idleTtlMs` window of
 * inactivity. Default 30 minutes. A periodic cleanup sweep removes
 * expired sessions so a long-running supervisor does not accumulate
 * abandoned interviews.
 */
import type { OnboardingSession } from './session.js'
import { createLogger, type Logger } from '../util/logger.js'

export const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000 // 30 minutes
export const DEFAULT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

interface StoredSession {
  session: OnboardingSession
  createdAt: number
  lastActiveAt: number
}

export interface OnboardingSessionStoreOptions {
  /** Idle TTL in ms. Default 30 minutes. */
  idleTtlMs?: number
  /** Cleanup sweep interval in ms. Default 5 minutes. */
  cleanupIntervalMs?: number
  /** Inject a clock (testing). Defaults to () => Date.now(). */
  now?: () => number
  /** Inject a timer (testing). Defaults to setInterval. */
  setTimer?: (cb: () => void, ms: number) => NodeJS.Timeout
  /** Inject a timer (testing). Defaults to clearInterval. */
  clearTimer?: (handle: NodeJS.Timeout) => void
  logger?: Logger
}

export class OnboardingSessionStore {
  private readonly sessions = new Map<string, StoredSession>()
  private readonly idleTtlMs: number
  private readonly cleanupIntervalMs: number
  private readonly nowFn: () => number
  private readonly setTimer: (cb: () => void, ms: number) => NodeJS.Timeout
  private readonly clearTimer: (handle: NodeJS.Timeout) => void
  private readonly log: Logger
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(opts: OnboardingSessionStoreOptions = {}) {
    this.idleTtlMs = opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS
    this.cleanupIntervalMs = opts.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS
    this.nowFn = opts.now ?? ((): number => Date.now())
    this.setTimer = opts.setTimer ?? ((cb, ms) => setInterval(cb, ms))
    this.clearTimer =
      opts.clearTimer ??
      ((h) => {
        clearInterval(h)
      })
    this.log = opts.logger ?? createLogger('onboarding/sessions')
  }

  /** Register a freshly-built session under its `id`. */
  register(session: OnboardingSession): void {
    const ts = this.nowFn()
    this.sessions.set(session.id, {
      session,
      createdAt: ts,
      lastActiveAt: ts,
    })
  }

  /**
   * Look up a session by id and refresh its `lastActiveAt`. Returns
   * null when the id is unknown OR when the entry has expired (the
   * cleanup sweep may not have removed it yet, but the API surface
   * treats expired = not found).
   */
  touch(id: string): OnboardingSession | null {
    const entry = this.sessions.get(id)
    if (!entry) return null
    const ts = this.nowFn()
    if (ts - entry.lastActiveAt > this.idleTtlMs) {
      this.sessions.delete(id)
      return null
    }
    entry.lastActiveAt = ts
    return entry.session
  }

  /**
   * Read a session without touching its lastActiveAt. Used by the
   * cleanup sweep + tests; HTTP handlers should use `touch`.
   */
  peek(id: string): OnboardingSession | null {
    return this.sessions.get(id)?.session ?? null
  }

  delete(id: string): boolean {
    return this.sessions.delete(id)
  }

  size(): number {
    return this.sessions.size
  }

  /**
   * Begin the periodic cleanup sweep. Idempotent ... starting an
   * already-running store is a no-op. Safe to call before any session
   * is registered.
   */
  start(): void {
    if (this.running) return
    this.running = true
    this.timer = this.setTimer(() => {
      this.sweep()
    }, this.cleanupIntervalMs)
  }

  /** Stop the cleanup sweep. Idempotent. */
  stop(): void {
    if (this.timer) {
      this.clearTimer(this.timer)
      this.timer = null
    }
    this.running = false
  }

  /**
   * Manual sweep. Removes every session whose `lastActiveAt` is older
   * than the TTL. Returns the number removed (useful for tests).
   */
  sweep(): number {
    const ts = this.nowFn()
    let removed = 0
    for (const [id, entry] of this.sessions) {
      if (ts - entry.lastActiveAt > this.idleTtlMs) {
        this.sessions.delete(id)
        removed += 1
      }
    }
    if (removed > 0) {
      this.log.info('onboarding sessions swept', { removed, remaining: this.sessions.size })
    }
    return removed
  }

  /** Test helper: list all live session ids in insertion order. */
  ids(): string[] {
    return [...this.sessions.keys()]
  }
}
