/**
 * Interview module: CLI single-call wrapper around OnboardingSession.
 *
 * The web flow drives OnboardingSession over HTTP; the CLI prefers a
 * single async function (ask, capture, ask, capture, summarize). This
 * module bridges those shapes by spinning up a session, feeding it
 * answers from a UserInput source, and unwrapping the final preview
 * into the InterviewTranscript that the CLI's downstream pipeline
 * (tool-suggestions, schedule-suggestions, identity-from-interview)
 * already consumes.
 *
 * As of v2 the session is LLM-driven; the CLI no longer has its own
 * scripted-walk variant.
 */
import type { LLMProvider } from '../llm/provider.js'
import { OnboardingSession } from './session.js'
import type { InterviewTranscript, QuestionScript } from './types.js'

export interface UserInput {
  ask(promptText: string): Promise<string>
}

export interface RunInterviewArgs {
  script: QuestionScript
  provider: LLMProvider
  modelId: string
  input: UserInput
  /** Test injection. */
  now?: () => Date
  /** Override the interviewer system prompt. */
  interviewerSystemPrompt?: string
  /** Override the summary system prompt. */
  summarySystemPrompt?: string
}

export async function runInterview(args: RunInterviewArgs): Promise<InterviewTranscript> {
  const session = new OnboardingSession({
    id: `cli_${Date.now().toString(36)}`,
    script: args.script,
    provider: args.provider,
    modelId: args.modelId,
    ...(args.now ? { now: args.now } : {}),
    ...(args.interviewerSystemPrompt
      ? { interviewerSystemPrompt: args.interviewerSystemPrompt }
      : {}),
    ...(args.summarySystemPrompt ? { summarySystemPrompt: args.summarySystemPrompt } : {}),
  })

  // Walk the session: present each question to the user, post the
  // answer back, repeat until the session reports done.
  for (let next = session.currentQuestion(); next !== null; next = session.currentQuestion()) {
    const answer = await args.input.ask(next.question.text)
    const advanced = await session.submitAnswer(answer)
    if (advanced.kind === 'done') {
      return advanced.preview.transcript
    }
  }
  // The loop should always exit via an explicit `done` from
  // submitAnswer. Reaching here means the session is in a terminal
  // non-done state; pull the transcript snapshot for diagnostics.
  return session.getTranscript()
}
