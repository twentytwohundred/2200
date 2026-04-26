import type { CheckImpl } from '../types.js'

/**
 * `commons_scope`: enforces the default rules from
 * [[2026-04-26-commons-and-storage-root]]:
 *
 *   - Reads to /commons/...                         -> allowed
 *   - Writes to /commons/scratch/...                -> allowed
 *   - Writes to /commons/reference/...              -> denied (human-only)
 *   - Writes to /commons/... (other top-level)      -> allowed (unstructured)
 *   - Cross-Agent /agents/<other>/{shared,brain}/   -> denied (default)
 *   - Other path kinds (project, brain, shared)     -> not_applicable
 *
 * The check fires once per resolved path arg the tool declared. Any
 * fail short-circuits the call.
 */
export const commonsScope: CheckImpl = (ctx) => {
  if (ctx.resolvedPaths.size === 0) {
    return { type: 'commons_scope', result: 'not_applicable', detail: null }
  }

  for (const [argName, scope] of ctx.resolvedPaths) {
    const op = pathArgOperation(ctx, argName)

    if (scope.kind === 'commons_reference') {
      if (op === 'write' || op === 'delete') {
        return {
          type: 'commons_scope',
          result: 'fail',
          detail: `arg '${argName}' targets /commons/reference/ which is human-only for writes`,
        }
      }
      // reads to reference are allowed; continue to the next arg.
      continue
    }

    if (scope.kind === 'cross_agent_shared' || scope.kind === 'cross_agent_brain') {
      return {
        type: 'commons_scope',
        result: 'fail',
        detail: `arg '${argName}' targets ${scope.kind === 'cross_agent_shared' ? "another Agent's shared dir" : "another Agent's brain"}; cross-Agent access is denied by default at v1`,
      }
    }

    // commons (general), commons_scratch, project, brain, shared all
    // pass the commons-scope check. (project/brain/shared are
    // technically out-of-scope for this check; they evaluate against
    // shared_scope or fall to not_applicable. For commons_scope they
    // are 'pass' because no commons rule denies them.)
  }

  return { type: 'commons_scope', result: 'pass', detail: null }
}

function pathArgOperation(
  ctx: Parameters<CheckImpl>[0],
  argName: string,
): 'read' | 'write' | 'delete' {
  const descriptor = ctx.tool.pathArgs?.find((d) => d.argName === argName)
  return descriptor?.operation ?? 'read'
}
