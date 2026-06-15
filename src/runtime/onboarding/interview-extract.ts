/**
 * LLM-driven extraction of operational setup from a completed onboarding
 * interview ... the part the curated schedule/tool tables miss.
 *
 * The curated suggestSchedules/suggestTools only fire for the scripted
 * archetypes (email/project/ops); the `llm_driven` interview path produces
 * a rich transcript but none of those canonical intent_tags, so a clearly
 * stated cadence ("6:30am EDT daily") and named integrations (Spotify,
 * Instagram, ...) yielded nothing. This pass reads the actual interview and
 * extracts:
 *   - schedules: stated cadences parsed into a real cron + IANA tz
 *   - integrations: external services the Agent needs (the caller logs
 *     these as catalog gaps so the demand is recorded, not dropped)
 *
 * Best-effort: a malformed model response yields empty arrays, never an
 * error ... the operator still reaches a preview.
 */
import { CronExpressionParser } from 'cron-parser'
import type { LLMProvider } from '../llm/provider.js'
import type { CompletionRequest } from '../llm/types.js'
import type { ScheduleSuggestion } from './schedule-suggestions.js'

export interface NeededIntegration {
  /** External service / platform the Agent needs (e.g. "Spotify"). */
  name: string
  /** What the Agent uses it for (e.g. "create/update the daily playlist"). */
  purpose: string
}

export interface ExtractedSetup {
  schedules: ScheduleSuggestion[]
  integrations: NeededIntegration[]
}

const SYSTEM_PROMPT = `You read a COMPLETED onboarding interview for a new AI Agent and extract its operational setup as JSON. Output ONLY a JSON object ... no prose, no code fences:

{"schedules": [{"cron": "...", "tz": "...", "task": "...", "rationale": "..."}], "integrations": [{"name": "...", "purpose": "..."}]}

schedules: every time-based cadence the Agent should run on, parsed from what the interview ACTUALLY says. cron is a 5-field cron expression; tz is an IANA timezone. Parse stated times and zones literally:
  "6:30am EDT daily"      -> {"cron":"30 6 * * *","tz":"America/New_York"}
  "every weekday at 9am"  -> {"cron":"0 9 * * 1-5","tz":"UTC"}
  "every 5 minutes"       -> {"cron":"*/5 * * * *","tz":"UTC"}
Use America/New_York for ET/EDT/EST, America/Los_Angeles for PT, UTC when no zone is stated. Only include cadences the interview implies; use [] if none.

integrations: EXTERNAL services or platforms the Agent needs that are not core LLM or file capabilities ... e.g. Spotify, Instagram, X (Twitter), Threads, Slack, a named API or model service. name is the service; purpose is what the Agent does with it. Use [] if none. Be faithful to the interview; never invent a service that was not mentioned.`

export async function extractScheduleAndIntegrations(args: {
  provider: LLMProvider
  modelId: string
  transcript: string
  summary: string
}): Promise<ExtractedSetup> {
  const request: CompletionRequest = {
    modelId: args.modelId,
    systemPrompt: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `SUMMARY:\n${args.summary}\n\nINTERVIEW TRANSCRIPT:\n${args.transcript}\n\nExtract the JSON now.`,
      },
    ],
    temperature: 0.2,
    maxTokens: 700,
  }
  let raw: string
  try {
    raw = (await args.provider.complete(request)).text
  } catch {
    return { schedules: [], integrations: [] }
  }
  return parseExtraction(raw)
}

/** Parse + validate the model's extraction JSON. Pure + exported for tests. */
export function parseExtraction(raw: string): ExtractedSetup {
  const obj = tolerantJsonObject(raw)
  if (!obj) return { schedules: [], integrations: [] }

  const schedules: ScheduleSuggestion[] = []
  let i = 0
  for (const s of Array.isArray(obj['schedules']) ? obj['schedules'] : []) {
    if (typeof s !== 'object' || s === null) continue
    const rec = s as Record<string, unknown>
    const cron = typeof rec['cron'] === 'string' ? rec['cron'].trim() : ''
    const tz = typeof rec['tz'] === 'string' && rec['tz'].trim() !== '' ? rec['tz'].trim() : 'UTC'
    const task = typeof rec['task'] === 'string' ? rec['task'].trim() : ''
    const rationale = typeof rec['rationale'] === 'string' ? rec['rationale'].trim() : ''
    if (!isValidCron(cron, tz) || task === '') continue
    schedules.push({
      id: `llm_sched_${String(++i)}`,
      cron,
      tz,
      task,
      rationale: rationale === '' ? 'parsed from your interview' : rationale,
      source_tag: 'llm_extracted',
    })
  }

  const integrations: NeededIntegration[] = []
  const seen = new Set<string>()
  for (const it of Array.isArray(obj['integrations']) ? obj['integrations'] : []) {
    if (typeof it !== 'object' || it === null) continue
    const rec = it as Record<string, unknown>
    const name = typeof rec['name'] === 'string' ? rec['name'].trim() : ''
    const purpose = typeof rec['purpose'] === 'string' ? rec['purpose'].trim() : ''
    if (name === '') continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    integrations.push({ name, purpose })
  }

  return { schedules, integrations }
}

function isValidCron(cron: string, tz: string): boolean {
  if (cron.split(/\s+/).filter(Boolean).length !== 5) return false
  try {
    CronExpressionParser.parse(cron, { tz })
    return true
  } catch {
    return false
  }
}

/**
 * Extract the first top-level JSON object from a model response, tolerating
 * code fences / surrounding prose.
 */
function tolerantJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
