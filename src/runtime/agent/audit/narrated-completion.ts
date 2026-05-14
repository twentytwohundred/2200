/**
 * Narrated-completion audit (post-task, not an in-loop detector).
 *
 * Catches the failure mode where an Agent ends a task with a confident
 * narrative ("created the playlist", "uploaded the cover") while having
 * made zero successful tool calls. Observed live in 2026-05-11 session
 * 17: a `destructive` task fired one LLM call, zero tool calls, and
 * produced an 821-token success narrative. The operator only learned
 * 30+ minutes later.
 *
 * Heuristic for v1: at task-done time, if the task was `destructive`
 * AND no tool call returned ok in any iteration, flag it. Rationale:
 * `destructive` tasks by definition affect external state, which
 * requires tool execution. A destructive task that ends `done` with
 * zero successful tool calls is either a hallucination or a no-op the
 * agent claimed to perform.
 *
 * Why this shape over a text-content analysis:
 *   - Deterministic. No false positives from regex-on-prose.
 *   - Idempotency is already a load-bearing per-task signal.
 *   - Pure Q&A tasks (idempotency = 'pure') are silent, as they should
 *     be ... they're allowed to complete without tool calls.
 *
 * What this misses (acceptable for v1):
 *   - A destructive task that calls one successful tool then narrates
 *     more work it did not do (partial hallucination). Catches the
 *     "did nothing" case, not the "did some, claimed more" case.
 *   - A pure task that hallucinates a Q&A answer. Out of scope here.
 *
 * Both gaps remain follow-ups for a richer audit (LLM-confirmed text
 * vs. tool-record analysis).
 */
import type { LoopEvent } from '../detectors/types.js'
import type { TaskIdempotency } from '../../control-plane/protocol.js'

export type AuditFlagKind = 'narrated_completion_without_tool_call'

export interface AuditFlag {
  kind: AuditFlagKind
  detail: string
  /** How many tool calls were attempted (any outcome). */
  attempted: number
  /** How many returned ok = true. */
  succeeded: number
}

export interface NarratedCompletionAuditContext {
  events: readonly LoopEvent[]
  idempotency: TaskIdempotency
}

/**
 * Run the audit. Returns a flag if the heuristic fires; null otherwise.
 */
export function auditNarratedCompletion(ctx: NarratedCompletionAuditContext): AuditFlag | null {
  if (ctx.idempotency !== 'destructive') return null
  let attempted = 0
  let succeeded = 0
  for (const ev of ctx.events) {
    if (ev.kind === 'tool_call_end') {
      attempted += 1
      if (ev.ok) succeeded += 1
    }
  }
  if (succeeded > 0) return null
  return {
    kind: 'narrated_completion_without_tool_call',
    detail:
      attempted === 0
        ? 'destructive task completed without any tool calls; assistant text only'
        : `destructive task completed with ${String(attempted)} attempted tool call(s), none returned ok`,
    attempted,
    succeeded,
  }
}
