/**
 * Schedule suggestions for onboarding (Epic 14 Phase A PR C).
 *
 * Per the locked Phase A decision: a curated list of cadence intent_tag
 * → schedule defaults. The user's free-form cadence answer (e.g.,
 * "every weekday at 8am") is shown in the preview alongside the
 * suggested schedule for transparency, but v1 does NOT LLM-parse the
 * free-form text into a cron expression. The operator confirms the
 * default or edits via `2200 schedule add` post-spawn.
 *
 * v1 mappings:
 *
 *   - cadence_email → daily 08:00 UTC, "morning email triage"
 *   - cadence_project → no default (project Agents are typically
 *     event-driven; scheduled work is per-operator)
 *   - cadence_ops → every 5 minutes, "ops poll"
 *   - cadence_freeform → no default
 *
 * Each suggestion is shown to the user in the preview; the user can
 * accept or drop. Phase B can add LLM-augmented free-form parsing
 * (likely on a per-tag opt-in basis since the current curated table
 * is more predictable for the launch window).
 */
import type { InterviewTranscript } from './types.js'

/**
 * One suggested schedule. The preview surface renders these; the
 * orchestrator (PR D) writes the accepted ones via the existing
 * ScheduleStore from Epic 6.
 */
export interface ScheduleSuggestion {
  /** Stable id; ScheduleStore generates one if omitted at write time. */
  id: string
  /**
   * Cron expression (5 fields) ... see Epic 6 spec. Phase A only emits
   * cron form (interval form is uncommon for the curated mappings).
   */
  cron: string
  /** Timezone for the cron expression. UTC unless the script overrides. */
  tz: string
  /** Task body to enqueue on fire. */
  task: string
  /** Free-form rationale; preview shows "Suggested because: <rationale>". */
  rationale: string
  /** Source intent_tag from the transcript that triggered this. */
  source_tag: string
}

/**
 * Suggest schedules based on the transcript's intent_tags. Returns an
 * array (possibly empty) of ScheduleSuggestion. The user's cadence
 * answer is included in the rationale so the preview surfaces "you
 * said 'every weekday morning'; the system suggests daily 08:00 UTC."
 */
export function suggestSchedules(transcript: InterviewTranscript): ScheduleSuggestion[] {
  const out: ScheduleSuggestion[] = []
  const seen = new Set<string>()

  for (const entry of transcript.entries) {
    const tag = entry.intent_tag
    if (tag === undefined) continue

    const builder = SCHEDULE_BUILDERS[tag]
    if (builder === undefined) continue

    const suggestion = builder({ answer: entry.answer, tag })
    if (suggestion === null) continue
    if (seen.has(suggestion.id)) continue
    seen.add(suggestion.id)
    out.push(suggestion)
  }

  return out
}

interface BuilderArgs {
  answer: string
  tag: string
}

type ScheduleBuilder = (args: BuilderArgs) => ScheduleSuggestion | null

const SCHEDULE_BUILDERS: Record<string, ScheduleBuilder> = {
  cadence_email: (a) => ({
    id: 'morning_email_triage',
    cron: '0 8 * * *',
    tz: 'UTC',
    task: 'morning email triage: read new threads, summarize, draft replies for high-priority items',
    rationale: `you described cadence as "${truncate(a.answer, 60)}" — defaulting to daily 08:00 UTC`,
    source_tag: a.tag,
  }),
  cadence_ops: (a) => ({
    id: 'ops_poll',
    cron: '*/5 * * * *',
    tz: 'UTC',
    task: 'ops poll: check dashboards / alerts / metrics, surface anything new',
    rationale: `you described cadence as "${truncate(a.answer, 60)}" — defaulting to every 5 minutes`,
    source_tag: a.tag,
  }),
  // cadence_project + cadence_freeform: no default schedule. Project
  // Agents are typically event-driven; freeform Agents are too varied
  // for a single curated default. Operators add schedules post-spawn
  // via `2200 schedule add` if they want them.
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}
