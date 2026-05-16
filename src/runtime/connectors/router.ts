/**
 * Connector inbound routing.
 *
 * Given an inbound event and a list of Identities, returns the Agents
 * that should wake. Each Agent's binding has its own allowlist + policy;
 * the router applies them per-Agent independently. The platform-side
 * gateway is connector-agnostic; this module is the policy layer.
 *
 * Pairing-policy semantics are handled by the supervisor's caller ...
 * the router just returns whether a DM passes / pairs / is blocked. The
 * supervisor decides whether to notify the operator for pairing approval
 * (deferred to a follow-on; for v1 the operator pre-allowlists).
 *
 * Decision: 2026-05-16-connector-extensions.
 */
import type { AgentConnectorBinding, IdentityFrontmatter } from '../identity/types.js'
import type { ConnectorInboundEvent } from './inbound-types.js'

export type RouteDecision =
  | { kind: 'pass'; agent: string; binding: AgentConnectorBinding }
  | {
      kind: 'pair'
      agent: string
      binding: AgentConnectorBinding
      reason: 'unknown_dm_sender'
    }
  | {
      kind: 'block'
      agent: string
      binding: AgentConnectorBinding
      reason:
        | 'no_binding'
        | 'account_mismatch'
        | 'dm_policy_disabled'
        | 'dm_sender_not_allowlisted'
        | 'group_policy_disabled'
        | 'group_not_allowlisted'
        | 'mention_required'
    }

export interface RouteArgs {
  event: ConnectorInboundEvent
  /** Agent name + frontmatter pairs the supervisor knows about. */
  identities: { agent: string; frontmatter: IdentityFrontmatter }[]
  /**
   * Optional mention detector for group messages. Receives the
   * binding's agent name + the event text; returns true if the
   * message mentions the bot. v1: simple `@<agent>` substring; the
   * caller can pass platform-specific helpers later.
   */
  mentionDetector?: (agent: string, text: string | undefined) => boolean
}

const defaultMentionDetector = (agent: string, text: string | undefined): boolean => {
  if (!text) return false
  return text.toLowerCase().includes(`@${agent.toLowerCase()}`)
}

/**
 * Resolve all routing decisions for an inbound event. Returns one
 * decision per Agent whose Identity has a binding for the connector
 * (including blocks, so the supervisor can log + observe). Agents
 * with no binding to the connector are not in the result.
 */
export function routeInbound(args: RouteArgs): RouteDecision[] {
  const { event, identities, mentionDetector = defaultMentionDetector } = args
  const decisions: RouteDecision[] = []
  // Self-echo events never wake the agent (the agent is the sender).
  if (event.sender.is_self) return decisions
  for (const { agent, frontmatter } of identities) {
    const binding = frontmatter.connectors.find((b) => b.connector_id === event.connector_id)
    if (!binding) continue
    if (binding.account !== event.account) {
      decisions.push({ kind: 'block', agent, binding, reason: 'account_mismatch' })
      continue
    }
    const decision = evaluateBinding(agent, binding, event, mentionDetector)
    decisions.push(decision)
  }
  return decisions
}

function evaluateBinding(
  agent: string,
  binding: AgentConnectorBinding,
  event: ConnectorInboundEvent,
  mentionDetector: NonNullable<RouteArgs['mentionDetector']>,
): RouteDecision {
  if (event.conversation.kind === 'dm') {
    const policy = binding.policies.dm_policy
    if (policy === 'disabled') {
      return { kind: 'block', agent, binding, reason: 'dm_policy_disabled' }
    }
    if (policy === 'open') return { kind: 'pass', agent, binding }
    // allowlist + pairing both require the sender to be on the list
    // before passing; pairing diverges only when missing.
    const allowed =
      binding.allowlist.dm.includes('*') || binding.allowlist.dm.includes(event.sender.id)
    if (allowed) return { kind: 'pass', agent, binding }
    if (policy === 'pairing') {
      return { kind: 'pair', agent, binding, reason: 'unknown_dm_sender' }
    }
    return { kind: 'block', agent, binding, reason: 'dm_sender_not_allowlisted' }
  }
  // group
  const groupPolicy = binding.policies.group_policy
  if (groupPolicy === 'disabled') {
    return { kind: 'block', agent, binding, reason: 'group_policy_disabled' }
  }
  const groupOk =
    groupPolicy === 'open' ||
    binding.allowlist.group.includes('*') ||
    binding.allowlist.group.includes(event.conversation.id)
  if (!groupOk) {
    return { kind: 'block', agent, binding, reason: 'group_not_allowlisted' }
  }
  if (binding.policies.require_mention) {
    if (!mentionDetector(agent, event.text)) {
      return { kind: 'block', agent, binding, reason: 'mention_required' }
    }
  }
  return { kind: 'pass', agent, binding }
}
