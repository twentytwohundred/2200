/**
 * Perm-check evaluator.
 *
 * Runs every active check kind on a tool call and returns a
 * structured outcome (`authorized` + per-check results) ready for the
 * dispatcher to write into a perm record. Authorization is the AND of
 * every check's pass/not_applicable; one fail denies the call.
 *
 * v1 active checks (per [[2026-04-25-tool-baseline]] +
 * [[2026-04-26-commons-and-storage-root]]):
 *
 *   - tool_in_set
 *   - command_pattern (shell_run only)
 *   - commons_scope
 *   - shared_scope
 *   - pub_scope
 *
 * RETIRED at session 13 (2026-05-08) per the codebase review:
 *
 *   - idempotency_compatible: blocked legitimate user-requested
 *     destructive tool calls when the originating task happened to be
 *     classified `pure` or `checkpointed`. The perm gate was never
 *     the right place to enforce restart safety; that's a task-
 *     scheduling concern. The `idempotency` field on tool definitions
 *     and tasks is preserved as metadata (telemetry, future restart
 *     logic) but the perm check is gone. Recorded as `not_applicable`
 *     in the placeholder list so historical perm records still parse.
 *     If a specific task wants to restrict the tool surface for that
 *     run, it does so via the explicit `allowedToolNames` set the
 *     dispatcher already consumes (the `tool_in_set` check enforces
 *     it) ... ACL, not category matrix.
 *
 * Inactive at v1 (placeholders for later epics):
 *
 *   - extension_scope    (Extensions framework, Epic 12)
 *   - cost_behavior_gate (cost-behavior shape, Epic 7)
 *   - user_pref          (Behavior dashboard, future epic)
 *
 * Inactive checks are not run; the perm record records this as
 * `not_applicable` for completeness.
 */
import type { CheckImpl, CheckOutcome, PermContext } from './types.js'
import { toolInSet } from './checks/tool-in-set.js'
import { commandPattern } from './checks/command-pattern.js'
import { commonsScope } from './checks/commons-scope.js'
import { sharedScope } from './checks/shared-scope.js'
import { pubScope } from './checks/pub-scope.js'

const ACTIVE_CHECKS: CheckImpl[] = [toolInSet, commandPattern, commonsScope, sharedScope, pubScope]

const INACTIVE_PLACEHOLDERS: CheckOutcome[] = [
  {
    type: 'idempotency_compatible',
    result: 'not_applicable',
    detail: 'retired session 13; idempotency is metadata, not a perm gate',
  },
  {
    type: 'extension_scope',
    result: 'not_applicable',
    detail: 'Extensions framework not yet built (Epic 12)',
  },
  {
    type: 'cost_behavior_gate',
    result: 'not_applicable',
    detail: 'cost-behavior layer not yet wired (Epic 7)',
  },
  { type: 'user_pref', result: 'not_applicable', detail: 'Behavior dashboard not yet built' },
]

export interface EvaluationResult {
  checks: CheckOutcome[]
  authorized: boolean
  /** When `authorized` is false, the first failing check's outcome. */
  denial: CheckOutcome | null
}

export function evaluatePerm(ctx: PermContext): EvaluationResult {
  const checks: CheckOutcome[] = []
  let denial: CheckOutcome | null = null

  for (const impl of ACTIVE_CHECKS) {
    const outcome = impl(ctx)
    checks.push(outcome)
    if (outcome.result === 'fail' && !denial) {
      denial = outcome
    }
  }
  for (const placeholder of INACTIVE_PLACEHOLDERS) {
    checks.push(placeholder)
  }

  return {
    checks,
    authorized: denial === null,
    denial,
  }
}
