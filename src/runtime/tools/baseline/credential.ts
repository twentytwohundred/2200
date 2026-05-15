/**
 * credential.* baseline tools.
 *
 * `request_credential` lets an Agent ask the operator to paste a
 * credential value through a 1:1 chat surface. The substrate
 * guarantees the value never enters the Agent's loop context, never
 * transits the LLM provider, and never appears in transcripts or
 * brain notes. See decision:
 *   wiki/decisions/2026-05-14-request-credential-substrate.md
 *
 * Surface restriction: only tasks whose `source.kind === 'chat'` can
 * dispatch this tool. Pub / schedule / self-spawn / cli / null
 * sources are rejected inline with decline_reason='surface_invalid'.
 *
 * Rate cap: per-Agent rolling 1-hour window, default 15 / hour,
 * configurable via identity frontmatter
 * (`request_credential_rate_per_hour`). On cap-hit the tool returns
 * declined with reason='rate_capped' AND emits an operator
 * notification at `important` tier so the operator sees why progress
 * stalled.
 *
 * Blocking model: the tool blocks the dispatcher's execute() promise
 * until the operator resolves the request OR the 5-minute timeout
 * elapses. The Agent's loop sees a single long-running tool call
 * (same pattern as `notification_ask`). The state machine's
 * blocked_on_user transition is not actively flipped here ... the
 * loop's tool-in-flight surface already reflects "waiting on user"
 * via the ToolStream, and the supervisor's lifecycle hooks treat the
 * paused tool the same as any other in-flight call.
 */
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../../mcp/tool.js'
import { CredentialRequestSchema } from '../../credentials/request-types.js'
import {
  CredentialRequestStore,
  resolveRateCap,
  waitForResolution,
} from '../../credentials/requests.js'
import {
  CredentialKindSchema,
  DEFAULT_TIMEOUT_MS,
  toEnvelopeV1,
  type CredentialRequest,
} from '../../credentials/request-types.js'
import { newCredentialRequestId } from '../../util/id.js'
import { MultiChatStore } from '../../agent/chat/multi-store.js'
import { emitNotification } from '../../notifications/writer.js'
import type { IdentityGetter } from './system.js'
import { CredentialNameSchema } from '../../credentials/types.js'

const RequestCredentialArgsSchema = z.object({
  /**
   * Vault credential name to write the value to. Slug regex enforced
   * by CredentialNameSchema. Convention: `<skill>--<env>` for skill-
   * sourced credentials.
   */
  credential_name: CredentialNameSchema,
  /** Short human-readable label. Surfaces as the card title. */
  label: z.string().min(1).max(120),
  /**
   * Explanation shown to the operator (where to find the value, what
   * format to paste, links to dashboards). Markdown allowed.
   */
  help: z.string().max(2000).default(''),
  /** Widget hint; matches the `mcp:` extension. */
  kind: CredentialKindSchema,
  /**
   * Justification surfaced alongside the prompt. The operator reads
   * this before deciding to provide / decline.
   */
  reason: z.string().min(1).max(1000),
})

