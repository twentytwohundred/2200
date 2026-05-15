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
import { defineTool, type ToolContext, type ToolDefinition } from '../../mcp/tool.js'
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
import type { SupervisorRpcGetter } from './schedule.js'
import { CredentialNameSchema } from '../../credentials/types.js'
import { CredentialVault } from '../../credentials/vault.js'
import type { TaskBlockerRegistry } from '../../agent/blockers.js'
import { mkdir, open as fsOpen, unlink as fsUnlink } from 'node:fs/promises'
import { join } from 'node:path'
import { homePaths } from '../../storage/layout.js'

const CredentialHasArgsSchema = z.object({
  /** Vault credential name to check. Slug regex enforced. */
  credential_name: CredentialNameSchema,
})

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

/**
 * In-process dedup for credential_request: when the same Agent issues
 * multiple credential_request calls for the same credential_name in
 * quick succession (e.g. a model that emits multiple fenced tool
 * blocks in one response), the second-through-Nth calls return the
 * SAME promise as the first. Only one paste card hits the operator's
 * chat. Survives any path-through the loop dispatcher because the
 * gate is at the tool's execute boundary, not at the dispatch level.
 *
 * Cleared when the first call's promise resolves (whether
 * fulfilled / declined / expired). Process-local; a supervisor
 * restart resets it, which is fine since cross-process duplicates
 * are caught by the on-disk concurrent_request_pending guard
 * subsequently.
 */
const inFlightCredentialRequests = new Map<string, Promise<unknown>>()

/** Build the credential server's tool. Identity getter is mandatory; the
 * supervisor RPC getter is optional but load-bearing for the
 * operator-UI WS broadcast — without it the system-role chat message
 * lands on disk but the operator's web client doesn't refetch until
 * something else triggers an invalidation. */
