/**
 * Conversational onboarding types (Epic 14 Phase A PR A).
 *
 * The onboarding flow takes a YAML question script (declarative,
 * editable by non-engineers per the locked Phase A decision) and runs
 * the user through it against an LLM provider. The resulting
 * transcript carries the structured Q&A plus the LLM's summary; later
 * modules (PR C) translate the transcript into an Identity, suggested
 * `mcp_servers[]` entries, and suggested schedules.
 *
 * v1 invariants:
 *
 *   - The script is data-driven YAML at `src/runtime/onboarding/scripts/`.
 *   - Question flow is structured (ordered list per branch, optional
 *     branching by keyword match on the user's first answer); no
 *     free-roam multi-turn negotiation.
 *   - Every transcript carries `interview_schema_version: 1` so the
 *     format can evolve via the same migrator-chain pattern used by
 *     Identity files (per [[2026-04-26-schema-version-format]]).
 *   - The transcript body is preserved verbatim as a brain note titled
 *     `continuity-from-onboarding` (parallel to Epic 5's
 *     `continuity-from-migration`) so the Agent's first context inside
 *     2200 is the conversation that brought it into existence.
 */
import { z } from 'zod'

export const INTERVIEW_SCHEMA_VERSION = 1

/**
 * One question in a script. The runtime renders `text` as the prompt,
 * captures the user's free-form answer, and tags the answer with
 * `intent_tag` (used by the tool/schedule suggesters in PR C).
 *
 * `expects` hints the renderer about input shape (free-form prose,
 * single-token enum, etc.); v1 accepts free-form for everything and
 * the LLM normalizes after. The field exists so future polish can
 * surface validation hints in the CLI ("yes/no?", "expecting a name").
 */
export const QuestionSchema = z.object({
  /** Stable id; referenced by branches and post-processing. */
  id: z.string().regex(/^[a-z][a-z0-9_]*$/, {
    message:
      'question id must start with a lowercase letter; lowercase + digits + underscores only',
  }),
  /** The prompt shown to the user. */
  text: z.string().min(1),
  /** Hint for the renderer; advisory at v1. */
  expects: z.enum(['free_form', 'yes_no', 'name', 'email', 'cron', 'time']).default('free_form'),
  /**
   * Tag attached to the answer in the transcript. Used by the
   * tool/schedule suggesters to map answers to mcp_servers[] +
   * schedule defaults. Free-form string; conventional tags live in
   * `wiki/conventions/onboarding-tags.md` (lands when the suggester
   * mappings stabilize).
   */
  intent_tag: z.string().min(1).optional(),
})
export type Question = z.infer<typeof QuestionSchema>

/**
 * One branch in the script. The script's opening question routes to
 * a branch by matching keywords in the user's answer; the branch
 * runs its `questions` in order, then ends.
 */
export const BranchSchema = z.object({
  /** Stable id; referenced by the routing rules. */
  id: z.string().regex(/^[a-z][a-z0-9_]*$/, {
    message: 'branch id must start with a lowercase letter; lowercase + digits + underscores only',
  }),
  /** Free-form description for operators reading the script. */
  description: z.string().optional(),
  /** Questions run in order. */
  questions: z.array(QuestionSchema).min(1),
})
export type Branch = z.infer<typeof BranchSchema>

/**
 * A routing rule from the opening question to a branch. The first
 * matching rule wins; if none match, the `default` branch runs.
 *
 * Match semantics: `if_keywords` is a list of substrings; if the
 * user's answer (lowercased) contains any of them, the rule fires.
 * Simple and predictable for v1; LLM-driven routing is a post-v1
 * polish per the locked Phase A decision.
 */
export const RoutingRuleSchema = z.object({
  if_keywords: z.array(z.string().min(1)).min(1),
  next_branch: z.string().min(1),
})
export type RoutingRule = z.infer<typeof RoutingRuleSchema>

/**
 * The full question script. The opening question runs first; its
 * answer routes to a branch. The chosen branch's questions run in
 * order. The interview ends after the last branch question; the LLM
 * then produces a summary that becomes part of the transcript.
 */
export const QuestionScriptSchema = z.object({
  /** Locked at 1 for v1; bumped via migrator chain when the format evolves. */
  script_schema_version: z.literal(1),
  /** Free-form name; helps the operator distinguish multiple scripts. */
  name: z.string().min(1),
  /** The first question shown. */
  opening: QuestionSchema,
  /** Routing rules evaluated against the opening answer. */
  routing: z.array(RoutingRuleSchema).default([]),
  /** Default branch run when no routing rule matches. */
  default_branch: z.string().min(1),
  /** All branches; one of them must be `default_branch`. */
  branches: z.array(BranchSchema).min(1),
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
  /** Carried from the question's `intent_tag`, if any. */
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
 */
export const InterviewTranscriptSchema = z.object({
  interview_schema_version: z.literal(1),
  /** The script's `name` field, snapshotted. */
  script_name: z.string().min(1),
  /** Branch that was chosen by the routing logic. */
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
 * Slug for the brain note the orchestrator (PR D) writes from the
 * transcript summary. Locked here so the same value is used by the
 * generator and the brain reader.
 */
export const ONBOARDING_NOTE_SLUG = 'continuity-from-onboarding'
