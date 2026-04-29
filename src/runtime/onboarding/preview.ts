/**
 * Preview surface for conversational onboarding (Epic 14 Phase A PR D).
 *
 * Pure function that takes the proposed Identity (HandoffDocument
 * shape, output of PR C's buildHandoffFromTranscript), the suggested
 * tools, and the suggested schedules, and produces a human-readable
 * string for the CLI to print before the user confirms creation.
 *
 * Pure so tests snapshot the output. The CLI just calls
 * `console.log(renderPreview(...))` and asks for confirmation.
 */
import type { HandoffDocument } from '../migration/types.js'
import type { ScheduleSuggestion } from './schedule-suggestions.js'
import type { ToolSuggestion } from './tool-suggestions.js'

export interface PreviewArgs {
  handoff: HandoffDocument
  tools: readonly ToolSuggestion[]
  schedules: readonly ScheduleSuggestion[]
}

/**
 * Render a multi-line preview string. Format:
 *
 *   Proposed Agent: <name>
 *     Type:          <agent_type>
 *     Display name:  <display_name>
 *     Notification:  <tiers>
 *     Cost cap:      $<n>/day
 *     Tools:
 *       - <server.name> (<env_hint>)
 *         <rationale>
 *     Schedules:
 *       - <id>: <cron> (<tz>)
 *         <rationale>
 *     Brain:         continuity-from-onboarding (will seed on start)
 *
 *   Confirm? [y/N]
 *
 * The CLI appends the actual prompt; this function just builds the
 * body.
 */
export function renderPreview(args: PreviewArgs): string {
  const fm = args.handoff.frontmatter
  const lines: string[] = []
  lines.push(`Proposed Agent: ${fm.agent_name}`)
  lines.push(`  Type:          ${fm.agent_type}`)
  lines.push(`  Display name:  ${fm.identity.display_name}`)
  lines.push(`  Notification:  ${fm.identity.notification_policy.tiers_allowed.join(', ')}`)
  lines.push(`  Cost cap:      $${String(fm.budget.daily_cap_usd)}/day`)

  if (args.tools.length === 0) {
    lines.push('  Tools:         (none suggested; baseline tools only)')
  } else {
    lines.push('  Tools:')
    for (const tool of args.tools) {
      lines.push(`    - ${tool.server.name} (${tool.env_hint})`)
      lines.push(`      ${tool.rationale}`)
    }
  }

  if (args.schedules.length === 0) {
    lines.push('  Schedules:     (none suggested; add later via "2200 schedule add")')
  } else {
    lines.push('  Schedules:')
    for (const sched of args.schedules) {
      lines.push(`    - ${sched.id}: cron "${sched.cron}" (${sched.tz})`)
      lines.push(`      task: ${sched.task}`)
      lines.push(`      ${sched.rationale}`)
    }
  }

  lines.push('  Brain:         continuity-from-onboarding (seeds on first run)')

  return lines.join('\n')
}
