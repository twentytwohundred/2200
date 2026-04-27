/**
 * Pub message router (Epic 3.6).
 *
 * Given an incoming pub message and the current Agent roster, asks a
 * cheap LLM to decide which Agent(s) (if any) should be woken to
 * respond. Returns a list of agent_ids. Empty array means "no one
 * should respond... let it scroll past."
 *
 * This is the substrate for ambient routing in open chat rooms (the
 * UX where you don't have to @-tag everyone). The wake source still
 * runs the deterministic rules first (direct_mention, reply_to_mine,
 * etc.) for cases that don't need an LLM. Only when those rules don't
 * match does the router get consulted.
 *
 * Cache
 * -----
 * Routing is cached by `message_id` so duplicate broadcasts (e.g. the
 * same message arriving via both `room_state` and `conversation_event`)
 * don't double-bill. The cache is bounded LRU; older entries evict.
 *
 * Cost shape
 * ----------
 * One LLM call per pub message regardless of agent count, vs. running
 * the full Agent loop per Agent per message. At Haiku/DeepSeek-fast
 * rates, a routing call is fractions of a cent... a per-Agent loop on
 * a frontier model is dollars-of-cents. Router is a hard win for any
 * pub with > 1 Agent.
 */
import { LlmError } from '../llm/errors.js'
import type { LLMProvider } from '../llm/provider.js'
import { createLogger, type Logger } from '../util/logger.js'

/** Agent participating in the routing decision. */
export interface RouterAgent {
  agent_id: string
  display_name: string
  /**
   * One-line role description from the Agent's Identity. Used by the
   * router to decide which Agent(s) the message is for. Keep short...
   * the router is a cheap-tier LLM and long blurbs blow the prompt.
   */
  role_blurb: string
}

export interface RouterInput {
  /** Stable id for cache lookup; must be the pub-server's message_id. */
  message_id: string
  /** Display name of whoever sent the message (user or another Agent). */
  sender_display_name: string
  /** The message content the router is classifying. */
  content: string
  /** All Agents the router can choose to wake. */
  agents: RouterAgent[]
}

export interface RouterDecision {
  /** Agent ids that should wake. Empty array = no one responds. */
  woken_agent_ids: string[]
  /** Optional brief rationale, for debugging records. May be absent. */
  rationale?: string
  /** True if the decision came from cache; useful for cost telemetry. */
  cached: boolean
}

export interface RouterOptions {
  /** Provider used for the routing call (typically a cheap-tier model). */
  provider: LLMProvider
  /** Model id passed through to the provider. */
  modelId: string
  /** Cache; defaults to a 256-entry in-memory LRU. */
  cache?: RouterCache
  /** Inject for tests. */
  logger?: Logger
  /** Inject for tests; defaults to Date.now. */
  now?: () => number
}

const DEFAULT_CACHE_SIZE = 256

/** Bounded LRU keyed by message_id → RouterDecision. */
export class RouterCache {
  private readonly capacity: number
  private readonly entries = new Map<string, RouterDecision>()

  constructor(capacity = DEFAULT_CACHE_SIZE) {
    this.capacity = capacity
  }

  get(messageId: string): RouterDecision | undefined {
    const hit = this.entries.get(messageId)
    if (!hit) return undefined
    // LRU bump: re-insert so it's the most recent.
    this.entries.delete(messageId)
    this.entries.set(messageId, hit)
    return hit
  }

  set(messageId: string, decision: RouterDecision): void {
    if (this.entries.has(messageId)) this.entries.delete(messageId)
    this.entries.set(messageId, decision)
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }
}

const ROUTER_SYSTEM_PROMPT = [
  `You are a routing classifier for a multi-agent chat room.`,
  `A message just arrived. Decide which Agents should respond.`,
  ``,
  `Default towards waking somebody. The human is in the room talking to`,
  `the team... silence is the wrong answer for almost any message that`,
  `looks like a question, request, greeting to the room, or check-in.`,
  ``,
  `Decision tree:`,
  `1. Message names a specific Agent → wake that Agent only.`,
  `2. Message clearly falls inside one Agent's stated role → wake that`,
  `   Agent only (e.g. a deploy question for the DevOps Agent).`,
  `3. Message clearly requires multiple lanes at once (e.g. "plan a`,
  `   deploy together") → wake all relevant Agents.`,
  `4. Message addresses the room (e.g. "hey everyone", "gang",`,
  `   "status update", "anyone?", or a generic question) → wake at`,
  `   least one Agent. Pick the best fit; if no lane matches, pick`,
  `   any one Agent so the human gets a reply.`,
  `5. Message is broadcast noise the human did not direct at the team`,
  `   at all (e.g. an Agent's own routine output, a system message,`,
  `   an overheard side-thread someone else is already handling) →`,
  `   wake nobody.`,
  ``,
  `When in doubt, wake one Agent rather than zero. The cost of an`,
  `unnecessary reply is small; the cost of leaving a question hanging`,
  `is high.`,
  ``,
  `Respond with a single JSON object on one line, no surrounding prose:`,
  `{"woken_agent_ids": ["<agent_id>", "..."], "rationale": "<one short sentence>"}`,
  ``,
  `If you are confident nobody should respond, return`,
  `{"woken_agent_ids": [], "rationale": "..."}.`,
].join('\n')

