/**
 * Detector evaluator.
 *
 * Runs the active detectors over the recent loop event stream, in a fixed
 * order. The first detector to fire wins; the loop pauses on its verdict.
 *
 * Active detectors (v1, per 2026-05-12 scope lock):
 *   1. tool_repetition ... cheapest, most common failure
 *   2. error_storm     ... same args + same error usually means a real bug
 *
 * Three other detectors were built but cut from v1's active set per the
 * scope lock: tool_timeout, cost_burst, no_progress. Their source files
 * stay (defer in place); they're available to re-add if symptoms emerge.
 *
 * The evaluator is pure: same inputs, same verdict. The Agent loop calls
 * it after every tool_call_end and after every model_call_end.
 */
import type { Detector, DetectorContext, TripVerdict } from './types.js'
import { toolRepetition } from './tool-repetition.js'
import { errorStorm } from './error-storm.js'

/**
 * The active detectors in priority order. New detectors get appended; do not
 * reorder without considering the trip-verdict semantics (the first to fire
 * wins, so order is meaningful).
 */
export const ACTIVE_DETECTORS: readonly Detector[] = [toolRepetition, errorStorm]

export function evaluateDetectors(ctx: DetectorContext): TripVerdict | null {
  for (const d of ACTIVE_DETECTORS) {
    const verdict = d.evaluate(ctx)
    if (verdict) return verdict
  }
  return null
}
