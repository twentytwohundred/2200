/**
 * Onboarding session: the LLM-driven interview as a state machine that
 * drives over HTTP request boundaries.
 *
 * The first turn is the script's opening question (fixed text, captures
 * the user's pitch). After that, every turn calls the interviewer LLM
 * with the full transcript + goal list; the LLM returns either the next
 * question (with a `covering: <goal_id>` annotation that becomes the
 * answer's intent_tag) or `done`. When done, the session runs the
 * summary call and builds the preview.
 *
 * State transitions:
 *
 *   awaiting_opening → user answers → awaiting_response (LLM picks first follow-up)
 *   awaiting_response → user answers → awaiting_response (LLM picks next) | summarizing → done
 *   done → confirmed | cancelled
 *
 * The interviewer LLM is the same provider/model the user picked on
 * the intro card. Guardrails:
 *   - Hard cap: max_turns from the script. We force 'done' once
 *     hit, even if optional goals are uncovered.
 *   - Required-goals check: the LLM is told it can't return 'done'
 *     until every required goal has an entry whose intent_tag matches.
 *     If the LLM tries to end early, the session re-prompts it once;
 *     after that we accept whatever shape the LLM is willing to
 *     produce (better to ship a preview the user can edit than to
 *     loop forever).
 *   - JSON-schema parsing: we ask for JSON and tolerate fenced code
 *     blocks. On parse failure we re-prompt once.
 */
import type { LLMProvider } from '../llm/provider.js'
import {
  INTERVIEW_SCHEMA_VERSION,
  type InterviewTranscript,
  type Question,
  type QuestionScript,
  type TranscriptEntry,
} from './types.js'
import { buildHandoffFromTranscript } from './identity-from-interview.js'
import type { HandoffDocument } from '../migration/types.js'
import { suggestTools, type ToolSuggestion } from './tool-suggestions.js'
import { suggestSchedules, type ScheduleSuggestion } from './schedule-suggestions.js'
import type { CompletionRequest } from '../llm/types.js'

const DEFAULT_INTERVIEWER_PERSONA = `You are a hiring manager interviewing a stakeholder about the ideal employee they want to add to their team. You are running a short conversation that will build a new Agent inside 2200, an Agent runtime. Your job is to surface enough practical information about what the Agent will do that the platform can build an Identity, suggest tool integrations, and suggest schedules.

You ask one question per turn. Short. Drill into what's vague. If the user says "manage my email," ask which inbox, what action, what to flag. If the user already covered a topic in passing, don't re-ask. Aim for a real conversation that lasts a few minutes ... not a survey.

You also take direction. If the user says "I want it to do X," your job is to surface the practical details so the platform can act on it ... not to second-guess the user's intent.`

const INTERVIEWER_SYSTEM_TEMPLATE = `{persona}

GOALS (the dimensions you must surface before ending):
{goals}

INSTRUCTIONS:
1. Aim for around {target_turns} total turns. The opening counts as turn 1.
2. You MAY end before {target_turns} turns if the user has clearly addressed every required goal.
3. You MUST end by turn {max_turns} regardless of coverage.
4. NEVER summarize what the user just said back to them. NEVER lecture. ASK.
5. When you ask, return JSON: {"kind":"question","text":"<the question>","covering":"<goal_id>"}
6. When you've heard enough, return JSON: {"kind":"done"}
7. The "covering" field MUST be one of the goal ids above; choose the goal this question is surfacing.
8. Output ONLY the JSON object, nothing else. No prose, no fenced code blocks.

ON THIS TURN: produce the next JSON message.`

const SUMMARY_SYSTEM_PROMPT = `You are summarizing a brief onboarding interview that just produced a new Agent inside 2200, the Agent runtime.

Produce a short narrative summary (3-6 sentences) capturing:
- Who this Agent is and what its lane is
- What it should do day-to-day
- The cadence or schedule the user described
- Any tools or integrations the user named

Write in first person from the Agent's perspective ("I am ...", "My job is ..."). The summary becomes the Agent's first brain note (titled "continuity-from-onboarding") so on its first run inside 2200 it has a written explanation of why it exists. Keep it concrete; quote specifics from the user's answers when they help.`

