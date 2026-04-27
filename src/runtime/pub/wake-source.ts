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
}

const DEFAULT_MAX_SENT = 200

export class PubWakeSource {
  private readonly opts: WakeSourceOptions
  private readonly log: Logger
  private readonly maxSentTracked: number
  private readonly sentMessageIds = new Set<string>()
  private readonly sentMessageOrder: string[] = []
  private unsubscribe: (() => void) | null = null

  constructor(opts: WakeSourceOptions) {
    this.opts = opts
    this.log = opts.logger ?? createLogger(`pub-wake/${opts.agentName}/${opts.pubName}`)
    this.maxSentTracked = opts.maxSentTracked ?? DEFAULT_MAX_SENT
  }

  /**
   * Subscribe to the client's event stream. Returns an unsubscribe
   * function (also attached internally so `stop()` is symmetric).
   */
  start(): () => void {
    if (this.unsubscribe) return this.unsubscribe
    const unsub = this.opts.client.onEvent((event) => {
      void this.handleEvent(event)
    })
    this.unsubscribe = unsub
    this.log.info('wake source started', {
      pub: this.opts.pubName,
      agent: this.opts.agentName,
    })
    return unsub
  }

  /** Stop subscribing. Idempotent. */
  stop(): void {
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
            reply_to: null,
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
      // Ambient routing fallback... but ONLY for messages from a human.
      // When another Agent posts, we deliberately skip the router and
      // let the message scroll by. Without this guard, Agents enter a
      // politeness spiral: A acks B → router wakes B → B acks A's ack
      // → router wakes A → ad infinitum. The cure is structural: an
      // Agent has to be explicitly @-mentioned (rule 1) to wake on
      // another Agent's message; ambient awareness is human-driven
      // only. Senders we can't classify (not in roster) are treated
      // as humans by default... safer to wake on an unknown sender
      // than to silence a real question.
      if (await this.isAgentSender(message.agent_id)) {
        return
      }
      const routed = await this.tryRouter({
        message_id: message.message_id,
        sender_display_name: message.display_name,
        content: message.content,
      })
      if (!routed) return
      rule = 'router'
      detail = routed.rationale ?? null
    } else {
      return
    }

    try {
      await this.enqueueSyntheticTask({
        message_id: message.message_id,
        sender_agent_id: message.agent_id,
        sender_display_name: message.display_name,
        sender_content: message.content,
        rule,
        detail,
        envelope: event.type,
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

    let routerAgents: RouterAgent[] = []
    try {
      const roster = await readRoster(home, this.opts.pubName)
      routerAgents = roster.agents
        // Don't include self; the router only chooses among other Agents
        // for this Agent's wake decision.
        .filter((a) => a.agent_id !== this.opts.agent.agent_id)
        .map((a) => ({
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

    // Always include self in the candidate list so the router can pick
    // us. We filtered out self above to avoid a self-referential entry
    // from the persisted roster (which only sees what was registered
    // through `agent create`).
    routerAgents.push({
      agent_id: this.opts.agent.agent_id,
      display_name: this.opts.agentName,
      role_blurb: '(this Agent)',
    })

    const decision = await router.route({
      message_id: args.message_id,
      sender_display_name: args.sender_display_name,
      content: args.content,
      agents: routerAgents,
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

  private async enqueueSyntheticTask(args: {
    message_id: string
    sender_agent_id: string
    sender_display_name: string
    sender_content: string
    rule: string
    detail: string | null
    envelope: 'message' | 'conversation_event'
  }): Promise<void> {
    const task = newPendingTask({
      id: newTaskId(),
      agent: this.opts.agentName,
      title: `pub.handle: ${this.opts.pubName} ← ${args.sender_agent_id} (${args.rule})`,
      body: composeTaskBody({ ...args, pubName: this.opts.pubName }),
      idempotency: 'checkpointed',
      priority: 0,
    })
    await this.opts.taskStore.save(task)
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
}): string {
  return [
    `Synthetic task generated by pub wake source.`,
    ``,
    `Pub: ${args.pubName}`,
    `Sender: ${args.sender_display_name} (agent_id ${args.sender_agent_id})`,
    `Message id: ${args.message_id}`,
    `Rule fired: ${args.rule}`,
    `Detail: ${args.detail ?? '(none)'}`,
    ``,
    `Message that woke you (verbatim):`,
    ``,
    `> ${args.sender_content.split('\n').join('\n> ')}`,
    ``,
    `${args.sender_display_name} is addressing you. Default behaviour is to respond.`,
    ``,
    `Reply by calling \`pub.send\`. This is the ONLY way the sender will see`,
    `your reply... your final-answer text is not delivered to the pub. If you`,
    `skip \`pub.send\` you are silent.`,
    ``,
    `Example:`,
    ``,
    '```tool',
    `{ "tool": "pub.send", "args": { "pub_name": "${args.pubName}", "content": "<your reply text here>", "in_reply_to": "${args.message_id}" }, "predicted_outcome": "message delivered to pub", "reason": "responding to the sender" }`,
    '```',
    ``,
    `If you need additional context (prior messages in the thread, etc.) call`,
    `\`pub.read\` with just \`{ "limit": 20 }\`. Do NOT pass the message_id`,
    `above as \`since_message_id\`... that asks for messages AFTER the trigger`,
    `(usually empty) and creates a confusing loop.`,
    ``,
    `Only skip \`pub.send\` if the message is clearly not action-shaped`,
    `(e.g. spam, an off-topic broadcast you were copied on, or something`,
    `another Agent has already addressed). In that case mark the task done`,
    `with a brief outcome explaining why you stayed silent.`,
    ``,
    `IMPORTANT: do not acknowledge for the sake of acknowledging. If your`,
    `only contribution would be "received", "noted", "standing by",`,
    `"will do", a thank-you, or a restatement of what was just said,`,
    `stay silent. The sender knows the message landed; an ack is noise`,
    `that other Agents and the human in the room have to read past.`,
    `Reply only when you have substantive new information, a question`,
    `to ask, or a concrete next action you are taking right now.`,
  ].join('\n')
}
