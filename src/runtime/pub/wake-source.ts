/**
 * PubWakeSource: subscribes to a PubClient's events and enqueues a
 * synthetic task in the Agent's task store whenever an incoming
 * message is `directed_to` this Agent.
 *
 * Per Epic 3 spec [[03-local-pub-integration]] PR D. The synthetic
 * task flows through the existing AgentLoop / dispatcher / plan/run/
 * perm wrapping with no parallel code path. Wake attribution lives in
 * the task body (which rule fired) so the loop can act on context.
 *
 * Tracks sent message_ids locally as a side effect of subscribing.
 * When the client receives a `message` event whose agent_id matches
 * this Agent's pub identity, the message_id goes into the
 * `sentMessageIds` set the resolver consumes for rule 2 (reply-to-mine).
 * The set is bounded by `maxSentTracked` to avoid unbounded growth on
 * long-running Agents.
 */
import { newPendingTask } from '../agent/task/types.js'
import { newTaskId } from '../util/id.js'
import type { TaskStore } from '../agent/task/store.js'
import { buildContinuationSection } from '../agent/task/continuation.js'
import type { Logger } from '../util/logger.js'
import { createLogger } from '../util/logger.js'
import { isDirectedTo, type ResolverAgentIdentity } from './directed-to.js'
import type { PubClient, PubEvent } from './client.js'
import type { Router, RouterAgent } from './router.js'
import { readRoster } from './roster.js'

export interface WakeSourceOptions {
  client: PubClient
  /** The Agent's name (for the task store; not the same as agent_id). */
  agentName: string
  /** Pub name; included in synthetic task titles. */
  pubName: string
  /** Resolver-shaped Agent identity (agent_id, handle, optional domains). */
  agent: ResolverAgentIdentity
  taskStore: TaskStore
  /** Inject a logger. */
  logger?: Logger
  /** Max sent message_ids to track. Defaults to 200; older are evicted FIFO. */
  maxSentTracked?: number
  /**
   * Optional router. When set, the wake source consults the router for
   * messages that don't match any deterministic directed_to rule. This
   * is the ambient-routing path (Epic 3.6). Without a router, the wake
   * source falls through to silence on rule misses... existing
   * deterministic behavior. Operators opt-in by configuring a cheap
   * router model on the Agent.
   */
  router?: Router
  /**
   * 2200_HOME root, required only when `router` is set... used to load
   * the per-pub roster file that supplies the router with peer Agents'
   * role blurbs.
   */
  home?: string
  /**
   * Missed-mention sweep interval in milliseconds. The sweep is a
   * periodic backstop: every interval, the wake source reads the cached
   * pub history and creates wake tasks for any mentions of this Agent
   * that didn't produce a task via the live event subscription. Without
   * the sweep, a flaky pub-client connection, a daemon restart that
   * adopted a stale agent, or a missed event-stream broadcast can leave
   * a direct @mention silently unanswered. Defaults to 60_000 ms; set to
   * 0 to disable (tests use this).
   */
  sweepIntervalMs?: number
}

const DEFAULT_MAX_SENT = 200
const DEFAULT_SWEEP_INTERVAL_MS = 60_000
/** Max message_ids tracked as "already processed" by the wake source. */
const DEFAULT_MAX_PROCESSED_TRACKED = 500

export class PubWakeSource {
  private readonly opts: WakeSourceOptions
  private readonly log: Logger
  private readonly maxSentTracked: number
  private readonly sweepIntervalMs: number
  private readonly sentMessageIds = new Set<string>()
  private readonly sentMessageOrder: string[] = []
  /**
   * message_ids the wake source has already enqueued a synthetic task
   * for, in this lifetime (live or backstop). The sweep checks against
   * this set to avoid double-enqueueing. Seeded from the agent's recent
   * task store on start() so an agent restart doesn't re-process every
   * old mention.
   */
  private readonly processedMessageIds = new Set<string>()
  private readonly processedMessageOrder: string[] = []
  private unsubscribe: (() => void) | null = null
  private sweepTimer: NodeJS.Timeout | null = null

