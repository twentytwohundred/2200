/**
 * `directed_to` resolver: deterministic "is this message for me?" check.
 *
 * Per Epic 3 spec [[03-local-pub-integration]], a pub message is
 * `directed_to` an Agent if at least one of these rules matches.
 * Rules are evaluated in order; first match wins.
 *
 *   1. Direct mention. The message's `mentions[]` contains this Agent's
 *      `agent_id` (server-populated in v0.3.1) OR `@<handle>` appears
 *      in `content` (v0.3.0 fallback / additional safety).
 *   2. Reply to mine. The message's `reply_to` references a `message_id`
 *      this Agent sent (recorded in our local sent-messages cache).
 *   3. Sole-recipient pub. The pub has exactly two members and one of
 *      them is the sender; the other is this Agent.
 *   4. Pub ownership. The pub's `owner_id` matches this Agent's
 *      `agent_id`. Inactive at v1: pub-server v0.3.1 only supports
 *      human owner_ids on pubs. Re-activates when v0.3.2 extends
 *      `owner_id` to accept agent handles.
 *   5. Domain match. The Agent's Identity declares
 *      `pub.domains: ["weather arb", "vendor calls"]`; the
 *      message's `content` matches a domain rule (case-insensitive
 *      substring). Inherits from OpenPub v0.3.1's rule-based
 *      conversation flow per [[02-architecture]] line 351.
 *
 * Pure function: `(message_or_event, agent_pub_block, pub_meta, sent_message_ids) → { matched, rule, detail }`.
 * No LLM judgment in the resolver. The matched-rule field flows into
 * the run record on the synthetic `pub.handle` task for wake
 * attribution.
 */

/**
 * The bits of a pub message the resolver inspects. Shape matches the
 * `PubMessage` and `ConversationEvent` interfaces from `client.ts`,
 * with the union of fields the resolver actually reads.
 */
export interface ResolverMessage {
  message_id: string
  agent_id: string
  /** Message content (full Message has it; conversation_event has `preview`). */
  content?: string
  /** Server-populated mentions[] (v0.3.1+). May be empty in v0.3.0. */
  mentions?: string[]
  /** Server-populated reply_to (v0.3.1+). Always present (may be null). */
  reply_to?: string | null
}

export interface ResolverAgentIdentity {
  agent_id: string
  handle: string
  /** Optional domain match patterns from Identity's pub.domains[]. */
  domains?: string[]
}

export interface ResolverPubMeta {
  /** Members currently in the pub (agents_present from room_state). */
  member_agent_ids: string[]
  /** Owner of the pub. Inactive for rule 4 at v1 (always a human owner_id). */
  owner_id?: string | null
}

export type DirectedRule =
  | 'direct_mention'
  | 'reply_to_mine'
  | 'sole_recipient'
  | 'pub_ownership'
  | 'domain_match'

export interface DirectedToResult {
  matched: boolean
  rule: DirectedRule | null
  detail: string | null
}

const NOT_MATCHED: DirectedToResult = { matched: false, rule: null, detail: null }

/**
 * Evaluate the five directed_to rules in order. First match wins.
 *
 * `sentMessageIds` is the set of message_ids this Agent has sent
 * (used for rule 2 to detect replies-to-mine). The wake source
 * tracks these in a small bounded set per pub.
 */
export function isDirectedTo(args: {
  message: ResolverMessage
  agent: ResolverAgentIdentity
  pub: ResolverPubMeta
  sentMessageIds: ReadonlySet<string>
}): DirectedToResult {
  // Skip the Agent's own messages — those are not "for" the Agent.
  if (args.message.agent_id === args.agent.agent_id) {
    return NOT_MATCHED
  }

  // Rule 1: direct mention.
  const r1 = ruleDirectMention(args.message, args.agent)
  if (r1.matched) return r1

  // Rule 2: reply to mine.
  const r2 = ruleReplyToMine(args.message, args.sentMessageIds)
  if (r2.matched) return r2

  // Rule 3: sole-recipient pub.
  const r3 = ruleSoleRecipient(args.message, args.agent, args.pub)
  if (r3.matched) return r3

  // Rule 4: pub ownership. Inactive at v1.
  const r4 = rulePubOwnership(args.agent, args.pub)
  if (r4.matched) return r4

  // Rule 5: domain match.
  const r5 = ruleDomainMatch(args.message, args.agent)
  if (r5.matched) return r5

  return NOT_MATCHED
}

