/**
 * no_progress detector.
 *
 * Fires when the loop has run more than `no_progress_iterations` model calls
 * since the last brain_write or task-state transition. The intent is to catch
 * an Agent that keeps calling tools but never advances the task forward (no
 * note-taking, no state transition).
 *
 * "Progress" is defined narrowly per spec: a brain_write or a state_transition
 * that's not a self-loop. Other tool calls (fs.read, web.fetch, shell.run)
 * don't count as progress on their own; without a brain_write to record the
 * finding or a state transition to mark a milestone, the loop is just spinning.
 */
import type { Detector, DetectorContext, TripVerdict } from './types.js'

export const noProgress: Detector = {
  kind: 'no_progress',
  evaluate(ctx: DetectorContext): TripVerdict | null {
    const limit = ctx.thresholds.no_progress_iterations
    if (limit <= 0) return null
    let lastProgressIteration = -1
    let maxIteration = -1
    for (const e of ctx.events) {
      if ('iteration' in e && e.iteration > maxIteration) {
        maxIteration = e.iteration
      }
      if (e.kind === 'brain_write') {
        lastProgressIteration = Math.max(lastProgressIteration, e.iteration)
      }
      if (e.kind === 'state_transition' && e.from !== e.to) {
        lastProgressIteration = Math.max(lastProgressIteration, e.iteration)
      }
    }
    if (maxIteration < 0) return null
    const sinceProgress = maxIteration - lastProgressIteration
    if (sinceProgress < limit) return null
    return {
      kind: 'no_progress',
      detail: `${String(sinceProgress)} loop iterations since the last brain_write or state transition (threshold=${String(limit)})`,
      triggers: [],
      threshold_used: { no_progress_iterations: limit },
    }
  },
}
