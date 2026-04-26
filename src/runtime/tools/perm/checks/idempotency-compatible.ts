import type { CheckImpl, CheckResult } from '../types.js'
import type { Idempotency } from '../../../mcp/tool.js'

/**
 * `idempotency_compatible`: enforces the matrix from
 * [[2026-04-25-tool-baseline]]. Mismatches fail at the perm layer on
 * the first wrong call rather than silently compounding on auto-resume.
 *
 *   pure         -> pure only
 *   checkpointed -> pure, checkpointed
 *   destructive  -> pure, checkpointed, destructive
 *
 * When the tool is not invoked in service of a task (taskIdempotency
 * is null), this check is `not_applicable`. The wrapping is still
 * recorded so the absence of a task is visible in the perm record.
 */
export const idempotencyCompatible: CheckImpl = (ctx) => {
  if (ctx.taskIdempotency === null) {
    return {
      type: 'idempotency_compatible',
      result: 'not_applicable',
      detail: 'no task in context',
    }
  }
  const result = compatibility(ctx.taskIdempotency, ctx.tool.idempotency)
  if (result === 'pass') {
    return { type: 'idempotency_compatible', result: 'pass', detail: null }
  }
  return {
    type: 'idempotency_compatible',
    result: 'fail',
    detail: `task=${ctx.taskIdempotency}, tool=${ctx.tool.idempotency}`,
  }
}

function compatibility(taskCat: Idempotency, toolCat: Idempotency): CheckResult {
  if (taskCat === 'destructive') return 'pass'
  if (taskCat === 'checkpointed') {
    return toolCat === 'destructive' ? 'fail' : 'pass'
  }
  // taskCat === 'pure'
  return toolCat === 'pure' ? 'pass' : 'fail'
}