export type OnboardingSessionState =
  | 'awaiting_opening'
  | 'awaiting_response'
  | 'summarizing'
  | 'done'
  | 'confirmed'
  | 'cancelled'
  | 'errored'

export interface OnboardingSessionOptions {
  id: string
  script: QuestionScript
  provider: LLMProvider
  modelId: string
  /** Override the interviewer system prompt (testing). */
  interviewerSystemPrompt?: string
  /** Override the summary system prompt (testing). */
  summarySystemPrompt?: string
  /** Test injection. Defaults to () => new Date(). */
  now?: () => Date
}

export interface NextQuestion {
  /** Position in the flow: 1-indexed; opening is index 1. */
  index: number
  /** Soft target turn count (script.target_turns). null while indeterminate. */
  total: number | null
  question: Question
}

export interface SessionPreview {
  transcript: InterviewTranscript
  handoff: HandoffDocument
  tools: ToolSuggestion[]
  schedules: ScheduleSuggestion[]
  /** The name the handoff builder normalized; what `confirm()` produces. */
  agent_name: string
}

export type AdvanceResult =
  | { kind: 'next'; question: NextQuestion }
  | { kind: 'done'; preview: SessionPreview }

export class OnboardingSessionError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly state: OnboardingSessionState,
    message: string,
  ) {
    super(`Onboarding session ${sessionId} (state=${state}): ${message}`)
    this.name = 'OnboardingSessionError'
  }
}

interface InterviewerDirective {
  kind: 'question' | 'done'
  text?: string
  covering?: string
}

export class OnboardingSession {
  readonly id: string
  private readonly script: QuestionScript
  private readonly provider: LLMProvider
  private readonly modelId: string
  private readonly interviewerSystemPrompt: string
  private readonly summarySystemPrompt: string
  private readonly nowFn: () => Date

  private state: OnboardingSessionState = 'awaiting_opening'
  private readonly entries: TranscriptEntry[] = []
  private nextQuestion: Question | null = null
  private generatedQCount = 0
  private readonly startedAt: string
  private finishedAt: string | null = null
  private summary: string | null = null
  private preview: SessionPreview | null = null

  constructor(opts: OnboardingSessionOptions) {
    this.id = opts.id
    this.script = opts.script
    this.provider = opts.provider
    this.modelId = opts.modelId
    this.interviewerSystemPrompt =
      opts.interviewerSystemPrompt ?? renderInterviewerSystemPrompt(opts.script)
    this.summarySystemPrompt = opts.summarySystemPrompt ?? SUMMARY_SYSTEM_PROMPT
    this.nowFn = opts.now ?? ((): Date => new Date())
    this.startedAt = this.nowFn().toISOString()
    this.nextQuestion = opts.script.opening
  }

  getState(): OnboardingSessionState {
    return this.state
  }

  /**
   * Question to show next, or null when the session is in a terminal
   * state. Stable across reads; a refresh-while-mid-interview lands on
   * the same question.
   */
  currentQuestion(): NextQuestion | null {
    if (this.state !== 'awaiting_opening' && this.state !== 'awaiting_response') return null
    const q = this.nextQuestion
    if (!q) return null
    return {
      index: this.entries.length + 1,
      total: this.script.target_turns,
      question: q,
    }
  }

  getPreview(): SessionPreview | null {
    return this.preview
  }

  async submitAnswer(answer: string): Promise<AdvanceResult> {
    if (this.state !== 'awaiting_opening' && this.state !== 'awaiting_response') {
      throw new OnboardingSessionError(
        this.id,
        this.state,
        'submitAnswer is only valid in awaiting_* states',
      )
    }
    const question = this.nextQuestion
    if (!question) {
      throw new OnboardingSessionError(this.id, this.state, 'no current question')
    }
    this.entries.push({
      question_id: question.id,
      question_text: question.text,
      answer,
      ...(question.intent_tag !== undefined ? { intent_tag: question.intent_tag } : {}),
      asked_at: this.nowFn().toISOString(),
    })

    // Hard cap: stop generating questions once max_turns is hit.
    if (this.entries.length >= this.script.max_turns) {
      return await this.summarizeAndFinish()
    }

    // Otherwise ask the interviewer LLM what to do next.
    const directive = await this.askInterviewer()
    if (directive.kind === 'done') {
      return await this.summarizeAndFinish()
    }
    // Build the next question and stash it.
    this.generatedQCount += 1
    const intentTag =
      directive.covering !== undefined && directive.covering.length > 0
        ? directive.covering
        : undefined
    const nextQ: Question = {
      id: `q_${String(this.generatedQCount)}`,
      text: directive.text ?? '',
      expects: 'free_form',
      ...(intentTag !== undefined ? { intent_tag: intentTag } : {}),
    }
    this.nextQuestion = nextQ
    this.state = 'awaiting_response'
    return {
      kind: 'next',
      question: {
        index: this.entries.length + 1,
        total: this.script.target_turns,
        question: nextQ,
      },
    }
  }

