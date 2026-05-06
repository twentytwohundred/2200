/**
 * Onboarding session: the interview as a state machine that drives
 * over HTTP request boundaries.
 *
 * The CLI's `runInterview` (Epic 14 Phase A) runs the interview as a
 * single async function with a callback-driven `UserInput.ask()`. That
 * shape works for stdin but not for stateless HTTP, where each
 * answer arrives as its own request and the server has to remember
 * where the conversation left off.
 *
 * This module factors the interview into discrete steps:
 *
 *   awaiting_opening
 *     -> answer becomes entry[0]; routing picks the branch
 *     -> awaiting_branch_question(0)
 *
 *   awaiting_branch_question(i)
 *     -> answer becomes entry[i+1]
 *     -> if i+1 < branch.questions.length:
 *           awaiting_branch_question(i+1)
 *        else:
 *           summarizing -> LLM call -> done
 *
 *   done
 *     -> preview is available; confirm() materializes the agent
 *
 *   confirmed | cancelled
 *     -> terminal
 *
 * The state-machine surface mirrors what `runInterview` does end-to-
 * end, so the CLI keeps its pre-existing single-call ergonomics
 * unchanged. Web-facing callers drive this state machine over HTTP
 * via the session-store endpoints.
 */
import type { LLMProvider } from '../llm/provider.js'
import { pickBranch } from './interview.js'
import {
  INTERVIEW_SCHEMA_VERSION,
  type Branch,
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

export const DEFAULT_SUMMARY_SYSTEM_PROMPT = `You are summarizing a brief onboarding interview that will create a new Agent inside 2200, the Agent runtime. The user has answered a structured set of questions about what they want their Agent to do.

Produce a short narrative summary (3-6 sentences) capturing:
- Who this Agent is and what its lane is
- What it should do day-to-day
- The cadence or schedule the user described
- Any tools or integrations the user named

Write in first person from the Agent's perspective ("I am ...", "My job is ..."). The summary becomes the Agent's first brain note (titled "continuity-from-onboarding") so on its first run inside 2200 it has a written explanation of why it exists. Keep it concrete; quote specifics from the user's answers when they help.`

export type OnboardingSessionState =
  | 'awaiting_opening'
  | 'awaiting_branch_question'
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
  systemPrompt?: string
  /** Test injection. Defaults to () => new Date(). */
  now?: () => Date
}

export interface NextQuestion {
  /** Position in the flow: opening, then 1, 2, ... up to branch.questions.length. */
  index: number
  /** Total question count once a branch is chosen; null while the
   * opening is in flight (branch not yet known). */
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

export class OnboardingSession {
  readonly id: string
  private readonly script: QuestionScript
  private readonly provider: LLMProvider
  private readonly modelId: string
  private readonly systemPrompt: string
  private readonly nowFn: () => Date

  private state: OnboardingSessionState = 'awaiting_opening'
  private chosenBranch: Branch | null = null
  private branchIndex = 0
  private readonly entries: TranscriptEntry[] = []
  private readonly startedAt: string
  private finishedAt: string | null = null
  private summary: string | null = null
  private preview: SessionPreview | null = null

  constructor(opts: OnboardingSessionOptions) {
    this.id = opts.id
    this.script = opts.script
    this.provider = opts.provider
    this.modelId = opts.modelId
    this.systemPrompt = opts.systemPrompt ?? DEFAULT_SUMMARY_SYSTEM_PROMPT
    this.nowFn = opts.now ?? ((): Date => new Date())
    this.startedAt = this.nowFn().toISOString()
  }

  /** Current state. Read by the session store + endpoint handlers. */
  getState(): OnboardingSessionState {
    return this.state
  }

  /**
   * Question to show next, or null when the session is in a terminal
   * state. Stable across reads ... a refresh-while-mid-interview lands
   * on the same question.
   */
  currentQuestion(): NextQuestion | null {
    if (this.state === 'awaiting_opening') {
      return {
        index: 0,
        total: null,
        question: this.script.opening,
      }
    }
    if (this.state === 'awaiting_branch_question' && this.chosenBranch) {
      const q = this.chosenBranch.questions[this.branchIndex]
      if (!q) return null
      return {
        index: this.branchIndex + 1,
        total: this.chosenBranch.questions.length + 1,
        question: q,
      }
    }
    return null
  }

  /** Done-state preview, or null when the interview is not complete. */
  getPreview(): SessionPreview | null {
    return this.preview
  }

  /**
   * Submit the user's answer to the current question. Advances the
   * state machine and resolves with either the next question or the
   * done-with-preview shape. Throws when called on a terminal state
   * or when the LLM summary call fails (the session transitions to
   * `errored` in the latter case).
   */
  async submitAnswer(answer: string): Promise<AdvanceResult> {
    if (this.state === 'awaiting_opening') {
      return await this.recordOpeningAndAdvance(answer)
    }
    if (this.state === 'awaiting_branch_question') {
      return await this.recordBranchAndAdvance(answer)
    }
    throw new OnboardingSessionError(
      this.id,
      this.state,
      'submitAnswer is only valid in awaiting_* states',
    )
  }

