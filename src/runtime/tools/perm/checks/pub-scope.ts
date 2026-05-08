/**
 * `pub_scope` perm check (Epic 3 PR C).
 *
 * Fires only on pub.* tools. Validates four sub-checks:
 *
 *   1. **pub_membership**: the calling Agent is a member of the
 *      target pub. v1 active path: the pub is running on the
 *      instance and the Agent's pub identity has been provisioned.
 *      Per-Agent membership filtering by `pub.member_of` is a
 *      placeholder until the multi-pub UX lands; v1 install ships
 *      with one pub and every Agent is in it.
 *   2. **mention_scope**: the Agent is allowed to mention the
 *      handles in the args. v1: stub returning pass for any same-pub
 *      handles. Per-Agent override (e.g., evangelist Agents barred
 *      from mentioning the user without escalation) lands when the
 *      notification tier system in Epic 7 lights up.
 *   3. **dm_initiation**: sending the first message in a sole-recipient
 *      pub requires explicit permission. v1: stub returning pass
 *      between same-instance Agents. Cross-instance DM (Epic 4
 *      territory) lands later.
 *   4. **tier_policy**: quiet-hours / notification-tier rules. Stubbed
 *      as not_applicable until Epic 7 wires the policy.
 *
 * Per the spec, the check writes a single `pub_scope` outcome with
 * the sub-check breakdown in `detail`. Denials reference the failing
 * sub-check explicitly so callers can act on the specific failure.
 */
import type { CheckImpl } from '../types.js'

export const pubScope: CheckImpl = (ctx) => {
  if (!ctx.tool.name.startsWith('pub_')) {
    return { type: 'pub_scope', result: 'not_applicable', detail: null }
  }

  const subChecks = [
    pubMembership(ctx.tool.name),
    mentionScope(ctx.tool.name),
    dmInitiation(ctx.tool.name),
    tierPolicy(),
  ]

  const first = subChecks.find((s) => s.result === 'fail')
  if (first) {
    return {
      type: 'pub_scope',
      result: 'fail',
      detail: `${first.sub_check}: ${first.detail ?? 'check failed'}`,
    }
  }

  // Pass when all sub-checks are pass-or-not_applicable. Surface the
  // breakdown in `detail` so the perm record carries the picture.
  const summary = subChecks.map((s) => `${s.sub_check}=${s.result}`).join(', ')
  return { type: 'pub_scope', result: 'pass', detail: summary }
}

interface SubCheck {
  sub_check: string
  result: 'pass' | 'fail' | 'not_applicable'
  detail: string | null
}

/**
 * v1 path: the supervisor's runtime knows which pubs exist and the
 * Agent has gone through `2200 agent create` (so its pub identity
 * exists if it was meant to be pub-aware). The pub tool itself
 * resolves the pub_name to a PubRecord and throws on miss; that
 * surface error path covers most of what pub_membership would catch
 * at v1. The check is a placeholder for the per-Agent member_of
 * filtering that lands when multi-pub UX is real.
 */
function pubMembership(_toolName: string): SubCheck {
  return {
    sub_check: 'pub_membership',
    result: 'not_applicable',
    detail:
      'v1: tool resolves pub_name → PubRecord and errors on miss; per-Agent member_of filter is a placeholder',
  }
}

function mentionScope(_toolName: string): SubCheck {
  return {
    sub_check: 'mention_scope',
    result: 'not_applicable',
    detail: 'v1: any same-pub handle is mentionable; per-Agent override lands with Epic 7',
  }
}

function dmInitiation(_toolName: string): SubCheck {
  return {
    sub_check: 'dm_initiation',
    result: 'not_applicable',
    detail: 'v1: sole-recipient pub initiation between same-instance Agents passes by default',
  }
}

function tierPolicy(): SubCheck {
  return {
    sub_check: 'tier_policy',
    result: 'not_applicable',
    detail: 'tier policy not yet wired (Epic 7)',
  }
}