export class Router {
  private readonly opts: RouterOptions
  private readonly log: Logger
  private readonly cache: RouterCache
  private readonly nowFn: () => number

  constructor(opts: RouterOptions) {
    this.opts = opts
    this.log = opts.logger ?? createLogger('pub/router')
    this.cache = opts.cache ?? new RouterCache()
    this.nowFn = opts.now ?? Date.now
  }

  /**
   * Route a single message. Returns the set of agent_ids that should
   * wake. On any failure (LLM error, malformed JSON, schema mismatch)
   * returns an empty decision rather than throwing... a router failure
   * should never block the pub or wake everyone, it should fall back to
   * silence and let the caller decide whether to use deterministic
   * rules instead.
   */
  async route(input: RouterInput): Promise<RouterDecision> {
    const cached = this.cache.get(input.message_id)
    if (cached) return { ...cached, cached: true }

    if (input.agents.length === 0) {
      // Nothing to wake. Don't burn an LLM call.
      const empty: RouterDecision = { woken_agent_ids: [], cached: false }
      this.cache.set(input.message_id, empty)
      return empty
    }

    const userPrompt = this.composeUserPrompt(input)
    const tStart = this.nowFn()
    let text: string
    try {
      const response = await this.opts.provider.complete({
        modelId: this.opts.modelId,
        systemPrompt: ROUTER_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      })
      text = response.text
    } catch (err) {
      this.log.warn('router LLM call failed; defaulting to no-op decision', {
        message_id: input.message_id,
        error: err instanceof Error ? err.message : String(err),
        ...(err instanceof LlmError ? { code: err.code, provider: err.providerName } : {}),
      })
      const fail: RouterDecision = { woken_agent_ids: [], cached: false }
      this.cache.set(input.message_id, fail)
      return fail
    }

    const decision = this.parseDecision(text, input)
    this.log.info('router decision', {
      message_id: input.message_id,
      woken: decision.woken_agent_ids.length,
      duration_ms: this.nowFn() - tStart,
      ...(decision.rationale ? { rationale: decision.rationale } : {}),
    })
    this.cache.set(input.message_id, decision)
    return decision
  }

  private composeUserPrompt(input: RouterInput): string {
    const roster = input.agents
      .map((a) => `- ${a.display_name} (id ${a.agent_id}): ${a.role_blurb}`)
      .join('\n')
    return [
      `Sender: ${input.sender_display_name}`,
      `Message: ${input.content}`,
      ``,
      `Agents in the room:`,
      roster,
    ].join('\n')
  }

  /**
   * Permissive parser: extracts the first JSON object from the model's
   * response. Models occasionally wrap the JSON in prose or fenced
   * blocks despite the system prompt; we tolerate that. Schema-invalid
   * output collapses to an empty decision rather than throwing.
   */
  private parseDecision(text: string, input: RouterInput): RouterDecision {
    const json = extractFirstJsonObject(text)
    if (!json) {
      this.log.warn('router output had no JSON object; defaulting to empty', {
        message_id: input.message_id,
        text_preview: text.slice(0, 200),
      })
      return { woken_agent_ids: [], cached: false }
    }
    if (!isObject(json)) {
      return { woken_agent_ids: [], cached: false }
    }
    const ids = json['woken_agent_ids']
    if (!Array.isArray(ids)) {
      return { woken_agent_ids: [], cached: false }
    }
    const validIds = new Set(input.agents.map((a) => a.agent_id))
    const woken: string[] = []
    for (const id of ids) {
      if (typeof id === 'string' && validIds.has(id) && !woken.includes(id)) {
        woken.push(id)
      }
    }
    const rationale = typeof json['rationale'] === 'string' ? json['rationale'] : undefined
    return rationale !== undefined
      ? { woken_agent_ids: woken, rationale, cached: false }
      : { woken_agent_ids: woken, cached: false }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Find the first balanced `{...}` substring in `text` and JSON.parse
 * it. Returns null if no parseable object is found. Tolerates prose
 * before/after and ```json fences.
 */
function extractFirstJsonObject(text: string): unknown {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\') {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        const slice = text.slice(start, i + 1)
        try {
          return JSON.parse(slice)
        } catch {
          return null
        }
      }
    }
  }
  return null
}
