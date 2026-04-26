/**
 * cost_burst detector.
 *
 * Fires when the cumulative `cost_usd` of model_call_end events within the
 * last `cost_burst_window_ms` (default 10 minutes) exceeds `cost_burst_usd`
 * (default $5). The intent is to catch cost runaway early — a model that gets
 * stuck retrying with expanding context can burn dollars per minute without a
 * tool_repetition match (because the args change as context grows).
 *
 * Cost values are estimates produced by the LLMProvider on each call. They are
 * not authoritative billing; they're "good enough to detect runaway." A future
 * PR will reconcile against the provider's billing API once a billing layer
 * exists.
 */
import type { Detector, DetectorContext, TripVerdict } from './types.js'

export const costBurst: Detector = {
  kind: 'cost_burst',
  evaluate(ctx: DetectorContext): TripVerdict | null {
    const windowMs = ctx.thresholds.cost_burst_window_ms
    const limit = ctx.thresholds.cost_burst_usd
    if (windowMs <= 0 || limit <= 0) return null
    const now = ctx.now()
    const cutoff = now - windowMs
    let total = 0
    for (const e of ctx.events) {
      if (e.kind !== 'model_call_end') continue
      if (e.at < cutoff) continue
      total += e.cost_usd
    }
    if (total < limit) return null
    return {
      kind: 'cost_burst',
      detail: `model spend reached $${total.toFixed(4)} in the last ${String(Math.round(windowMs / 60000))} minutes (threshold=$${String(limit)})`,
      triggers: [],
      threshold_used: {
        cost_burst_window_ms: windowMs,
        cost_burst_usd: limit,
      },
    }
  },
}
