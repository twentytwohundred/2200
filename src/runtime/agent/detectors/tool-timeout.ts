/**
 * tool_timeout detector.
 *
 * Fires when a single tool call exceeds `tool_timeout_ms` (default 120s). The
 * loop populates duration_ms on tool_call_end; this detector simply checks the
 * most recent end against the threshold.
 *
 * Note: the dispatcher itself enforces tool-internal timeouts (e.g., shell.run
 * has its own timeout, web.fetch has its own). Those are per-tool budgets.
 * This detector is the cross-tool ceiling — even a tool with a longer internal
 * budget shouldn't normally take this long, and if it does, the loop pauses for
 * user inspection.
 */
import type { Detector, DetectorContext, TripVerdict } from './types.js'

export const toolTimeout: Detector = {
  kind: 'tool_timeout',
  evaluate(ctx: DetectorContext): TripVerdict | null {
    const limit = ctx.thresholds.tool_timeout_ms
    if (limit <= 0) return null
    for (let i = ctx.events.length - 1; i >= 0; i--) {
      const e = ctx.events[i]
      if (e?.kind !== 'tool_call_end') continue
      if (e.duration_ms > limit) {
        return {
          kind: 'tool_timeout',
          detail: `tool "${e.tool}" took ${String(e.duration_ms)}ms (threshold=${String(limit)}ms)`,
          triggers: [e.call_id],
          threshold_used: { tool_timeout_ms: limit },
        }
      }
      // Most recent end is what matters; if it didn't trip, stop scanning.
      return null
    }
    return null
  },
}