/** Build the credential server's tool, parameterised by identity getter. */
export function credentialTools(getIdentity: IdentityGetter): ToolDefinition[] {
  const requestCredential = defineTool({
    name: 'credential_request',
    description:
      "Ask the operator to paste a credential value through the 1:1 chat surface. The pasted value goes directly into your per-Agent vault under the supplied credential_name; you never see it. Returns when the operator fulfills, declines, or the 5-minute timeout expires. Use this when a needed credential isn't already in your vault and a 1:1 chat with the operator is available ... not a substitute for the install-time wizard, which is still the right path for credentials known at skill-install time.",
    idempotency: 'destructive',
    argsSchema: RequestCredentialArgsSchema,
    execute: async (args, ctx) => {
      // 1. Surface check: only chat-spawned tasks may dispatch.
      const source = ctx.taskSource ?? null
      if (source === null || source.kind !== 'chat') {
        return {
          status: 'declined' as const,
          credential_name: args.credential_name,
          decline_reason: 'surface_invalid',
          set_at: null,
          expired_reason: null,
        }
      }
      // After the narrowing above, source is the chat variant.
      const chatSource = source
      const chatId: string = chatSource.chat_id

      const store = new CredentialRequestStore(ctx.home)

      // 2. Rate-cap check.
      const identity = getIdentity()
      const cap = resolveRateCap({
        identityOverride: identity?.frontmatter.request_credential_rate_per_hour ?? null,
      })
      const rate = await store.checkAndIncrementRate({
        agent: ctx.callingAgent,
        cap,
        now: new Date(),
      })
      if (!rate.ok) {
        // Cap hit ... emit operator notification so the operator sees
        // why progress stalled, then return declined to the Agent.
        try {
          await emitNotification({
            home: ctx.home,
            agentName: ctx.callingAgent,
            tier: 'important',
            kind: 'credential_request_rate_capped',
            body:
              `${ctx.callingAgent} hit the request_credential rate cap (` +
              `${String(rate.count)} of ${String(rate.cap)} in the current hour, ` +
              `window started ${rate.window_start}). The Agent's next ` +
              'credential request will be refused until the window rolls over.',
            requiresResponse: false,
            // Supervisor-driven emit; do not enforce identity policy
            // here because the tool is alerting the operator, not the
            // Agent escalating its own priority.
            enforcePolicy: false,
            ...(ctx.taskId !== null ? { extras: { task_id: ctx.taskId } } : {}),
          })
        } catch {
          // Notification emit is best-effort; the tool result is the
          // authoritative signal to the Agent.
        }
        return {
          status: 'declined' as const,
          credential_name: args.credential_name,
          decline_reason: 'rate_capped',
          set_at: null,
          expired_reason: null,
        }
      }

      // 3. Build + persist the request record. The value field never
      // exists on this record.
      const now = new Date()
      const expiresAt = new Date(now.getTime() + DEFAULT_TIMEOUT_MS)
      const requestId = newCredentialRequestId()
      const rec: CredentialRequest = CredentialRequestSchema.parse({
        schema_version: 1,
        id: requestId,
        agent: ctx.callingAgent,
        chat_id: chatId,
        credential_name: args.credential_name,
        label: args.label,
        help: args.help,
        kind: args.kind,
        reason: args.reason,
        created_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        state: 'pending',
        fulfilled_at: null,
        declined_at: null,
        decline_reason: null,
        expired_at: null,
        expired_reason: null,
      })
      await store.create(rec)

      // 4. Insert the chat-thread system message carrying the
      // credential_request_v1 envelope. The web client reads this and
      // renders the CredentialRequestCard.
      const chats = new MultiChatStore(ctx.home, ctx.callingAgent)
      try {
        await chats.appendMessage({
          chatId: chatId,
          role: 'system',
          body: JSON.stringify(toEnvelopeV1(rec)),
          kind: 'credential_request',
          taskId: ctx.taskId,
        })
      } catch {
        // If the chat thread can't accept a system message, the
        // request record still exists on disk and the HTTP /list
        // endpoint surfaces it. The Agent's resolution path still
        // works.
      }

      // 5. Block until resolved or the local timeout fires. We honor
      // a slight slack over expires_at to give a sweeper a chance to
      // flip the state; if the sweeper hasn't acted, we flip locally.
      const slackMs = 2_000
      const remainingMs = Math.max(0, expiresAt.getTime() - Date.now()) + slackMs
      const final = await waitForResolution(store, requestId, {
        pollIntervalMs: 250,
        timeoutMs: remainingMs,
      })

      // 6. If we timed out and the record is still pending, flip it
      // to expired ourselves. The sweeper would have done it
      // eventually; doing it here keeps the tool's return value
      // consistent with the record on disk.
      let resolved = final
      if (resolved.state === 'pending') {
        try {
          resolved = await store.transition(requestId, 'expired', {
            now: new Date().toISOString(),
            expired_reason: 'timeout',
          })
        } catch {
          // Lost a race to the sweeper or the HTTP path; re-read for
          // the authoritative state.
          resolved = await store.get(requestId)
        }
      }

      // 7. Build the Agent-facing result. The VALUE never appears.
      if (resolved.state === 'fulfilled') {
        return {
          status: 'fulfilled' as const,
          credential_name: resolved.credential_name,
          set_at: resolved.fulfilled_at,
          decline_reason: null,
          expired_reason: null,
        }
      }
      if (resolved.state === 'declined') {
        return {
          status: 'declined' as const,
          credential_name: resolved.credential_name,
          set_at: null,
          decline_reason: resolved.decline_reason,
          expired_reason: null,
        }
      }
      // expired
      return {
        status: 'expired' as const,
        credential_name: resolved.credential_name,
        set_at: null,
        decline_reason: null,
        // Only 'timeout' ever reaches the Agent here. agent_crashed /
        // agent_archived surface in the operator UI only because the
        // Agent isn't around to receive them.
        expired_reason: resolved.expired_reason ?? 'timeout',
      }
    },
  })
  return [requestCredential]
}