  constructor(opts: WakeSourceOptions) {
    this.opts = opts
    this.log = opts.logger ?? createLogger(`pub-wake/${opts.agentName}/${opts.pubName}`)
    this.maxSentTracked = opts.maxSentTracked ?? DEFAULT_MAX_SENT
    this.sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS
  }

  /**
   * Subscribe to the client's event stream. Returns an unsubscribe
   * function (also attached internally so `stop()` is symmetric).
   *
   * Also schedules a periodic missed-mention sweep (see `sweepMissed`)
   * unless `sweepIntervalMs` is 0. The sweep runs every interval and
   * reads the pub's cached history; for any @mention of this Agent
   * that the wake source did not already process (e.g., because the
   * event-stream broadcast was missed, or this Agent was adopted with
   * stale wake-source state through a daemon restart), the sweep
   * creates the same synthetic task the live path would have.
   */
  start(): () => void {
    if (this.unsubscribe) return this.unsubscribe
    // Seed processedMessageIds from the agent's recent tasks so the
    // first sweep doesn't re-process every old mention. Best-effort;
    // failures here just mean the first sweep runs with an empty set
    // (and would create dup tasks only for mentions that don't already
    // have a task ... actually the task-store check inside sweepMissed
    // catches that case anyway. The seed is a fast-path).
    void this.seedProcessedFromTaskStore().catch((err: unknown) => {
      this.log.warn('processed-id seed from task store failed; sweep will fall back', {
        pub: this.opts.pubName,
        agent: this.opts.agentName,
        error: err instanceof Error ? err.message : String(err),
      })
    })
    const unsub = this.opts.client.onEvent((event) => {
      // .catch() is load-bearing: handleEvent calls tryRouter() ->
      // router.route() which hits the LLM provider. A provider
      // error (rate limit, timeout, network) would bubble up as an
      // unhandled rejection and crash the agent process whenever
      // another agent posts in the pub. Per the 2026-05-08 review.
      void this.handleEvent(event).catch((err: unknown) => {
        this.log.error('wake-source handleEvent crashed', {
          pub: this.opts.pubName,
          agent: this.opts.agentName,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        })
      })
    })
    this.unsubscribe = unsub
    if (this.sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => {
        void this.sweepMissed().catch((err: unknown) => {
          this.log.warn('missed-mention sweep crashed', {
            pub: this.opts.pubName,
            agent: this.opts.agentName,
            error: err instanceof Error ? err.message : String(err),
          })
        })
      }, this.sweepIntervalMs)
      // unref so the timer doesn't hold the event loop open during
      // process shutdown.
      this.sweepTimer.unref()
    }
    this.log.info('wake source started', {
      pub: this.opts.pubName,
      agent: this.opts.agentName,
      sweep_interval_ms: this.sweepIntervalMs,
    })
    return unsub
  }

  /** Stop subscribing. Idempotent. */
  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    if (!this.unsubscribe) return
    this.unsubscribe()
    this.unsubscribe = null
    this.log.info('wake source stopped', {
      pub: this.opts.pubName,
      agent: this.opts.agentName,
    })
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async handleEvent(event: PubEvent): Promise<void> {
    // Track sends from room_state too. Pub-server v0.3.x does NOT
    // echo the sender with a 'message' event ... it broadcasts a
    // fresh `room_state` instead. Without scanning room_state for our
    // own message_ids, the `sentMessageIds` set stays empty and the
    // `reply_to_mine` directed_to rule never matches, so we never
    // wake on a peer's reply to our question.
    if (event.type === 'room_state') {
      for (const m of event.data.conversation) {
        if (m.agent_id === this.opts.agent.agent_id) {
          this.recordSent(m.message_id)
        }
      }
      return
    }

    if (event.type !== 'message' && event.type !== 'conversation_event') return

    const cachedRoom = this.opts.client.roomState()
    // For conversation_event we only get a 100-char preview in the
    // envelope; the full message lives in the room_state broadcast that
    // PubClient has already cached. Look it up so the synthetic task
    // body can carry the real text (otherwise the agent has to call
    // pub.read just to find out what woke it, and pub.read's watermark
    // semantics make the trigger message vanish from view).
    const cachedFull =
      cachedRoom?.conversation.find((m) => m.message_id === event.data.message_id) ?? null

    const message =
      event.type === 'message'
        ? {
            message_id: event.data.message_id,
            agent_id: event.data.agent_id,
            display_name: event.data.display_name,
            content: cachedFull?.content ?? event.data.content,
            mentions: event.data.mentions,
            reply_to: event.data.reply_to,
          }
        : {
            message_id: event.data.message_id,
            agent_id: event.data.from.agent_id,
            display_name: event.data.from.display_name,
            content: cachedFull?.content ?? event.data.preview,
            mentions: event.data.mentions,
            // ConversationEvent's wire shape does not include reply_to.
            // Pull it from the cached full message (which arrived via
            // the same room_state broadcast that produced this event)
            // so the directed_to resolver's reply_to_mine rule has the
            // information it needs.
            reply_to: cachedFull?.reply_to ?? null,
          }

    // Track our own sends for rule 2.
    if (message.agent_id === this.opts.agent.agent_id) {
      this.recordSent(message.message_id)
      return // don't wake on our own send
    }

    const roomState = this.opts.client.roomState()
    const memberIds = roomState?.agents_present.map((a) => a.agent_id) ?? []

    const verdict = isDirectedTo({
      message,
      agent: this.opts.agent,
      pub: { member_agent_ids: memberIds, owner_id: null },
      sentMessageIds: this.sentMessageIds,
    })

    let rule: string
    let detail: string | null

    if (verdict.matched) {
      rule = verdict.rule ?? 'unknown'
      detail = verdict.detail
    } else if (this.opts.router) {
      // Ambient routing fallback... but only when the structural
      // signals don't already say "not for me." Two early-outs:
      //
      //  (1) Sender is another Agent. Without this guard, Agents
      //      enter a politeness spiral. The cure is structural:
      //      Agents only wake on other Agents via explicit @-mention
      //      (rule 1). Ambient awareness is human-driven only.
      //
      //  (2) Message has explicit @-mentions for OTHER Agents but
      //      not us. The human picked their target(s); the router
      //      should not second-guess the explicit address. Catches
      //      the case where Doug says "@simon, here is a question"
      //      and the router would otherwise decide hobby should
      //      chime in too. Pre-Epic-3.8 hotfix this was the most
      //      visible source of unwanted Agent chatter.
      //
      // Senders we can't classify (not in roster) are treated as
      // humans by default... safer to wake on an unknown sender
      // than to silence a real question.
      if (await this.isAgentSender(message.agent_id)) {
        return
      }
      if (message.mentions.length > 0 && !message.mentions.includes(this.opts.agent.agent_id)) {
        return
      }
      // Wrap the router call: an LLM provider error inside route()
      // (rate limit, timeout, network failure, malformed response)
      // would otherwise bubble up to the wake-source's onEvent
      // handler. Treating router failure as "no route" keeps the
      // agent quiet rather than crashing the process. The handler-
      // level .catch() in start() is the second line of defense;
      // this is the first.
      let routed
      try {
        routed = await this.tryRouter({
          message_id: message.message_id,
          sender_display_name: message.display_name,
          content: message.content,
        })
      } catch (err) {
        this.log.warn('ambient router failed; treating as no-route', {
          pub: this.opts.pubName,
          agent: this.opts.agentName,
          message_id: message.message_id,
          error: err instanceof Error ? err.message : String(err),
        })
        return
      }
      if (!routed) return
      rule = 'router'
      detail = routed.rationale ?? null
    } else {
      return
    }

    // If this message replies to a prior one (reply_to_mine and
    // similar rules), pull the antecedent from the cached room state
    // so the task body has the conversational context inline. Without
    // this the agent has to call pub.read just to make sense of a
    // bare "yes" / "no" / "confirmed" reply ... and often doesn't,
    // terminating with "I don't have context" instead of acting.
    const antecedent =
      message.reply_to && cachedRoom
        ? (cachedRoom.conversation.find((m) => m.message_id === message.reply_to) ?? null)
        : null

    try {
      await this.enqueueSyntheticTask({
        message_id: message.message_id,
        sender_agent_id: message.agent_id,
        sender_display_name: message.display_name,
        sender_content: message.content,
        rule,
        detail,
        envelope: event.type,
        ...(antecedent
          ? {
              antecedent: {
                display_name: antecedent.display_name,
                content: antecedent.content,
              },
            }
          : {}),
      })
      this.log.info('wake fired; synthetic task enqueued', {
        pub: this.opts.pubName,
        message_id: message.message_id,
        rule,
      })
    } catch (err) {
      this.log.warn('failed to enqueue wake task', {
        pub: this.opts.pubName,
        message_id: message.message_id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Consult the router. Returns the matching RouterDecision-shaped
   * object if our agent_id was named, otherwise null. Loads the
   * roster on every call... reads are cheap (small JSON file) and
   * handle the case where new Agents joined the pub since last wake.
   */
  private async tryRouter(args: {
    message_id: string
    sender_display_name: string
    content: string
  }): Promise<{ rationale?: string } | null> {
    const router = this.opts.router
    const home = this.opts.home
    if (!router || !home) return null

    let routerAgents: RouterAgent[]
    try {
      const roster = await readRoster(home, this.opts.pubName)
      // Pass the COMPLETE roster (including self) with each agent's
      // real role_blurb. Each per-Agent wake source therefore sends
      // the same candidate list to the router; the difference is just
      // the perspective_agent_id. This avoids the failure mode where
      // self was labeled "(this Agent)" with no role and the router
      // concluded "I'm the only one here."
      routerAgents = roster.agents.map((a) => ({
        agent_id: a.agent_id,
        display_name: a.display_name,
        role_blurb: a.role_blurb,
      }))
    } catch (err) {
      this.log.warn('roster read failed; skipping router', {
        pub: this.opts.pubName,
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    }

    // If self isn't in the persisted roster yet (race with the
    // self-upsert at start), inject a minimal entry so we remain a
    // valid candidate for routing.
    if (!routerAgents.some((a) => a.agent_id === this.opts.agent.agent_id)) {
      routerAgents.push({
        agent_id: this.opts.agent.agent_id,
        display_name: this.opts.agentName,
        role_blurb: 'agent in pub',
      })
    }

    const decision = await router.route({
      message_id: args.message_id,
      sender_display_name: args.sender_display_name,
      content: args.content,
      agents: routerAgents,
      perspective_agent_id: this.opts.agent.agent_id,
    })
    if (!decision.woken_agent_ids.includes(this.opts.agent.agent_id)) {
      return null
    }
    return decision.rationale !== undefined ? { rationale: decision.rationale } : {}
  }

  /**
   * True if `agent_id` is registered in the per-pub roster (i.e. it's
   * another Agent in the room, not a human user). Used to gate the
   * router-fallback path so Agent-to-Agent messages don't trigger the
   * politeness spiral. Roster read failures fall back to "not an
   * Agent"... safer to wake on an unknown sender than to silence a
   * real human question.
   */
  private async isAgentSender(agent_id: string): Promise<boolean> {
    const home = this.opts.home
    if (!home) return false
    try {
      const roster = await readRoster(home, this.opts.pubName)
      return roster.agents.some((a) => a.agent_id === agent_id)
    } catch {
      return false
    }
  }

  private recordSent(message_id: string): void {
    if (this.sentMessageIds.has(message_id)) return
    this.sentMessageIds.add(message_id)
    this.sentMessageOrder.push(message_id)
    while (this.sentMessageOrder.length > this.maxSentTracked) {
      const dropped = this.sentMessageOrder.shift()
      if (dropped !== undefined) this.sentMessageIds.delete(dropped)
    }
  }

  private recordProcessed(message_id: string): void {
    if (this.processedMessageIds.has(message_id)) return
    this.processedMessageIds.add(message_id)
    this.processedMessageOrder.push(message_id)
    while (this.processedMessageOrder.length > DEFAULT_MAX_PROCESSED_TRACKED) {
      const dropped = this.processedMessageOrder.shift()
      if (dropped !== undefined) this.processedMessageIds.delete(dropped)
    }
  }

  /**
   * Pre-populate `processedMessageIds` from the agent's existing
   * pub.handle tasks so a fresh wake-source doesn't double-create on
   * its first sweep cycle. Reads the task store, scans for the
   * `Message id: <uuid>` line the live path's composeTaskBody emits.
   */
  private async seedProcessedFromTaskStore(): Promise<void> {
    const tasks = await this.opts.taskStore.list()
    const idLine = /^Message id:\s*(\S+)/m
    for (const t of tasks) {
      if (!t.frontmatter.title.startsWith(`pub.handle: ${this.opts.pubName}`)) continue
      const match = idLine.exec(t.body)
      if (match?.[1]) this.recordProcessed(match[1])
    }
  }

  /**
   * Periodic backstop. Reads the pub client's cached history and, for
   * any message that (a) is directed to this Agent and (b) doesn't
   * already have a corresponding pub.handle task, creates the
   * synthetic task the live path would have. Idempotent against the
   * live path because `processedMessageIds` tracks both routes.
   *
   * The sweep does NOT cover ambient-router routing (rule='router').
   * Ambient routing fires on every event in the moment based on LLM
   * judgment; replaying old events through the router after the fact
   * would burn tokens with no benefit. The sweep only covers
   * deterministic directed_to rules (mentions, replies, etc.), which
   * is exactly where misses matter most.
   */
  async sweepMissed(): Promise<void> {
    const messages = this.opts.client.readCached({ limit: 50 })
    if (messages.length === 0) return
    const roomState = this.opts.client.roomState()
    const memberIds = roomState?.agents_present.map((a) => a.agent_id) ?? []
    let backstopCount = 0
    for (const msg of messages) {
      if (msg.agent_id === this.opts.agent.agent_id) continue // our own send
      if (this.processedMessageIds.has(msg.message_id)) continue
      // Cheap structural check first; only then hit the deterministic
      // resolver. Skip ambient-router path for the sweep (see method docstring).
      const verdict = isDirectedTo({
        message: {
          message_id: msg.message_id,
          agent_id: msg.agent_id,
          content: msg.content,
          mentions: msg.mentions,
          reply_to: msg.reply_to,
        },
        agent: this.opts.agent,
        pub: { member_agent_ids: memberIds, owner_id: null },
        sentMessageIds: this.sentMessageIds,
      })
      if (!verdict.matched) continue

      const antecedent =
        msg.reply_to && roomState
          ? (roomState.conversation.find((m) => m.message_id === msg.reply_to) ?? null)
          : null

      try {
        await this.enqueueSyntheticTask({
          message_id: msg.message_id,
          sender_agent_id: msg.agent_id,
          sender_display_name: msg.display_name,
          sender_content: msg.content,
          rule: verdict.rule ?? 'sweep_backstop',
          detail: verdict.detail
            ? `${verdict.detail} [missed-mention sweep backstop]`
            : '[missed-mention sweep backstop]',
          envelope: 'message',
          ...(antecedent
            ? {
                antecedent: {
                  display_name: antecedent.display_name,
                  content: antecedent.content,
                },
              }
            : {}),
        })
        backstopCount += 1
        this.log.warn('sweep backstop: enqueued wake task for missed mention', {
          pub: this.opts.pubName,
          agent: this.opts.agentName,
          message_id: msg.message_id,
          sender_agent_id: msg.agent_id,
          rule: verdict.rule,
        })
      } catch (err) {
        this.log.warn('sweep backstop: failed to enqueue wake task', {
          pub: this.opts.pubName,
          agent: this.opts.agentName,
          message_id: msg.message_id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    if (backstopCount > 0) {
      this.log.warn('sweep backstop cycle complete', {
        pub: this.opts.pubName,
        agent: this.opts.agentName,
        backstop_tasks_created: backstopCount,
      })
    }
  }

  private async enqueueSyntheticTask(args: {
    message_id: string
    sender_agent_id: string
    sender_display_name: string
    sender_content: string
    rule: string
    detail: string | null
    envelope: 'message' | 'conversation_event'
    antecedent?: { display_name: string; content: string }
  }): Promise<void> {
    // Continuation primitive (decision:
    // 2026-05-16-task-continuation-primitive): before starting a fresh
    // synthetic task, check whether this agent has a task parked on a
    // wait_for matching (pub, sender). If so, resume that task with
    // the inbound appended as continuation context. This is what
    // turns the Discord→Studio→Discord forwarding chain into a single
    // coherent task instead of two isolated ones. The display name
    // comparison is case-insensitive ... agent names are lowercase by
    // convention but display names can drift.
    const waiting = await this.opts.taskStore.findWaiting({
      kind: 'pub',
      pub: this.opts.pubName,
      sender: args.sender_display_name,
    })
    if (waiting) {
      const continuation = buildContinuationSection({
        source_kind: 'pub',
        sender_label: args.sender_display_name,
        context_note: waiting.frontmatter.wait_for?.context_note ?? '',
        body_text: args.sender_content,
        reply_hint:
          `Reply via \`pub_send\` with \`pub: "${this.opts.pubName}"\`. ` +
          `Or use \`discord_send\` / \`whatsapp_send\` / \`chat_send\` to forward back to ` +
          `whoever you originally promised an answer to.`,
      })
      await this.opts.taskStore.updateRecord(waiting.frontmatter.id, (rec) => ({
        frontmatter: {
          ...rec.frontmatter,
          state: 'pending',
          wait_for: null,
        },
        body: `${rec.body}\n\n${continuation}`,
      }))
      this.recordProcessed(args.message_id)
      this.log.info('pub wake → resumed parked task', {
        pub: this.opts.pubName,
        agent: this.opts.agentName,
        task_id: waiting.frontmatter.id,
        sender: args.sender_display_name,
      })
      return
    }
    const task = newPendingTask({
      id: newTaskId(),
      agent: this.opts.agentName,
      title: `pub.handle: ${this.opts.pubName} ← ${args.sender_agent_id} (${args.rule})`,
      body: composeTaskBody({ ...args, pubName: this.opts.pubName }),
      idempotency: 'checkpointed',
      priority: 0,
    })
    await this.opts.taskStore.save(task)
    this.recordProcessed(args.message_id)
  }
}

function composeTaskBody(args: {
  message_id: string
  sender_agent_id: string
  sender_display_name: string
  sender_content: string
  rule: string
  detail: string | null
  envelope: 'message' | 'conversation_event'
  pubName: string
  antecedent?: { display_name: string; content: string }
}): string {
  const isReplyToMine = args.rule === 'reply_to_mine'
  const lines: string[] = [
    `Synthetic task generated by pub wake source.`,
    ``,
    `Pub: ${args.pubName}`,
    `Sender: ${args.sender_display_name} (agent_id ${args.sender_agent_id})`,
    `Message id: ${args.message_id}`,
    `Rule fired: ${args.rule}`,
    `Detail: ${args.detail ?? '(none)'}`,
    ``,
  ]
  if (args.antecedent) {
    if (isReplyToMine) {
      lines.push(
        `This message replies to one of yours. Your earlier message (verbatim):`,
        ``,
        `> ${args.antecedent.content.split('\n').join('\n> ')}`,
        ``,
        `(${args.sender_display_name}'s reply follows below.)`,
        ``,
      )
    } else {
      lines.push(
        `Thread context. The message that woke you was a reply to ${args.antecedent.display_name}'s earlier message (verbatim):`,
        ``,
        `> ${args.antecedent.content.split('\n').join('\n> ')}`,
        ``,
        `(${args.sender_display_name}'s message addressing you follows below.)`,
        ``,
      )
    }
  }
  lines.push(
    `Message that woke you (verbatim):`,
    ``,
    `> ${args.sender_content.split('\n').join('\n> ')}`,
    ``,
  )
  if (isReplyToMine) {
    lines.push(
      `**This is a reply to a question you asked.** You are responsible for closing the loop. Choose ONE of:`,
      ``,
      `  1. \`pub.react\` with an emoji ... if the reply is short (yes/no, "confirmed", a fact you don't need to act on right now). The matching emoji acks that you saw and understood. Reactions do not wake other Agents and never cascade. THIS IS THE EXPECTED RESPONSE for short answers.`,
      `  2. \`pub.send\` with a follow-up ... if the reply opens a substantive next step (a question to ask back, a delegation, a correction).`,
      ``,
      `Do NOT terminate without one of those two. "I see the answer but it lacks context, so I'll do nothing" is wrong ... the antecedent above is the context. React to ack you saw the answer.`,
      ``,
      `Reaction example (preferred for short replies):`,
      ``,
      '```tool',
      `{ "tool": "pub_react", "args": { "pub_name": "${args.pubName}", "message_id": "${args.message_id}", "emoji": "✓" }, "predicted_outcome": "reaction landed on the reply", "reason": "ack that I saw the answer" }`,
      '```',
      ``,
    )
  } else {
    lines.push(
      `${args.sender_display_name} is addressing you. Default behaviour is to respond with one of:`,
      ``,
      `  1. \`pub.send\` ... a substantive text reply (an answer, a question, a delegation).`,
      `  2. \`pub.react\` ... when an emoji ack is enough (the message was an FYI, an agreement signal, or otherwise didn't ask for words).`,
      ``,
      `\`pub.send\` is the ONLY way the sender will see a text reply ... your final-answer text is not delivered to the pub.`,
      ``,
      `Example text reply:`,
      ``,
      '```tool',
      `{ "tool": "pub_send", "args": { "pub_name": "${args.pubName}", "content": "<your reply>", "in_reply_to": "${args.message_id}" }, "predicted_outcome": "message delivered", "reason": "responding to the sender" }`,
      '```',
      ``,
      `Example reaction:`,
      ``,
      '```tool',
      `{ "tool": "pub_react", "args": { "pub_name": "${args.pubName}", "message_id": "${args.message_id}", "emoji": "✓" }, "predicted_outcome": "reaction landed", "reason": "acknowledging without burning a turn" }`,
      '```',
      ``,
    )
  }
  lines.push(
    `If you need broader pub history beyond the antecedent above, call \`pub.read\` with \`{ "limit": 20 }\`. Do NOT pass the woken message_id as \`since_message_id\` ... that asks for messages AFTER the trigger.`,
    ``,
    `Only skip \`pub.send\` AND \`pub.react\` if the message is clearly not for you (spam, an off-topic broadcast, or something another Agent has already addressed). In that rare case mark the task done with a brief outcome explaining why.`,
    ``,
    `If you would otherwise reply with "received", "noted", "standing by", "will do", "got it", "thanks", or a restatement of what was just said: that's the case for \`pub.react\`, not \`pub.send\`. The sender knows the message landed; the room doesn't need a verbal echo. React with the matching emoji and end the task.`,
  )
  return lines.join('\n')
}
