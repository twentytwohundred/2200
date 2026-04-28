/**
 * notification.* baseline tools (Epic 7 PR D).
 *
 * v1 surfaces:
 *   notification.ask  -> blocks the loop until the user responds or
 *                        dismisses. Returns the response text.
 *
 * Future v1.1 candidates (not in this PR):
 *   notification.inform  -> fire-and-forget passive notification
 *   notification.update  -> patch a previously-emitted ask
 *
 * The tool dispatches via the same plan/run/perm wrapping as every
 * other baseline tool. Idempotency is `destructive` because the
 * resulting notification persists in user-visible state and the
 * Ask response can drive subsequent Agent decisions.
 */
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../../mcp/tool.js'
import {
  emitNotification,
  waitForResponse,
  NotificationDismissedError,
} from '../../notifications/writer.js'
import { NotificationTierSchema } from '../../notifications/reader.js'
import { loadIdentity } from '../../identity/loader.js'
import { agentPaths } from '../../storage/layout.js'

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
    // Tier-policy enforcement: refuse tiers outside the calling
    // Agent's allowed list. The schema (Identity v4) carries
    // notification_policy.tiers_allowed which excludes 'critical'
    // by default; opting in is an explicit Identity-file edit.
    const id = await loadIdentity(agentPaths(ctx.home, ctx.callingAgent).identity)
    const allowed = id.frontmatter.notification_policy.tiers_allowed
    if (!allowed.includes(args.tier)) {
      throw new Error(
        `notification.ask: tier "${args.tier}" is not in this Agent's notification_policy.tiers_allowed (${allowed.join(', ')}). Edit the Identity file to add it; Agents cannot escalate their own priority.`,
      )
    }

    const emit = await emitNotification({
      home: ctx.home,
      agentName: ctx.callingAgent,
      tier: args.tier,
      kind: args.kind,
      body: args.body,
      requiresResponse: true,
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

export const notificationTools: ToolDefinition[] = [notificationAsk]
