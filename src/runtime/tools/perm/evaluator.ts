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
 *   - idempotency_compatible
 *   - command_pattern (shell.run only)
 *   - commons_scope
 *   - shared_scope
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
import { idempotencyCompatible } from './checks/idempotency-compatible.js'
import { commandPattern } from './checks/command-pattern.js'
import { commonsScope } from './checks/commons-scope.js'
import { sharedScope } from './checks/shared-scope.js'
import { pubScope } from './checks/pub-scope.js'

const ACTIVE_CHECKS: CheckImpl[] = [
  toolInSet,
  idempotencyCompatible,
  commandPattern,
  commonsScope,
  sharedScope,
  pubScope,
]

const INACTIVE_PLACEHOLDERS: CheckOutcome[] = [
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