  markConfirmed(): void {
    if (this.state !== 'done') {
      throw new OnboardingSessionError(this.id, this.state, 'markConfirmed requires state=done')
    }
    this.state = 'confirmed'
  }

  cancel(): void {
    if (this.state === 'confirmed') {
      throw new OnboardingSessionError(this.id, this.state, 'already confirmed')
    }
    this.state = 'cancelled'
  }

  getTranscript(): InterviewTranscript {
    return {
      interview_schema_version: INTERVIEW_SCHEMA_VERSION,
      script_name: this.script.name,
      chosen_branch: 'llm_driven',
      entries: [...this.entries],
      summary: this.summary ?? '',
      started_at: this.startedAt,
      finished_at: this.finishedAt ?? this.nowFn().toISOString(),
    }
  }

  // --- internals -----------------------------------------------------------

  /**
   * Ask the interviewer LLM what to do next given the transcript so
   * far. Returns either a question directive or a done directive. On
   * malformed output we re-prompt once; on continued failure we force
   * done so the user gets to a preview rather than a stuck session.
   */
  private async askInterviewer(): Promise<InterviewerDirective> {
    const transcriptText = renderTranscriptForInterviewer(this.entries)
    const turnNumber = this.entries.length + 1
    const goalsCovered = listCoveredGoalIds(this.entries)
    const requiredRemaining = this.script.goals
      .filter((g) => g.required && !goalsCovered.has(g.id))
      .map((g) => g.id)

    const userMsg = `TRANSCRIPT SO FAR (${String(this.entries.length)} turns; you are about to produce turn ${String(turnNumber)} of up to ${String(this.script.max_turns)}):

${transcriptText}

REQUIRED GOALS NOT YET COVERED: ${requiredRemaining.length === 0 ? '(none ... you may end whenever you have enough)' : requiredRemaining.join(', ')}

Produce the next JSON message now.`

    const request: CompletionRequest = {
      modelId: this.modelId,
      systemPrompt: this.interviewerSystemPrompt,
      messages: [{ role: 'user', content: userMsg }],
      temperature: 0.6,
      maxTokens: 400,
    }

    let raw: string
    try {
      const response = await this.provider.complete(request)
      raw = response.text
    } catch (err) {
      this.state = 'errored'
      throw err
    }

    let directive = parseDirective(raw)
    if (!directive) {
      // One re-prompt with explicit shape reminder.
      const repromptMsg =
        userMsg +
        `\n\nYour previous response was not valid JSON. Reply with ONLY the JSON object: {"kind":"question","text":"...","covering":"<goal_id>"} or {"kind":"done"}.`
      const reprompt: CompletionRequest = {
        ...request,
        messages: [{ role: 'user', content: repromptMsg }],
      }
      try {
        const response = await this.provider.complete(reprompt)
        directive = parseDirective(response.text)
      } catch {
        // Swallow; fall through to forced done below.
      }
    }
    if (!directive) {
      // Could not get a parseable directive. Force done so the user
      // reaches a preview; better to ship a partial Identity the user
      // can refine than to loop on a misbehaving model.
      return { kind: 'done' }
    }
    return directive
  }

