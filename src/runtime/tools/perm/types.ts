/**
 * Perm check types.
 *
 * v1 check types per [[2026-04-25-tool-baseline]] +
 * [[2026-04-26-commons-and-storage-root]]:
 *
 *   tool_in_set            - tool is in the Agent's declared tool set
 *   extension_scope        - call falls within installed Extensions' scope (n/a at v1)
 *   cost_behavior_gate     - cost-behavior layer 1 hasn't tripped (n/a at v1)
 *   user_pref              - user preferences allow this kind of call (n/a at v1)
 *   idempotency_compatible - task category vs tool category compatibility
 *   command_pattern        - shell.run only; first-time commands prompt
 *   commons_scope          - per the commons addendum
 *   shared_scope           - per the commons addendum
 *
 * Each check returns pass / fail / not_applicable + optional detail.
 * The evaluator records results into a perm record per the wrapping
 * spec; `authorized` = AND of every check's pass/not_applicable.
 */
import type { ResolvedScope } from '../../storage/path-resolver.js'
import type { Idempotency, ToolDefinition } from '../../mcp/tool.js'

export type CheckType =
  | 'tool_in_set'
  | 'extension_scope'
  | 'cost_behavior_gate'
  | 'user_pref'
  | 'idempotency_compatible'
  | 'command_pattern'
  | 'commons_scope'
  | 'shared_scope'

export type CheckResult = 'pass' | 'fail' | 'not_applicable'

export interface CheckOutcome {
  type: CheckType
  result: CheckResult
  detail: string | null
}

export interface PermContext {
  /** Calling Agent's name. */
  callingAgent: string
  /** Tool the Agent is trying to call. */
  tool: ToolDefinition
  /** Tools allowed for this Agent (baseline + Identity additions). */
  allowedToolNames: ReadonlySet<string>
  /** Task idempotency category, or null when not in a task. */
  taskIdempotency: Idempotency | null
  /**
   * Pre-resolved virtual paths (one per pathArg the tool declared),
   * keyed by argName. Empty when the tool has no path args.
   */
  resolvedPaths: ReadonlyMap<string, ResolvedScope>
  /**
   * For shell.run, the command being executed (used by command_pattern).
   * Null otherwise.
   */
  shellCommand: string | null
}

export type CheckImpl = (ctx: PermContext) => CheckOutcome
