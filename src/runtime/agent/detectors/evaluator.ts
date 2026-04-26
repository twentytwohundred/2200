/**
 * Detector evaluator.
 *
 * Runs the active detectors over the recent loop event stream, in a fixed
 * order. The first detector to fire wins; the loop pauses on its verdict.
 *
 * Order is intentional:
 *   1. tool_repetition  — cheapest, most common failure
 *   2. error_storm      — same args + same error usually means a real bug
 *   3. tool_timeout     — single-call ceiling
 *   4. cost_burst       — windowed; needs scanning
 *   5. no_progress      — slowest; counts iterations across whole event stream
 *
 * The evaluator is pure: same inputs, same verdict. The Agent loop calls it
 * after every tool_call_end (and after every model_call_end for cost_burst).
 */
import type { Detector, DetectorContext, TripVerdict } from './types.js'
import { toolRepetition } from './tool-repetition.js'
import { errorStorm } from './error-storm.js'
import { toolTimeout } from './tool-timeout.js'
import { costBurst } from './cost-burst.js'
import { noProgress } from './no-progress.js'

/**
 * The active detectors in priority order. New detectors get appended; do not
 * reorder without considering the trip-verdict semantics (the first to fire
 * wins, so order is meaningful).
 */
export const ACTIVE_DETECTORS: readonly Detector[] = [
  toolRepetition,
  errorStorm,
  toolTimeout,
  costBurst,
  noProgress,
]

export function evaluateDetectors(ctx: DetectorContext): TripVerdict | null {
  for (const d of ACTIVE_DETECTORS) {
    const verdict = d.evaluate(ctx)
    if (verdict) return verdict
  }
  return null
}
