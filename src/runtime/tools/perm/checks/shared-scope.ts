import type { CheckImpl } from '../types.js'

/**
 * `shared_scope`: per [[2026-04-26-commons-and-storage-root]]:
 *
 *   - /shared/...   (calling Agent's own shared dir)  -> pass
 *   - /agents/<other>/shared/...                       -> fail (default; explicit
 *                                                          permission to access
 *                                                          another Agent's
 *                                                          shared dir lands in
 *                                                          a future Behavior
 *                                                          dashboard epic)
 *   - everything else                                  -> not_applicable
 *
 * Note: /agents/<other>/brain/... is also denied by `commons_scope`;
 * `shared_scope` covers shared dirs specifically. The two checks
 * compose; both must pass for cross-Agent access to land at v1.
 */
export const sharedScope: CheckImpl = (ctx) => {
  if (ctx.resolvedPaths.size === 0) {
    return { type: 'shared_scope', result: 'not_applicable', detail: null }
  }

  let touchedShared = false
  for (const [argName, scope] of ctx.resolvedPaths) {
    if (scope.kind === 'cross_agent_shared') {
      return {
        type: 'shared_scope',
        result: 'fail',
        detail: `arg '${argName}' targets Agent '${scope.agent}'s shared dir; cross-Agent access is denied by default at v1`,
      }
    }
    if (scope.kind === 'shared') {
      touchedShared = true
    }
  }

  return touchedShared
    ? { type: 'shared_scope', result: 'pass', detail: null }
    : { type: 'shared_scope', result: 'not_applicable', detail: null }
}
