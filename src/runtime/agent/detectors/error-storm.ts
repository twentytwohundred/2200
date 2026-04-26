/**
 * error_storm detector.
 *
 * Fires when the same `error_class` repeats across `error_storm_n` consecutive
 * tool_call_end events with `ok: false` (default N=5). Catches the case where
 * the model is hammering the same broken call (file not found, auth failed,
 * rate limited) without backing off.
 *
 * "Consecutive" here means consecutive failed calls; successful calls in
 * between reset the counter. If the model alternates between calls that
 * succeed and a call that fails, that's not a storm — it's normal operation
 * with one stubborn problem the model is working around.
 */
import type { Detector, DetectorContext, TripVerdict } from './types.js'

export const errorStorm: Detector = {
  kind: 'error_storm',
  evaluate(ctx: DetectorContext): TripVerdict | null {
    const n = ctx.thresholds.error_storm_n
    if (n < 2) return null
    const ends = ctx.events.filter((e) => e.kind === 'tool_call_end')
    if (ends.length < n) return null
    let streak: { class: string; calls: string[] } | null = null
    for (const e of ends) {
      if (e.ok) {
        streak = null
        continue
      }
      const cls = e.error_class ?? 'UnknownError'
      if (streak !== null && streak.class === cls) {
        streak.calls.push(e.call_id)
      } else {
        streak = { class: cls, calls: [e.call_id] }
      }
      if (streak.calls.length >= n) {
        return {
          kind: 'error_storm',
          detail: `${String(n)} consecutive tool calls failed with "${cls}"`,
          triggers: [...streak.calls],
          threshold_used: { error_storm_n: n },
        }
      }
    }
    return null
  },
}