  /**
   * Mark the session confirmed. Caller (the HTTP handler) is expected
   * to have already invoked the migration orchestrator with
   * `getPreview().handoff`. This method is the bookkeeping side: it
   * locks the session into a terminal state so a second confirm can't
   * double-spawn.
   */
  markConfirmed(): void {
    if (this.state !== 'done') {
      throw new OnboardingSessionError(this.id, this.state, 'markConfirmed requires state=done')
    }
    this.state = 'confirmed'
  }

  /** Cancel the session. Idempotent. */
  cancel(): void {
    if (this.state === 'confirmed') {
      throw new OnboardingSessionError(this.id, this.state, 'already confirmed')
    }
    this.state = 'cancelled'
  }

  /** The transcript snapshot. Useful for tests + audit. */
  getTranscript(): InterviewTranscript {
    return {
      interview_schema_version: INTERVIEW_SCHEMA_VERSION,
      script_name: this.script.name,
      chosen_branch: this.chosenBranch?.id ?? this.script.default_branch,
      entries: [...this.entries],
      summary: this.summary ?? '',
      started_at: this.startedAt,
      finished_at: this.finishedAt ?? this.nowFn().toISOString(),
    }
  }

  // --- internals -----------------------------------------------------------

  private async recordOpeningAndAdvance(answer: string): Promise<AdvanceResult> {
    const opening = this.script.opening
    this.entries.push({
      question_id: opening.id,
      question_text: opening.text,
      answer,
      ...(opening.intent_tag !== undefined ? { intent_tag: opening.intent_tag } : {}),
      asked_at: this.nowFn().toISOString(),
    })
    const branch = pickBranch(this.script, answer)
    this.chosenBranch = branch
    if (branch.questions.length === 0) {
      // Edge case: a branch with zero questions falls straight to
      // summarize. Possible only with a deliberately stripped-down
      // script; the bundled default has populated branches.
      return await this.summarizeAndFinish()
    }
    this.state = 'awaiting_branch_question'
    this.branchIndex = 0
    const question = branch.questions[0]
    if (!question) {
      throw new OnboardingSessionError(this.id, this.state, 'branch question 0 missing')
    }
    return {
      kind: 'next',
      question: {
        index: 1,
        total: branch.questions.length + 1,
        question,
      },
    }
  }

  private async recordBranchAndAdvance(answer: string): Promise<AdvanceResult> {
    const branch = this.chosenBranch
    if (!branch) {
      throw new OnboardingSessionError(this.id, this.state, 'no branch chosen')
    }
    const question = branch.questions[this.branchIndex]
    if (!question) {
      throw new OnboardingSessionError(
        this.id,
        this.state,
        `branch question ${String(this.branchIndex)} missing`,
      )
    }
    this.entries.push({
      question_id: question.id,
      question_text: question.text,
      answer,
      ...(question.intent_tag !== undefined ? { intent_tag: question.intent_tag } : {}),
      asked_at: this.nowFn().toISOString(),
    })
    this.branchIndex += 1
    if (this.branchIndex >= branch.questions.length) {
      return await this.summarizeAndFinish()
    }
    const next = branch.questions[this.branchIndex]
    if (!next) {
      throw new OnboardingSessionError(this.id, this.state, 'next branch question missing')
    }
    return {
      kind: 'next',
      question: {
        index: this.branchIndex + 1,
        total: branch.questions.length + 1,
        question: next,
      },
    }
  }

  /**
   * Run the LLM summary, build the preview (handoff + tools +
   * schedules), and transition to `done`. On LLM failure, transitions
   * to `errored` and rethrows so the caller surfaces the error.
   */
  private async summarizeAndFinish(): Promise<AdvanceResult> {
    this.state = 'summarizing'
    const branch = this.chosenBranch
    if (!branch) {
      this.state = 'errored'
      throw new OnboardingSessionError(this.id, this.state, 'no branch on summarize')
    }
    const transcriptText = this.entries
      .map((e) => `Q (${e.question_id}): ${e.question_text}\nA: ${e.answer}`)
      .join('\n\n')
    const request: CompletionRequest = {
      modelId: this.modelId,
      systemPrompt: this.systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Onboarding interview (chosen branch: ${branch.id}):\n\n${transcriptText}`,
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

    // Build the handoff + suggestions ... same shape as the CLI's
    // post-interview pipeline so the resulting Agent matches what
    // `2200 agent spawn` would produce.
    const dryHandoff = buildHandoffFromTranscript({ transcript })
    const agentName = dryHandoff.frontmatter.agent_name
    const tools = suggestTools(transcript, agentName)
    const schedules = suggestSchedules(transcript)
    const handoff = buildHandoffFromTranscript({
      transcript,
      mcpServers: tools.map((t) => t.server),
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