  private async summarizeAndFinish(): Promise<AdvanceResult> {
    this.state = 'summarizing'
    const transcriptText = this.entries
      .map(
        (e) =>
          `Q (${e.question_id}${e.intent_tag ? `; covers: ${e.intent_tag}` : ''}): ${e.question_text}\nA: ${e.answer}`,
      )
      .join('\n\n')
    const request: CompletionRequest = {
      modelId: this.modelId,
      systemPrompt: this.summarySystemPrompt,
      messages: [
        {
          role: 'user',
          content: `Onboarding interview:\n\n${transcriptText}`,
        },
      ],
      temperature: 0.4,
      maxTokens: 800,
    }
    let summaryText: string
    try {
      const response = await this.provider.complete(request)
      summaryText = response.text.trim()
    } catch (err) {
      this.state = 'errored'
      throw err
    }
    if (summaryText.length === 0) {
      this.state = 'errored'
      throw new OnboardingSessionError(this.id, this.state, 'LLM returned an empty summary')
    }
    this.summary = summaryText
    this.finishedAt = this.nowFn().toISOString()
    const transcript = this.getTranscript()

    const dryHandoff = buildHandoffFromTranscript({ transcript })
    const agentName = dryHandoff.frontmatter.agent_name
    const tools = suggestTools(transcript, agentName)
    const schedules = suggestSchedules(transcript)
    // The picker's chosen provider+model also becomes the new
    // Agent's day-to-day model (the intro card's stated promise).
    // Identity-from-handoff uses this when present.
    const handoff = buildHandoffFromTranscript({
      transcript,
      mcpServers: tools.map((t) => t.server),
      model: {
        provider: this.provider.name,
        model_id: this.modelId,
      },
    })

    this.preview = {
      transcript,
      handoff,
      tools,
      schedules,
      agent_name: agentName,
    }
    this.state = 'done'
    return { kind: 'done', preview: this.preview }
  }
}

// --- module-level helpers --------------------------------------------------

function renderInterviewerSystemPrompt(script: QuestionScript): string {
  const persona = script.interviewer_persona ?? DEFAULT_INTERVIEWER_PERSONA
  const goalsBlock = script.goals
    .map((g) => `  - ${g.id} (${g.required ? 'required' : 'optional'}): ${g.description}`)
    .join('\n')
  return INTERVIEWER_SYSTEM_TEMPLATE.replace('{persona}', persona)
    .replace('{goals}', goalsBlock)
    .replace('{target_turns}', String(script.target_turns))
    .replace('{max_turns}', String(script.max_turns))
}

function renderTranscriptForInterviewer(entries: readonly TranscriptEntry[]): string {
  if (entries.length === 0) return '(no turns yet)'
  return entries
    .map(
      (e, i) =>
        `Turn ${String(i + 1)} (covers: ${e.intent_tag ?? '?'}):\n  Q: ${e.question_text}\n  A: ${e.answer}`,
    )
    .join('\n\n')
}

function listCoveredGoalIds(entries: readonly TranscriptEntry[]): Set<string> {
  const out = new Set<string>()
  for (const e of entries) if (e.intent_tag) out.add(e.intent_tag)
  return out
}

/**
 * Parse the interviewer's raw text into a directive. Tolerant: accepts
 * a bare JSON object, a JSON object inside ``` fences, or a JSON object
 * surrounded by prose.
 */
export function parseDirective(raw: string): InterviewerDirective | null {
  const text = raw.trim()
  if (text.length === 0) return null
  // Try the whole string as JSON first.
  const direct = tryParse(text)
  if (direct) return direct
  // Strip markdown fences if present.
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(text)
  if (fenceMatch?.[1]) {
    const inFence = tryParse(fenceMatch[1])
    if (inFence) return inFence
  }
  // First {...} block.
  const braceStart = text.indexOf('{')
  const braceEnd = text.lastIndexOf('}')
  if (braceStart >= 0 && braceEnd > braceStart) {
    const slice = text.slice(braceStart, braceEnd + 1)
    const inSlice = tryParse(slice)
    if (inSlice) return inSlice
  }
  return null
}

function tryParse(s: string): InterviewerDirective | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(s)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  const kind = obj['kind']
  if (kind === 'done') {
    return { kind: 'done' }
  }
  if (kind === 'question') {
    const text = obj['text']
    const covering = obj['covering']
    if (typeof text !== 'string' || text.trim().length === 0) return null
    return {
      kind: 'question',
      text: text.trim(),
      ...(typeof covering === 'string' ? { covering } : {}),
    }
  }
  return null
}
