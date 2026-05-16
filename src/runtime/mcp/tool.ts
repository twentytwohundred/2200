/**
 * Tool definition for an MCP server.
 *
 * v1 is in-process: tools are TypeScript objects registered in the
 * runtime. The shape mirrors the MCP wire format (tool name + args
 * schema + execute) so a future PR can swap in stdio MCP transport
 * without rewriting tool definitions or callers.
 *
 * Each tool declares:
 *   - `name`: dotted, e.g., `fs_read`. Matches the baseline-tool table
 *     in [[2026-04-25-tool-baseline]].
 *   - `idempotency`: `pure` / `checkpointed` / `destructive` per
 *     [[2026-04-25-tool-baseline]] (used by the
 *     `idempotency_compatible` perm check).
 *   - `argsSchema`: Zod schema validated by the dispatcher before
 *     execute fires.
 *   - `pathArgs` (optional): declares which args are virtual paths
 *     (`/commons/...`, `/shared/...`, etc.) and what operation they
 *     trigger. The dispatcher resolves the path, runs `commons_scope`
 *     and `shared_scope` perm checks on the resolved scope, and passes
 *     the resolved absolute path into `execute`.
 *   - `execute`: the actual work. Args are post-validation and
 *     post-path-resolution; tools never deal with virtual paths.
 */
import type { ZodType, z } from 'zod'

export type Idempotency = 'pure' | 'checkpointed' | 'destructive'

export type PathOperation = 'read' | 'write' | 'delete'

export interface PathArgDescriptor<Args> {
  argName: keyof Args & string
  operation: PathOperation
}

export interface ToolContext {
  /** Name of the Agent making the call. */
  callingAgent: string
  /** 2200_HOME root. */
  home: string
  /** Calling Agent's brain dir (for record writes; dispatcher fills). */
  brainDir: string
  /** Calling Agent's project dir. */
  projectDir: string
  /** Task ID if this call is in service of a task; null for ad-hoc. */
  taskId: string | null
  /** Per-call ID assigned by the dispatcher. */
  callId: string
  /**
   * Spawn source of the originating task. Surface-aware tools
   * (request_credential) read this to enforce origin restrictions
   * (e.g., "chat only"). Null when the task has no recorded source
   * (legacy records or ad-hoc calls outside a task). Optional so
   * pre-substrate test fixtures that build a ToolContext by hand
   * still compile; the dispatcher always sets it from
   * task.frontmatter.source.
   */
  taskSource?:
    | { kind: 'chat'; chat_id: string; message_id?: string | undefined }
    | { kind: 'pub'; pub: string }
    | { kind: 'schedule'; schedule_id: string }
    | { kind: 'delegation'; parent_task_id: string }
    | { kind: 'cli' }
    | { kind: 'self_spawn' }
    | {
        kind: 'connector'
        connector_id: string
        conversation_id: string
        sender_id: string
        account: string
        sender_display_name?: string | undefined
      }
    | null
}

export interface ToolDefinition<S extends ZodType = ZodType, Result = unknown> {
  name: string
  description: string
  idempotency: Idempotency
  argsSchema: S
  pathArgs?: PathArgDescriptor<z.infer<S>>[]
  execute: (args: z.infer<S>, ctx: ToolContext) => Promise<Result>
}

/**
 * Helper to define a tool without spelling out the generic parameters.
 * Just for ergonomics; the type is inferred from the schema.
 */
export function defineTool<S extends ZodType, Result>(
  def: ToolDefinition<S, Result>,
): ToolDefinition<S, Result> {
  return def
}
