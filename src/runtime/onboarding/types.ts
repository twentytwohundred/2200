/**
 * Conversational onboarding types.
 *
 * The onboarding flow is LLM-driven from v2 on. The user gets a free-
 * form opening question; an LLM conducts the rest of the interview,
 * deciding what to ask next based on the conversation so far and a
 * declared list of goals (dimensions the interview must cover before
 * it can end). When the LLM judges that the required goals are
 * satisfied it signals "done" and the session moves to the summary +
 * preview step.
 *
 * Why LLM-driven: the v1 YAML-script-with-branches model worked but
 * felt like a questionnaire, not a conversation. A real conversation
 * drills into vague answers, skips redundant questions when the user
 * already covered them, and adapts to the actual lane the user is
 * describing. The interviewer is itself an Agent (single-shot, lives
 * only for the duration of the spawn) ... a fitting first user of the
 * platform's LLM stack.
 *
 * Each interview turn the LLM either (a) asks the next question with
 * a `covering: <goal_id>` annotation, which the session records as the
 * answer's `intent_tag`, or (b) returns `kind: done`, which transitions
 * the session to summary + preview. The intent_tag pipeline downstream
 * (tool-suggestions, schedule-suggestions, identity-from-interview)
 * continues to work unchanged: goal ids ARE intent_tags.
 *
 * v2 invariants:
 *
 *   - Script declares an opening question + a list of goals. No
 *     branches, no routing rules.
 *   - The interviewer LLM decides what to ask each turn. Required
 *     goals MUST be covered before "done" is returned.
 *   - Every transcript carries `interview_schema_version: 2`. The
 *     migrator chain pattern (per [[2026-04-26-schema-version-format]])
 *     handles future bumps; v1 transcripts on disk are rejected at
 *     load (one-shot operation; no production v1 transcripts exist
 *     outside of test fixtures).
 *   - The transcript body is preserved verbatim as a brain note titled
 *     `continuity-from-onboarding` (parallel to Epic 5's
 *     `continuity-from-migration`) so the Agent's first context inside
 *     2200 is the conversation that brought it into existence.
 */
import { z } from 'zod'

export const INTERVIEW_SCHEMA_VERSION = 2

/**
 * One question in a transcript. The runtime renders `text` as the
 * prompt, captures the user's free-form answer, and tags the answer
 * with `intent_tag` (the goal id the LLM said this question was
 * covering).
 */
export const QuestionSchema = z.object({
  /** Stable id; opening questions have id 'opening', generated questions have synthetic ids. */
  id: z.string().regex(/^[a-z][a-z0-9_]*$/, {
    message:
      'question id must start with a lowercase letter; lowercase + digits + underscores only',
  }),
  /** The prompt shown to the user. */
  text: z.string().min(1),
  /** Hint for the renderer; advisory at v2. */
  expects: z.enum(['free_form', 'yes_no', 'name', 'email', 'cron', 'time']).default('free_form'),
  /**
   * Goal id the interviewer LLM declared this question covers. The
   * tool-suggestions / schedule-suggestions / identity-from-interview
   * modules read this as `intent_tag`.
   */
  intent_tag: z.string().min(1).optional(),
})
export type Question = z.infer<typeof QuestionSchema>

/**
 * One goal in the interview script. The interviewer LLM gets the goal
 * list and works through it, asking whatever questions surface the
 * needed information. Required goals must all have an answer (i.e.
 * an `intent_tag === goal.id` entry in the transcript) before the
 * session can transition to done.
 */
export const GoalSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/, {
    message: 'goal id must start with a lowercase letter; lowercase + digits + underscores only',
  }),
  /** What this goal covers, in plain language. The LLM uses this as a prompt. */
  description: z.string().min(1),
  /** Required goals block 'done'. Optional goals are nice-to-have. */
  required: z.boolean().default(false),
})
export type Goal = z.infer<typeof GoalSchema>

/**
 * The full question script (v2). The opening question is fixed text;
 * everything after is LLM-driven against the goals list.
 */
export const QuestionScriptSchema = z.object({
  /** Locked at 2 for v2; v1 (branched YAML) is no longer accepted. */
  script_schema_version: z.literal(2),
  /** Free-form name; helps the operator distinguish multiple scripts. */
  name: z.string().min(1),
  /** The first question shown. The user's answer to this kicks the LLM-driven flow. */
  opening: QuestionSchema,
  /** Dimensions the interviewer must cover (or attempt to cover) before signaling done. */
  goals: z.array(GoalSchema).min(1),
  /**
   * Soft target for the number of turns (opening counts as turn 1).
   * The interviewer aims for this; the LLM is free to go shorter or
   * longer based on how much the user volunteers.
   */
  target_turns: z.number().int().positive().default(6),
  /** Hard ceiling; the session forces 'done' once max_turns is reached even if some optional goals are uncovered. */
  max_turns: z.number().int().positive().default(12),
  /**
   * Free-form description shown to the LLM as part of its prompt.
   * Captures tone, register, what kind of agents this script is meant
   * for. Editable by non-engineers without touching code.
   */
  interviewer_persona: z.string().min(1).optional(),
})
export type QuestionScript = z.infer<typeof QuestionScriptSchema>

/**
 * One captured Q&A in the transcript. The runtime appends one of these
 * per question asked.
 */
export const TranscriptEntrySchema = z.object({
  question_id: z.string().min(1),
  /** The text shown to the user (snapshot ... script edits do not retro-mutate transcripts). */
  question_text: z.string().min(1),
  /** What the user typed. Verbatim. */
  answer: z.string(),
  /** Carried from the question's `intent_tag` (the goal the LLM said it was covering). */
  intent_tag: z.string().optional(),
  /** ISO timestamp of when the answer was captured. */
  asked_at: z.string().min(1),
})
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>

/**
 * The full transcript. `summary` is the LLM-produced wrap of the
 * conversation, suitable for the Agent's first brain note. The
 * structured `entries` are what the Identity / tool / schedule
 * generators consume.
 *
 * `chosen_branch` is preserved for transcript-format continuity but is
 * always `'llm_driven'` in v2; the field name is vestigial and may be
 * dropped in a future schema bump.
 */
export const InterviewTranscriptSchema = z.object({
  interview_schema_version: z.literal(2),
  /** The script's `name` field, snapshotted. */
  script_name: z.string().min(1),
  /** Always 'llm_driven' in v2. Preserved for downstream compatibility. */
  chosen_branch: z.string().min(1),
  /** Ordered Q&A. The opening is `entries[0]`. */
  entries: z.array(TranscriptEntrySchema).min(1),
  /** LLM-produced narrative; becomes the continuity-from-onboarding brain note body. */
  summary: z.string().min(1),
  /** ISO timestamp of when the interview started. */
  started_at: z.string().min(1),
  /** ISO timestamp of when the interview finished (after summary). */
  finished_at: z.string().min(1),
})
export type InterviewTranscript = z.infer<typeof InterviewTranscriptSchema>

/**
 * Slug for the brain note the orchestrator writes from the transcript
 * summary. Locked here so the same value is used by the generator and
 * the brain reader.
 */
export const ONBOARDING_NOTE_SLUG = 'continuity-from-onboarding'
