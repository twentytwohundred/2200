/**
 * Agent-to-Agent task delegation (Capability 3 of the 2026-05-12 v1 scope).
 *
 * The `task_create_for_agent` tool lets a calling Agent create a task in
 * another Agent's queue. Receiving Agents process delegated tasks
 * identically to operator-submitted tasks. Provenance is recorded in the
 * new task's frontmatter so:
 *
 *   - The originating Agent receives a completion notification when the
 *     delegated task terminates (wired in AgentProcess.recordResult).
 *   - The operator inbox sees a passive-tier "delegation observed"
 *     notification when each delegation lands.
 *   - The budget dashboard can trace a goal's total cost by walking the
 *     delegation chain backwards.
 *
 * Design notes (locked in the 2026-05-12 delta sign-off):
 *
 *   - **No permission gates** in v1. Any Agent can delegate to any Agent
 *     in the same fleet. The audit trail provides traceability; pathology
 *     is a dashboard concern, not a runtime concern.
 *   - **Lookup via team.md.** The calling Agent reads the shared-brain
 *     team note to discover who can be delegated to. The tool itself only
 *     validates that the target's identity file exists.
 *   - **Refusal via prose** for v1. A receiving Agent that cannot do the
 *     delegation completes the task normally; the assistant's summary
 *     text carries the rejection rationale. v1.x may add a structured
 *     rejected-outcome shape.
 *   - **Depth cap at 5.** Each delegation increments
 *     `delegation_depth`. A call from a task at depth 5 throws
 *     `ToolArgsError`. Cycles (A → B → A) are permitted up to the cap.
 *   - **Fail loud on missing task context.** ctx.taskId is always
 *     populated in v1 (every Agent tool call originates from a task), but
 *     the type permits null. If the invariant ever breaks, the tool
 *     refuses rather than writing a delegation with no provenance.
 */
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../../mcp/tool.js'
import { TaskStore } from '../../agent/task/store.js'
import { newPendingTask } from '../../agent/task/types.js'
import { newTaskId } from '../../util/id.js'
import { agentPaths } from '../../storage/layout.js'
import { stat } from 'node:fs/promises'
import { emitNotification } from '../../notifications/writer.js'

export const MAX_DELEGATION_DEPTH = 5

const TaskCreateForAgentArgsSchema = z.object({
  target_agent: z
    .string()
    .min(1)
    .describe(
      'Name of the peer Agent to delegate to. Must exist on this 2200 instance. ' +
        'Read `brain_read_shared { slug: "team" }` to discover available Agents.',
    ),
  title: z
    .string()
    .min(1)
    .max(200)
    .describe('Short task title (one line). The receiving Agent sees this in its task queue.'),
  body: z
    .string()
    .min(1)
    .describe(
      'Task body. Treated identically to an operator-submitted task body by the receiving ' +
        "Agent: the full prompt the Agent's loop sees as user input.",
    ),
  idempotency: z
    .enum(['pure', 'checkpointed', 'destructive'])
    .optional()
    .default('destructive')
    .describe(
      "Task idempotency class. Delegations default to 'destructive' since they typically " +
        'request work that mutates external state. Set to `pure` for read-only research tasks.',
    ),
  priority: z
    .number()
    .int()
    .optional()
    .default(0)
    .describe("Integer priority; higher wins inside the receiving Agent's task queue. Default 0."),
})

async function agentExists(home: string, name: string): Promise<boolean> {
  try {
    const identityPath = agentPaths(home, name).identity
    const s = await stat(identityPath)
    return s.isFile()
  } catch {
    return false
  }
}

export function makeTaskDelegateTools(): ToolDefinition[] {
  const taskCreateForAgent = defineTool({
    name: 'task_create_for_agent',
    description:
      'Delegate a task to another Agent on this 2200 instance. The receiving Agent treats the task ' +
      'identically to one you (the operator) submitted: it appears in their queue, fires their loop, ' +
      'and produces an outcome. Provenance is auto-recorded; when the task terminates you receive a ' +
      'completion notification in your inbox. ' +
      'Discover available Agents via `brain_read_shared { slug: "team" }`. ' +
      'Delegations have a depth cap of 5; deeper chains throw a clean error so a calling Agent can ' +
      'restructure or escalate instead of fanning out indefinitely.',
    idempotency: 'destructive',
    argsSchema: TaskCreateForAgentArgsSchema,
    execute: async (args, ctx) => {
      // Fail loud if the call is somehow outside a task context. In v1 this
      // is unreachable (every Agent tool call originates from a task), but
      // the type allows null and we want a clear failure if that ever
      // changes rather than a delegation with no provenance.
      if (!ctx.taskId) {
        throw new Error(
          'task_create_for_agent requires a task context (ctx.taskId is null). ' +
            'Delegation outside a task is not supported. This indicates a runtime bug; ' +
            'please report.',
        )
      }

      // Validate the target exists.
      const exists = await agentExists(ctx.home, args.target_agent)
      if (!exists) {
        throw new Error(
          `target Agent "${args.target_agent}" does not exist on this 2200 instance. ` +
            `Discover available Agents via brain_read_shared { slug: "team" }.`,
        )
      }

      // Read the calling Agent's current task to determine delegation depth.
      const callerStore = new TaskStore(ctx.home, ctx.callingAgent)
      const callerTask = await callerStore.get(ctx.taskId)
      if (!callerTask) {
        throw new Error(
          `calling Agent "${ctx.callingAgent}" has no task with id ${ctx.taskId}. ` +
            `This indicates a runtime bug.`,
        )
      }
      const parentDepth = callerTask.frontmatter.delegation_depth
      if (parentDepth >= MAX_DELEGATION_DEPTH) {
        throw new Error(
          `delegation depth cap reached: parent task is at depth ${String(parentDepth)} ` +
            `(cap is ${String(MAX_DELEGATION_DEPTH)}). Restructure the work or escalate to the operator ` +
            `via notification_ask or chat_send instead of delegating further.`,
        )
      }

      // Write the new task to the target Agent's task store.
      const targetStore = new TaskStore(ctx.home, args.target_agent)
      const taskId = newTaskId()
      const newTask = newPendingTask({
        id: taskId,
        agent: args.target_agent,
        title: args.title,
        body: args.body,
        idempotency: args.idempotency,
        priority: args.priority,
        delegated_by: ctx.callingAgent,
        delegating_task_id: ctx.taskId,
        delegation_depth: parentDepth + 1,
      })
      await targetStore.save(newTask)

      // Emit an operator-visibility notification so the fleet's
      // self-organizing activity is observable from the inbox without
      // requiring the operator to be in every Agent's chat.
      try {
        await emitNotification({
          home: ctx.home,
          agentName: ctx.callingAgent,
          tier: 'passive',
          kind: 'delegation_observed',
          body:
            `**${ctx.callingAgent}** delegated to **${args.target_agent}**: ${args.title}\n\n` +
            `Task: ${taskId}\nDepth: ${String(parentDepth + 1)}/${String(MAX_DELEGATION_DEPTH)}`,
          extras: {
            originator: ctx.callingAgent,
            originator_task_id: ctx.taskId,
            target_agent: args.target_agent,
            target_task_id: taskId,
            delegation_depth: parentDepth + 1,
            idempotency: args.idempotency,
          },
        })
      } catch {
        // Notifications are best-effort; we don't fail the delegation
        // if the notification write hiccups.
      }

      return {
        task_id: taskId,
        target_agent: args.target_agent,
        delegation_depth: parentDepth + 1,
      }
    },
  })

  return [taskCreateForAgent]
}
