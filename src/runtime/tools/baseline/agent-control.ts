/**
 * agent_control.* baseline tools.
 *
 * Surface for an Agent to manage its own process lifecycle. v1 ships
 * one tool: `restart_self`. The tool dispatches the supervisor's
 * `cli.agent.restart_self` RPC with the calling Agent's name locked
 * to `ctx.callingAgent` (no caller-supplied target).
 *
 * **Cross-Agent restart is not exposed here by design.** An Agent
 * cannot stop or restart another Agent through this tool surface ...
 * that would create a malice vector (one Agent disrupting another's
 * work). Cross-Agent lifecycle goes through the operator (CLI
 * `2200 agent stop <name>` / `start <name>` or the web app),
 * never through an Agent-callable tool.
 *
 * Use case (the one we observed): a small-model Agent's loop wedges
 * itself in a state that a fresh process would clear (e.g., stale
 * provider auth cached in memory, a tool client whose connection
 * dropped, accumulated context that the in-loop compactor cannot
 * recover from). The Agent reasons "I should restart myself" and
 * calls `restart_self`. The supervisor schedules the restart 500ms
 * after the RPC returns so this tool's response flushes back to the
 * Agent loop before the process is recycled.
 */
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../../mcp/tool.js'
import type { JsonRpcClient } from '../../control-plane/client.js'

export type SupervisorRpcGetter = () => JsonRpcClient | undefined

function requireClient(get: SupervisorRpcGetter): JsonRpcClient {
  const client = get()
  if (!client) {
    throw new Error(
      'supervisor RPC client not available; the Agent has not registered with the supervisor yet. This usually means a tool was called from boot code rather than from a task loop.',
    )
  }
  return client
}

const RestartSelfArgsSchema = z.object({
  /**
   * Short explanation of why a fresh process is needed. Logged by the
   * supervisor and surfaced in the operator's audit trail so the
   * operator can review patterns of self-restart over time.
   */
  reason: z.string().min(1).max(500),
})

/**
 * Restart the calling Agent's process. The supervisor stops the
 * current process gracefully (SIGTERM, then SIGKILL on timeout) and
 * starts a fresh one with the same Identity. The Agent loses its
 * in-memory state; on-disk state (brain notes, task store, sealed
 * credentials) survives.
 */
export function makeRestartSelf(get: SupervisorRpcGetter): ToolDefinition {
  return defineTool({
    name: 'restart_self',
    description:
      "Restart your own Agent process. Use when your loop is stuck in a state a fresh process would clear (stale connection, wedged auth state, accumulated context that won't compact, persistent malformed-tool-call loop). The supervisor will stop you gracefully and start a fresh process with the same Identity ~500ms after this returns. You will lose in-memory state; on-disk state (brain, tasks, sealed credentials) survives. `reason` is logged and shown to the operator so they can review patterns. Cross-Agent restart (restarting another Agent) is not available through this tool by design ... that goes through the operator.",
    idempotency: 'destructive',
    argsSchema: RestartSelfArgsSchema,
    execute: async (args, ctx) => {
      const client = requireClient(get)
      const result = await client.call('cli.agent.restart_self', {
        name: ctx.callingAgent,
        reason: args.reason,
      })
      return result
    },
  })
}

export function agentControlTools(get: SupervisorRpcGetter): ToolDefinition[] {
  return [makeRestartSelf(get)]
}
