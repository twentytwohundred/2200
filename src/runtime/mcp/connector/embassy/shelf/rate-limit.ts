/**
 * Shelf placement rate limiter (Phase 2 / PR-B2).
 *
 * Per the locked 2026-05-26 decision: lightweight, logging-first
 * burst guard. In-memory, per-embassy, 60-second rolling window.
 * Resets on supervisor restart (acceptable per spec; storage of
 * rate-limit state would be over-engineering for v1).
 *
 *   `soft_per_minute` (default 20) — exceeding fires
 *      `connector.embassy_shelf_rate_threshold` (normal tier);
 *      placements continue to succeed.
 *   `hard_per_minute` (default 100) — exceeding rejects placement
 *      with `ToolDeniedError` reason `placement_rate_exceeded` and
 *      fires `connector.embassy_shelf_rate_exceeded` (important tier).
 *
 * Per-embassy overrides live on the ConduitRecord's `rate_limits`
 * field. When null/absent on the record, the system defaults apply.
 */
import type { ConduitRateLimits } from '../types.js'

export const DEFAULT_SHELF_RATE_LIMITS: ConduitRateLimits = {
  soft_per_minute: 20,
  hard_per_minute: 100,
}

const WINDOW_MS = 60_000

export type RateClassification = 'ok' | 'soft_threshold_crossed' | 'hard_threshold_exceeded'

interface EmbassyWindow {
  /** Placement timestamps in this rolling window. */
  timestamps: number[]
  /** True iff a soft-threshold audit has already fired in this window. */
  softFiredThisWindow: boolean
}

/**
 * Per-process limiter. Keyed by embassy agent name. Tests can
 * construct a fresh instance via `new ShelfRateLimiter()`; the
 * production singleton lives in `Supervisor`.
 */
export class ShelfRateLimiter {
  private readonly windows = new Map<string, EmbassyWindow>()
  private readonly now: () => number

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now
  }

  /**
   * Register a placement attempt and classify the outcome. Caller
   * uses the return value to decide whether to (a) proceed, (b)
   * proceed + emit soft audit, (c) reject + emit hard audit.
   */
  classifyAndRecord(
    embassyAgent: string,
    limits: ConduitRateLimits = DEFAULT_SHELF_RATE_LIMITS,
  ): RateClassification {
    const now = this.now()
    const cutoff = now - WINDOW_MS
    let entry = this.windows.get(embassyAgent)
    if (entry === undefined) {
      entry = { timestamps: [], softFiredThisWindow: false }
      this.windows.set(embassyAgent, entry)
    }
    // Drop expired entries (cheap; the window is short).
    while (entry.timestamps.length > 0) {
      const first = entry.timestamps[0]
      if (first === undefined || first >= cutoff) break
      entry.timestamps.shift()
    }
    // If the window has rolled past where the soft-threshold fired,
    // reset the flag so a fresh burst gets its own audit row.
    if (entry.timestamps.length === 0) entry.softFiredThisWindow = false

    const count = entry.timestamps.length
    if (count >= limits.hard_per_minute) {
      // Hard reject — do NOT record this placement (it didn't happen).
      return 'hard_threshold_exceeded'
    }
    entry.timestamps.push(now)

    const newCount = entry.timestamps.length
    if (newCount > limits.soft_per_minute && !entry.softFiredThisWindow) {
      entry.softFiredThisWindow = true
      return 'soft_threshold_crossed'
    }
    return 'ok'
  }

  /** Test helper. Number of recorded placements in the current window for the embassy. */
  size(embassyAgent: string): number {
    const entry = this.windows.get(embassyAgent)
    if (entry === undefined) return 0
    const cutoff = this.now() - WINDOW_MS
    return entry.timestamps.filter((t) => t >= cutoff).length
  }

  /** Test helper. */
  reset(): void {
    this.windows.clear()
  }
}
