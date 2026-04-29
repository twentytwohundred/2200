/**
 * Interview module for conversational onboarding (Epic 14 Phase A PR B).
 *
 * Runs a YAML question script against an LLM provider and a user-input
 * source, captures answers, and produces an InterviewTranscript that
 * later modules (PR C) translate into an Identity, suggested
 * `mcp_servers[]` entries, and suggested schedules.
 *
 * Phase A flow:
 *
 *   1. Ask the opening question; capture the answer.
 *   2. Match the answer (lowercased) against the script's routing
 *      rules in order; the first matching `if_keywords` rule wins.
 *      If none match, run the `default_branch`.
 *   3. Ask each question in the chosen branch in order; capture each
 *      answer and append to the transcript.
 *   4. Send the structured Q&A to the LLM with a summarization prompt.
 *      The LLM's response becomes the transcript's `summary`.
 *   5. Return the full InterviewTranscript.
 *
 * The interview is a one-shot operation. If the user aborts mid-flow
 * (Ctrl-C in the CLI), no state is written ... the transcript is
 * in-memory only until `runInterview` returns. The CLI wrapper (PR D)
 * is the layer that takes the returned transcript and decides whether
 * to materialize an Agent.
 */
import type { LLMProvider } from '../llm/provider.js'
import type { CompletionRequest } from '../llm/types.js'
import {
  INTERVIEW_SCHEMA_VERSION,
  type Branch,
  type InterviewTranscript,
  type QuestionScript,
  type TranscriptEntry,
} from './types.js'

/**
 * Input source for the interview. The caller provides an
 * implementation; CLI uses readline against stdin, tests inject canned
 * answers, future UI variants use whatever input affordance they have.
 *
 * `ask` shows the prompt text to the user and returns their answer.
 * Whitespace handling is the caller's responsibility (the interview
 * stores the answer verbatim).
 */
export interface UserInput {
  ask(promptText: string): Promise<string>
}

export interface RunInterviewArgs {
  script: QuestionScript
  provider: LLMProvider
  /** Model id to use for the summary call. e.g. 'claude-opus-4-7'. */
  modelId: string
  input: UserInput
  /** Test injection. */
  now?: () => Date
  /** Override the LLM system prompt for the summary call. */
  systemPrompt?: string
}

const DEFAULT_SYSTEM_PROMPT = `You are summarizing a brief onboarding interview that will create a new Agent inside 2200, the Agent runtime. The user has answered a structured set of questions about what they want their Agent to do.

Produce a short narrative summary (3-6 sentences) capturing:
- Who this Agent is and what its lane is
- What it should do day-to-day
- The cadence or schedule the user described
- Any tools or integrations the user named

Write in first person from the Agent's perspective ("I am ...", "My job is ..."). The summary becomes the Agent's first brain note (titled "continuity-from-onboarding") so on its first run inside 2200 it has a written explanation of why it exists. Keep it concrete; quote specifics from the user's answers when they help.`

/**
 * Run an interview. Asks the opening question, routes to a branch,
 * runs the branch's questions in order, asks the LLM for a summary,
 * and returns the transcript.
 *
 * Throws if:
 *   - the script's `default_branch` does not name a real branch (the
 *     loader catches this; defensive double-check here)
 *   - the LLM call for the summary fails (the caller decides whether
 *     to surface the error or fall back to a stub summary)
 */
export async function runInterview(args: RunInterviewArgs): Promise<InterviewTranscript> {
  const nowFn = args.now ?? ((): Date => new Date())
  const startedAt = nowFn().toISOString()

  const entries: TranscriptEntry[] = []

  // 1. Opening
  const openingAnswer = await args.input.ask(args.script.opening.text)
  entries.push({
    question_id: args.script.opening.id,
    question_text: args.script.opening.text,
    answer: openingAnswer,
    ...(args.script.opening.intent_tag !== undefined
      ? { intent_tag: args.script.opening.intent_tag }
      : {}),
    asked_at: nowFn().toISOString(),
  })

  // 2. Routing
  const branch = pickBranch(args.script, openingAnswer)

  // 3. Branch questions
  for (const question of branch.questions) {
    const answer = await args.input.ask(question.text)
    entries.push({
      question_id: question.id,
      question_text: question.text,
      answer,
      ...(question.intent_tag !== undefined ? { intent_tag: question.intent_tag } : {}),
      asked_at: nowFn().toISOString(),
    })
  }

  // 4. Summary
  const summary = await summarizeTranscript({
    provider: args.provider,
    modelId: args.modelId,
    entries,
    chosenBranch: branch.id,
    systemPrompt: args.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
  })

  return {
    interview_schema_version: INTERVIEW_SCHEMA_VERSION,
    script_name: args.script.name,
    chosen_branch: branch.id,
    entries,
    summary,
    started_at: startedAt,
    finished_at: nowFn().toISOString(),
  }
}

/**
 * Pick a branch from a script given the opening answer. First matching
 * routing rule wins; falls back to default_branch.
 *
 * Match semantics: the answer is lowercased and each `if_keywords`
 * entry is also lowercased (the keyword list itself is treated as
 * already lowercase by convention; the loader does not enforce, but
 * matching forces lowercase on both sides for safety).
 */
export function pickBranch(script: QuestionScript, openingAnswer: string): Branch {
  const lowered = openingAnswer.toLowerCase()
  for (const rule of script.routing) {
    for (const kw of rule.if_keywords) {
      if (lowered.includes(kw.toLowerCase())) {
        const matched = script.branches.find((b) => b.id === rule.next_branch)
        if (matched !== undefined) return matched
      }
    }
  }
  const fallback = script.branches.find((b) => b.id === script.default_branch)
  if (fallback === undefined) {
    throw new Error(
      `script "${script.name}" default_branch "${script.default_branch}" does not match any branch id`,
    )
  }
  return fallback
}

interface SummarizeArgs {
  provider: LLMProvider
  modelId: string
  entries: readonly TranscriptEntry[]
  chosenBranch: string
  systemPrompt: string
}

async function summarizeTranscript(args: SummarizeArgs): Promise<string> {
  const transcriptText = args.entries
    .map((e) => `Q (${e.question_id}): ${e.question_text}\nA: ${e.answer}`)
    .join('\n\n')

  const request: CompletionRequest = {
    modelId: args.modelId,
    systemPrompt: args.systemPrompt,
    messages: [
      {
        role: 'user',
        content: `Onboarding interview (chosen branch: ${args.chosenBranch}):\n\n${transcriptText}`,
      },
    ],
    temperature: 0.4,
    maxTokens: 800,
  }

  const response = await args.provider.complete(request)
  const text = response.text.trim()
  if (text.length === 0) {
    throw new Error('LLM returned an empty summary; cannot create the continuity brain note')
  }
  return text
}