// ---------------------------------------------------------------------------
// Rule implementations (each pure)
// ---------------------------------------------------------------------------

function ruleDirectMention(m: ResolverMessage, a: ResolverAgentIdentity): DirectedToResult {
  // Server-populated mentions wins when present.
  if (m.mentions?.includes(a.agent_id)) {
    return { matched: true, rule: 'direct_mention', detail: 'mentions[] contains agent_id' }
  }
  // Broadcast: a message containing @all (or @everyone / @team) wakes EVERY
  // Agent in the pub ... the explicit "call to action for everyone" signal:
  // fleet-wide questions, morning briefings, new-Agent intros. Case-
  // insensitive; word-boundary guards so @allow / @teammate / @everyone-else
  // do not trigger. The sender's own message is already filtered at the top of
  // isDirectedTo, so saying @all in your own message does not wake yourself.
  if (m.content && /(?:^|[^\w-])@(?:all|everyone|team)(?:[^\w-]|$)/i.test(m.content)) {
    return { matched: true, rule: 'direct_mention', detail: '@all broadcast' }
  }
  // Fallback: @<handle> in content (v0.3.0; also a safety net for v0.3.1
  // edge cases where the in-band parse missed the agent).
  if (m.content && a.handle) {
    // Strip any leading '@' from the configured handle so we match either form.
    const handle = a.handle.startsWith('@') ? a.handle.slice(1) : a.handle
    // Match @<handle> with a word boundary or end-of-string after.
    const re = new RegExp(`(?:^|[^\\w-])@${escapeRegex(handle)}(?:[^\\w-]|$)`, 'i')
    if (re.test(m.content)) {
      return {
        matched: true,
        rule: 'direct_mention',
        detail: `@${handle} in content`,
      }
    }
  }
  return NOT_MATCHED
}

function ruleReplyToMine(
  m: ResolverMessage,
  sentMessageIds: ReadonlySet<string>,
): DirectedToResult {
  if (m.reply_to && sentMessageIds.has(m.reply_to)) {
    return {
      matched: true,
      rule: 'reply_to_mine',
      detail: `reply_to references our message ${m.reply_to}`,
    }
  }
  return NOT_MATCHED
}

function ruleSoleRecipient(
  m: ResolverMessage,
  a: ResolverAgentIdentity,
  pub: ResolverPubMeta,
): DirectedToResult {
  if (pub.member_agent_ids.length !== 2) return NOT_MATCHED
  if (!pub.member_agent_ids.includes(a.agent_id)) return NOT_MATCHED
  if (!pub.member_agent_ids.includes(m.agent_id)) return NOT_MATCHED
  // Both members are sender + recipient (this Agent), and pub size is 2.
  return {
    matched: true,
    rule: 'sole_recipient',
    detail: 'pub has exactly two members; sender and self',
  }
}

function rulePubOwnership(a: ResolverAgentIdentity, pub: ResolverPubMeta): DirectedToResult {
  if (!pub.owner_id) return NOT_MATCHED
  if (pub.owner_id !== a.agent_id) return NOT_MATCHED
  return {
    matched: true,
    rule: 'pub_ownership',
    detail: `pub owner_id matches agent_id (${a.agent_id})`,
  }
}

function ruleDomainMatch(m: ResolverMessage, a: ResolverAgentIdentity): DirectedToResult {
  if (!a.domains || a.domains.length === 0) return NOT_MATCHED
  if (!m.content) return NOT_MATCHED
  const haystack = m.content.toLowerCase()
  for (const domain of a.domains) {
    const needle = domain.toLowerCase()
    if (needle && haystack.includes(needle)) {
      return {
        matched: true,
        rule: 'domain_match',
        detail: `content matched domain "${domain}"`,
      }
    }
  }
  return NOT_MATCHED
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
