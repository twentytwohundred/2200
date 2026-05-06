/**
 * notification.* baseline tools.
 *
 * Surfaces:
 *   notification.ask    -> blocks the loop until the user responds or
 *                          dismisses. Returns the response text.
 *   notification.inform -> fire-and-forget passive notification.
 *                          Returns immediately; user sees the entry on
 *                          their next inbox open. Use for "look at this"
 *                          surfaces (inbox-message arrival, status
 *                          change, completion summary) where blocking
 *                          the Agent on a user response would be wrong.
 *
 * Future v1.x candidates (not in this PR):
 *   notification.update -> patch a previously-emitted ask
 *
 * Both tools dispatch via the same plan/run/perm wrapping as every
 * other baseline tool. Idempotency is `destructive` because the
 * resulting notification persists in user-visible state.
 */
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../../mcp/tool.js'
import {
  emitNotification,
  waitForResponse,
  NotificationDismissedError,
} from '../../notifications/writer.js'
import { NotificationTierSchema } from '../../notifications/reader.js'

const NotificationAskArgsSchema = z.object({
  /**
   * Tier of the Ask. The tool consults the calling Agent's
   * `notification_policy.tiers_allowed` and refuses tiers outside it
   * (per CLAUDE.md "Notification tier gating": Agents cannot escalate
   * their own priority).
   */
  tier: NotificationTierSchema,
  /**
   * Markdown body shown to the user. Should explain what the Agent
   * needs to know to proceed.
   */
  body: z.string().min(1),
  /** Optional grouping key emitters use to classify the Ask. Defaults to "agent_ask". */
  kind: z.string().min(1).default('agent_ask'),
  /** Hard timeout in seconds. 0 = no timeout (default). */
  timeout_seconds: z.number().int().nonnegative().default(0),
})

export const notificationAsk = defineTool({
  name: 'notification.ask',
  description:
    "Pause and ask the user a question. Returns the user's response when they answer via `2200 notification respond`. Throws if the user dismisses without answering.",
  idempotency: 'destructive',
  argsSchema: NotificationAskArgsSchema,
  execute: async (args, ctx) => {
    // Tier-policy enforcement happens inside emitNotification when
    // enforcePolicy: true is set (Epic 7 PR E). The check refuses
    // tiers outside notification_policy.tiers_allowed per CLAUDE.md
    // "Agents cannot escalate their own priority". Supervisor-driven
    // emitters (BudgetTracker, ProvisioningPipeline) leave the flag
    // off because their tier comes from the action type, not the Agent.
    const emit = await emitNotification({
      home: ctx.home,
      agentName: ctx.callingAgent,
      tier: args.tier,
      kind: args.kind,
      body: args.body,
      requiresResponse: true,
      enforcePolicy: true,
      ...(ctx.taskId !== null ? { extras: { task_id: ctx.taskId } } : {}),
    })

    try {
      const response = await waitForResponse(
        ctx.home,
        emit.id,
        args.timeout_seconds > 0 ? { timeoutMs: args.timeout_seconds * 1000 } : {},
      )
      return { notification_id: emit.id, response, status: 'answered' as const }
    } catch (err) {
      if (err instanceof NotificationDismissedError) {
        return { notification_id: emit.id, response: null, status: 'dismissed' as const }
      }
      throw err
    }
  },
})

const NotificationInformArgsSchema = z.object({
  /**
   * Tier of the notification. Same gating as `notification.ask`:
   * the calling Agent's `notification_policy.tiers_allowed` is
   * enforced (Agents cannot escalate their own priority per
   * CLAUDE.md "Notification tier gating").
   */
  tier: NotificationTierSchema,
  /** Markdown body shown to the user. */
  body: z.string().min(1),
  /**
   * Optional grouping key. Defaults to `agent_inform`. The mobile
   * app + CLI use this to bucket related entries (e.g.,
   * `inbox_arrival`, `task_completed`, `status_update`).
   */
  kind: z.string().min(1).default('agent_inform'),
})

export const notificationInform = defineTool({
  name: 'notification.inform',
  description:
    "Surface a passive notification to the user without blocking the loop. Use for 'look at this' moments (inbox-message arrival, status updates, completion summaries) where you don't need a user response. Fire-and-forget: returns immediately with the new notification's id.",
  idempotency: 'destructive',
  argsSchema: NotificationInformArgsSchema,
  execute: async (args, ctx) => {
    const emit = await emitNotification({
      home: ctx.home,
      agentName: ctx.callingAgent,
      tier: args.tier,
      kind: args.kind,
      body: args.body,
      // Fire-and-forget: no response expected, no waitForResponse.
      requiresResponse: false,
      enforcePolicy: true,
      ...(ctx.taskId !== null ? { extras: { task_id: ctx.taskId } } : {}),
    })
    return { notification_id: emit.id, status: 'emitted' as const }
  },
})

export const notificationTools: ToolDefinition[] = [notificationAsk, notificationInform]