export function credentialTools(
  getIdentity: IdentityGetter,
  getSupervisorRpc?: SupervisorRpcGetter,
  getBlockerRegistry?: () => TaskBlockerRegistry,
): ToolDefinition[] {
  const blockerRegistry = getBlockerRegistry ? getBlockerRegistry() : null
  const credentialHas = defineTool({
    name: 'credential_has',
    description:
      'Check whether a credential by name is present in your vault. Returns {exists, set_at, provider} ... the value itself is never returned, no field on this response carries plaintext. Use this RIGHT AFTER credential_request returns fulfilled to confirm the value actually landed before reporting success to the operator.',
    idempotency: 'pure',
    argsSchema: CredentialHasArgsSchema,
    execute: async (args, ctx) => {
      const vault = new CredentialVault(ctx.home, ctx.callingAgent)
      const has = await vault.has(args.credential_name)
      if (!has) {
        return {
          credential_name: args.credential_name,
          exists: false as const,
          set_at: null,
          provider: null,
        }
      }
      // Fetch the metadata only (the value is unsealed too, but we
      // intentionally never include it on the response). Metadata is
      // also visible via the vault.list path; this gives the calling
      // tool a focused single-name lookup.
      try {
        const rec = await vault.get(args.credential_name)
        // Post-fulfill verification: if this credential was just operator-
        // provided (a fulfilled request record exists for this agent + name),
        // register an `awaiting_completion` blocker. The loop will allow
        // the next model call but the model's next output must be a final
        // assistant reply ... emitting another tool call triggers the
        // incomplete-turn nudge with a small retry budget.
        const normalized = args.credential_name.toLowerCase().trim()
        const store = new CredentialRequestStore(ctx.home)
        const fulfilledRecords = await store.list({
          agent: ctx.callingAgent,
          state: 'fulfilled',
        })
        const fulfilledRecord = fulfilledRecords.find(
          (r) => (r.credential_name || '').toLowerCase().trim() === normalized,
        )
        if (blockerRegistry && fulfilledRecord) {
          const already = blockerRegistry
            .getActive('awaiting_completion')
            .some(
              (b) =>
                (b.metadata?.['credential_name'] as string | undefined)?.toLowerCase().trim() ===
                normalized,
            )
          if (!already) {
            blockerRegistry.register({
              id: `credreq_final_${normalized}_${String(Date.now())}`,
              kind: 'awaiting_completion',
              description: `Verification complete for ${args.credential_name} — awaiting final assistant reply`,
              metadata: {
                credential_name: args.credential_name,
                chat_id: fulfilledRecord.chat_id,
              },
            })
          }
        }

        // Append strong guidance to the chat so the model's next iteration
        // sees an explicit "speak now, no tools" reminder right next to the
        // credential_has result. Only fires when there was actually a
        // fulfilled request (i.e. this is a post-fulfill verification, not
        // a probe for an already-in-vault credential).
        if (fulfilledRecord) {
          try {
            const chats = new MultiChatStore(ctx.home, ctx.callingAgent)
            await chats.appendMessage({
              chatId: fulfilledRecord.chat_id,
              role: 'system',
              body: `You have now successfully verified that "${args.credential_name}" is in your vault. Your *very next action* must be to produce a final assistant reply to the operator confirming the credential is verified (set_at: ${rec.metadata.created_at}) or continue the downstream work the operator originally asked for. Do not call any more tools. Speak directly to the operator.`,
              kind: null,
              taskId: ctx.taskId,
            })
          } catch {
            // best effort; the prompt rule + the awaiting_completion blocker
            // are the durable enforcement.
          }
        }

        return {
          credential_name: args.credential_name,
          exists: true as const,
          set_at: rec.metadata.created_at,
          provider: rec.metadata.provider ?? null,
        }
      } catch {
        return {
          credential_name: args.credential_name,
          exists: true as const,
          set_at: null,
          provider: null,
        }
      }
    },
  })

  const requestCredential = defineTool({
    name: 'credential_request',
    description:
      "Ask the operator to paste a credential value through the 1:1 chat surface. The value goes directly into your per-Agent vault; you never see it. Returns when the operator fulfills, declines, or the 5-minute timeout expires.\n\nMANDATORY FLOW (runtime-enforced):\n1. ALWAYS call `credential_has` first for the name.\n2. If not present, call `credential_request` from a 1:1 chat only (never in pub).\n3. After it returns `fulfilled`, call `credential_has` again to verify.\n4. Then **your very next output** (no more tool calls) must be a final assistant reply to the user confirming the credential is verified in vault (include the set_at timestamp from credential_has) **or** continue the downstream work using `http_request`. Do not wait for another human message. Do not call any more tools until you have spoken to the user.\n\nDo NOT re-emit `credential_request` for the same name in this task — the runtime will decline it with 'already_fulfilled_in_this_task'.\n\nDecline reasons you may receive:\n- 'already_in_vault': Already have it — use `credential_has` and proceed.\n- 'already_fulfilled_in_this_task': Operator already provided it in this task. Stop asking, call `credential_has`, give final reply.\n- 'concurrent_request_pending': Another request for this name is pending.\n- 'rate_capped': Hit per-hour limit.\n- 'surface_invalid': Must be from a 1:1 chat task.\n\nThe ONLY ways to use the credential are `http_request` (bearer_credential) or MCP skill env. Never shell or fs hunt for the vault file. Silent termination or failure to produce a final user-facing reply after verification is a bug — the guidance message + credential_has are your signal to speak to the user now.",
    idempotency: 'destructive',
    argsSchema: RequestCredentialArgsSchema,
    execute: async (args, ctx) => {
      // 0. In-process dedup: if the same Agent already has a
      // credential_request for the same credential_name in flight,
      // return the existing promise. One paste card, one operator
      // response. Defends against models that emit multiple
      // parallel tool blocks in one response and against any
      // race that lets the for-loop dispatch multiple calls
      // before the on-disk guard sees the prior record.
      const dedupKey = `${ctx.callingAgent}:${args.credential_name}`
      const existing = inFlightCredentialRequests.get(dedupKey) as
        | Promise<CredentialRequestToolResult>
        | undefined
      if (existing) {
        return await existing
      }
      const work = doCredentialRequest(args, ctx)
      inFlightCredentialRequests.set(dedupKey, work)
      try {
        return await work
      } finally {
        if (inFlightCredentialRequests.get(dedupKey) === work) {
          inFlightCredentialRequests.delete(dedupKey)
        }
      }
    },
  })
  return [requestCredential, credentialHas]

  /** The actual body. Kept inside the closure so it captures
   * getIdentity / getSupervisorRpc; the outer execute wraps it in
   * the in-process dedup gate. */
  async function doCredentialRequest(
    args: z.infer<typeof RequestCredentialArgsSchema>,
    ctx: ToolContext,
  ): Promise<CredentialRequestToolResult> {
    // 1. Surface check: only chat-spawned tasks may dispatch.
    const source = ctx.taskSource ?? null
    if (source?.kind !== 'chat') {
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

    // Final durable structural rule (2026-05-15):
    // Once any credential_request for this credential_name has been
    // fulfilled in this task (the store has a fulfilled record for this
    // agent + name in this chat/task), any later credential_request for
    // the *same* name is permanently refused for the life of the task.
    // This is the ironclad guarantee that the Agent cannot re-ask after success.
    const normalizedName = args.credential_name.toLowerCase().trim()

    // Even more immediate check: refuse if any request record for this
    // agent + name has already been operator-fulfilled (has fulfilled_at).
    // This closes the race where the fulfilled record state might not be
    // visible yet, but the fulfilled_at is set at the same time as the seal.
    const allRecords = await store.list({ agent: ctx.callingAgent })
    const operatorAlreadyProvided = allRecords.some(
      (r) => (r.credential_name || '').toLowerCase().trim() === normalizedName && r.fulfilled_at,
    )

    if (operatorAlreadyProvided) {
      try {
        const chats = new MultiChatStore(ctx.home, ctx.callingAgent)
        const guidance = `The credential "${args.credential_name}" has already been provided by the operator in this task (fulfilled_at is set). You must not call credential_request for this name again. Call credential_has to verify, then produce the final assistant reply.`
        await chats.appendMessage({
          chatId: chatId,
          role: 'system',
          body: guidance,
          kind: null,
          taskId: ctx.taskId,
        })
      } catch {
        // best effort
      }

      return {
        status: 'declined' as const,
        credential_name: args.credential_name,
        decline_reason: 'credential_protocol_complete',
        set_at: null,
        expired_reason: null,
      }
    }

    // 1b. Already-in-vault guard. The Agent should call
    // `credential_has` BEFORE issuing a new request; if the value
    // is already in vault, there's no need to ask the operator
    // again. This guards against the failure mode where the model
    // emits credential_request → fulfilled → re-emits
    // credential_request for the same credential in a follow-up
    // turn (a tight loop the prompt alone doesn't always interrupt).
    const vault = new CredentialVault(ctx.home, ctx.callingAgent)
    if (await vault.has(args.credential_name)) {
      return {
        status: 'declined' as const,
        credential_name: args.credential_name,
        decline_reason: 'already_in_vault',
        set_at: null,
        expired_reason: null,
      }
    }

    // 1c. Concurrent-request guard. If a prior credential_request
    // for the same Agent + same credential_name is still pending,
    // refuse this call rather than stacking a duplicate paste card
    // in the operator's chat. Defends against models that emit
    // multiple parallel tool calls in one turn (the calling-
    // discipline rule in the tool description tells the model not
    // to, but the runtime should not depend on model compliance).
    const concurrent = await store.list({
      agent: ctx.callingAgent,
      state: 'pending',
    })
    const dup = concurrent.find((r) => r.credential_name === args.credential_name)
    if (dup) {
      return {
        status: 'declined' as const,
        credential_name: args.credential_name,
        decline_reason: 'concurrent_request_pending',
        set_at: null,
        expired_reason: null,
      }
    }

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

    // 3b. Atomic on-disk claim (lockfile 'wx') immediately before the
    // only place a record is created. This closes the last race window
    // where two calls could pass the in-memory Map + the pending-list
    // query before either create commits. The loser returns
    // 'concurrent_request_pending' without writing a duplicate record.
    // Lock is released immediately after the create (the on-disk
    // pending record + existing concurrent list guard protect further
    // callers for the duration of the operator wait).
    const lockDir = homePaths(ctx.home).stateCredentialRequests
    const lockPath = join(lockDir, `.lock-${ctx.callingAgent}-${args.credential_name}`)
    let lockHandle: Awaited<ReturnType<typeof fsOpen>>
    try {
      await mkdir(lockDir, { recursive: true })
      lockHandle = await fsOpen(lockPath, 'wx')
    } catch (err) {
      if (err !== null && typeof err === 'object' && 'code' in err && err.code === 'EEXIST') {
        return {
          status: 'declined' as const,
          credential_name: args.credential_name,
          decline_reason: 'concurrent_request_pending',
          set_at: null,
          expired_reason: null,
        }
      }
      throw err
    }
    try {
      await store.create(rec)
    } finally {
      await lockHandle.close().catch(() => undefined)
      await fsUnlink(lockPath).catch(() => undefined)
    }

    // 4. Insert the chat-thread system message carrying the
    // credential_request_v1 envelope. The web client reads this and
    // renders the CredentialRequestCard.
    const chats = new MultiChatStore(ctx.home, ctx.callingAgent)
    let appendedMsgId: string | null = null
    try {
      const msg = await chats.appendMessage({
        chatId: chatId,
        role: 'system',
        body: JSON.stringify(toEnvelopeV1(rec)),
        kind: 'credential_request',
        taskId: ctx.taskId,
      })
      appendedMsgId = msg.id
    } catch {
      // If the chat thread can't accept a system message, the
      // request record still exists on disk and the HTTP /list
      // endpoint surfaces it. The Agent's resolution path still
      // works.
    }

    // 4b. Ping the supervisor so connected operator UIs get a
    // chat.message WS event and refetch the messages query. Without
    // this, the system-role message sits on disk until something
    // else triggers a refetch. Best-effort: a missing RPC client
    // (test contexts, supervisor disconnect) is not fatal.
    if (appendedMsgId !== null && getSupervisorRpc) {
      const client = getSupervisorRpc()
      if (client) {
        try {
          await client.call('agent.chatMessage', {
            chat_id: chatId,
            message_id: appendedMsgId,
            role: 'system',
            kind: 'credential_request',
          })
        } catch {
          // Best-effort; operator UI will catch up on next refetch.
        }
      }
    }

    // 5. Register a TaskBlocker (kind: 'human_gate') so the AgentLoop will
    // refuse new model calls or new tool dispatches while the operator is
    // still pasting. Resolved below when the tool returns ... whether
    // fulfilled, declined, or expired.
    if (blockerRegistry) {
      blockerRegistry.register({
        id: `credreq_${requestId}`,
        kind: 'human_gate',
        description: `Waiting for operator to provide ${args.credential_name}`,
        metadata: {
          credential_name: args.credential_name,
          request_id: requestId,
          chat_id: chatId,
        },
      })
    }

    // 6. Block until resolved or the local timeout fires...
    const slackMs = 2_000
    const remainingMs = Math.max(0, expiresAt.getTime() - Date.now()) + slackMs
    const final = await waitForResolution(store, requestId, {
      pollIntervalMs: 250,
      timeoutMs: remainingMs,
    })

    // Operator is done with the human-gate step. Resolve the blocker so
    // the loop can pick back up and the model can call `credential_has`
    // (per the system prompt) and then produce the final reply.
    //
    // The "model must speak to confirm" enforcement happens later, when
    // `credential_has` succeeds and registers an `awaiting_completion`
    // blocker. We deliberately do NOT try to force `credential_has` via
    // a blocker here ... that conflates "operator step complete" with
    // "agent must call a specific tool next," and the prompt + audit
    // pass already cover that responsibility.
    if (blockerRegistry) {
      blockerRegistry.resolve(`credreq_${requestId}`)
    }

    // 7. If we timed out and the record is still pending, flip it
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
  }
}

/** Locked return shape for credential_request. */
interface CredentialRequestToolResult {
  status: 'fulfilled' | 'declined' | 'expired'
  credential_name: string
  set_at: string | null
  decline_reason: string | null
  expired_reason: 'timeout' | 'agent_crashed' | 'agent_archived' | null
}
