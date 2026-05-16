/**
 * Live favicon state model.
 *
 * The favicon is a status light reflecting the fleet's current state.
 * Resolution is intentionally tiny: one pure function over a small
 * snapshot. See wiki/design/live-favicon.md for the brief.
 */

export type FaviconState = 'ok' | 'warn' | 'err' | 'off'

export interface FleetSnapshot {
  /** WebSocket / API connection to the runtime is up. */
  connected: boolean
  /** Agents in an `errored` or `blocked_on_user` state ... attention-needed. */
  errorCount: number
  /** Pending operator-facing notifications. */
  inboxCount: number
  /** Agents idle / paused / waiting (stopped agents do not count). */
  idleCount: number
}

/**
 * Resolve a fleet snapshot to the four-state favicon vocabulary.
 *
 * `off` overrides everything ... when the runtime is unreachable we do
 * not pretend to know the fleet's state. Inside the connected branch,
 * error and inbox both raise to `err` (something needs the operator);
 * idle agents raise to `warn`; everything green is `ok`.
 */
export function faviconStateFor(f: FleetSnapshot): FaviconState {
  if (!f.connected) return 'off'
  if (f.errorCount > 0) return 'err'
  if (f.inboxCount > 0) return 'err'
  if (f.idleCount > 0) return 'warn'
  return 'ok'
}

/** Spec'd hex per the brief; do not change without designer sign-off. */
export const FAVICON_COLORS: Record<FaviconState, string> = {
  ok: '#22c97a',
  warn: '#e3a847',
  err: '#e35d4d',
  off: '#7a8089',
}
