/**
 * tool_repetition detector.
 *
 * Fires when the same `(tool, args_hash)` appears in N consecutive completed
 * tool_call_end events (default N=5). Captures the classic "model is stuck
 * calling fs.read on the same path forever" failure mode.
 *
 * Operates on tool_call_end (not start) so partial calls don't trip the
 * detector. The args hash is computed by the loop (stable JSON canonicalize +
 * SHA-1 of the result); identical hashes mean semantically-equivalent args.
 */
import type { Detector, DetectorContext, TripVerdict } from './types.js'

export const toolRepetition: Detector = {
  kind: 'tool_repetition',
  evaluate(ctx: DetectorContext): TripVerdict | null {
    const n = ctx.thresholds.tool_repetition_n
    if (n < 2) return null
    const ends = ctx.events.filter((e) => e.kind === 'tool_call_end')
    if (ends.length < n) return null
    const tail = ends.slice(-n)
    const first = tail[0]
    if (!first) return null
    const allSame = tail.every((e) => e.tool === first.tool && e.args_hash === first.args_hash)
    if (!allSame) return null
    return {
      kind: 'tool_repetition',
      detail: `same tool "${first.tool}" called ${String(n)} times consecutively with identical args (hash=${first.args_hash.slice(0, 12)}…)`,
      triggers: tail.map((e) => e.call_id),
      threshold_used: { tool_repetition_n: n },
    }
  },
}
