/**
 * Incomplete-turn detection.
 *
 * The loop already catches two shapes of "agent stopped without
 * delivering": empty response (no text, no tool calls) and pub-wake
 * with no `pub_send`/`pub_react`. This module adds the third shape ...
 * **planning-only** ... where the model produced visible text that
 * promises action but did not call any tools to perform that action.
 *
 * The classic failure: operator asks "what's the status?", model
 * answers "I'll check the brain notes and report back" with zero tool
 * calls, the loop sees text + no tool calls and treats the turn as a
 * clean termination. The operator receives prose, not an answer.
 *
 * The pattern was independently solved by Anthropic's Claude Code
 * runtime, which validated the structural approach: detect the
 * promise-without-action pattern at the end of a model turn and inject
 * a re-prompt that forces action on the next iteration. The
 * `[[../../wiki/decisions/2026-05-12-incomplete-turn-detector]]`
 * record covers context, scope, and what's out of scope.
 *
 * **What this catches:**
 *   - Pure planning-only: visible text matches the promise pattern,
 *     no tool calls fired this turn, the user's last message looks
 *     actionable.
 *
 * **What this does NOT catch:**
 *   - Partial hallucination: some tools fired, but the model narrated
 *     more completion than tools actually performed. Yesterday's
 *     19:24 Studio conversation rides through this gap because the
 *     mutating-tool guard and the completion-regex guard both
 *     independently disqualify it from planning-only. That case
 *     needs claim-vs-evidence semantic mapping, not pattern matching.
 *     Tracked for v1.x.
 *   - Wrong-tool hallucination, citation hallucination, pure-task
 *     Q&A fabrications. Same root cause as partial; same v1.x.
 *
 * **Guards (any of these returns null):**
 *   - The user's last message wasn't actionable (e.g., casual chat,
 *     pure ack). Avoids firing on small talk.
 *   - The visible text claims completion (`done`, `finished`,
 *     `implemented`, etc.). The agent might be wrong, but that's
 *     post-hoc verification, not in-loop retry.
 *   - Any tool call has already succeeded in this task (prior turns).
 *     Mirrors OC's cumulative side-effects guard ... once mutations
 *     are landed, retrying with "act now" risks the model duplicating
 *     committed work. The model can still iterate; we just don't
 *     re-prompt at loop-level.
 *
 * **Retry budget:** 3, per task. After 3 failed retries the loop
 * surfaces the turn as an `incomplete_turn_retries_exhausted` failure.
 *
 * **No code-lift from OpenClaw.** The regexes, instruction strings,
 * and module shape are written from the structural understanding of
 * the pattern documented in the decision record. Every line is ours.
 */

/**
 * Promise pattern: future-tense action language that signals the
 * model intends to do something but the current turn isn't doing it.
 * Calibrated against the failure-mode log entries in session 17 and
 * the pre-existing system-prompt convention notes.
 */
const PROMISE_RE =
  /\b(?:i(?:'ll| will)|let me|i(?:'m| am)\s+going to|i can do that|first[, ]+i(?:'ll| will)|next[, ]+i(?:'ll| will)|then[, ]+i(?:'ll| will))\b/i

/**
 * Completion pattern: past-tense verbs claiming the work has already
 * happened. When this fires, planning-only retry is suppressed: the
 * model may be wrong, but that's the partial-hallucination case and
 * out of scope here. `auditNarratedCompletion` handles the extreme
 * version (destructive task with zero successful tool calls).
 */
const COMPLETION_RE =
  /\b(?:done|finished|completed|implemented|updated|fixed|changed|wrote|created|built|deployed|ran|verified|found|sent|posted|delivered|here(?:'s| is)\s+(?:what|the))\b/i

/**
 * Action-verb pattern: forward-looking work language that has to
 * appear alongside a promise to count as planning-only. Without this,
 * "I'll be honest with you" or "I will say that ..." would falsely
 * trigger the resolver. Calibrated against tool-categories the agents
 * actually use.
 */
const ACTION_VERB_RE =
  /\b(?:check|read|search|find|look|investigate|inspect|debug|fix|patch|update|change|edit|write|implement|run|test|verify|review|analy(?:s|z)e|summari(?:s|z)e|explain|answer|show|share|report|prepare|deploy|restart|capture|delegate|ask|message|send|post|chat)\b/i

/**
 * Structured-plan heading: when the model produces a "Plan:" or
 * "Steps:" heading with bullet lines, treat that as planning-only
 * even without an explicit promise verb.
 */
const PLAN_HEADING_RE = /^(?:plan|steps?|next steps?|next up)\s*:/im
const BULLET_RE = /^(?:[-*•]\s+|\d+[.)]\s+)/m

/**
 * Actionable-prompt pattern on the user's last message. If the user
 * didn't ask for anything ("ok", "thanks", "sounds good"), retrying
 * a planning-only response would be wrong ... the model is allowed
 * to end the conversation. Mirrors OC's user-prompt-actionable gate.
 */
const ACTIONABLE_DIRECTIVE_RE =
  /^\s*(?:please\s+)?(?:check|look|read|write|edit|update|fix|investigate|debug|run|search|find|implement|add|remove|refactor|explain|summari(?:s|z)e|analy(?:s|z)e|review|tell|show|make|restart|deploy|prepare|do|build|ship|delegate|ask|message|send|post)\b/i
const ACTIONABLE_REQUEST_RE = /\b(?:can|could|would|will)\s+you\b|\b(?:please|pls)\b|\?\s*$/i

/** Max visible-text length we'll consider for planning-only. Above this the response is probably a real long answer with planning prose mixed in. */
const MAX_PLANNING_TEXT_LENGTH = 700

/** Retry budget shared by the new planning-only path and (post-bump) the existing empty-response + pub-wake nudges. */
export const DEFAULT_INCOMPLETE_TURN_RETRY_BUDGET = 3

/** The directive injected into history on planning-only retry. The exact phrasing closes the loophole where the model can "re-plan" instead of acting. */
export const PLANNING_ONLY_RETRY_INSTRUCTION =
  'Your previous turn described work without performing it ... no tool calls were dispatched. Do not restate the plan. Take the first concrete tool action now. If a real blocker prevents action, reply with the exact blocker in one sentence.'

export interface PlanningOnlyResolveInput {
  /** The visible text the model produced in the last turn. */
  assistantText: string
  /** The user's most recent message body (task body or chat content). */
  lastUserMessage: string
  /** True if any prior iteration in this task dispatched at least one successful tool call. */
  priorToolCallsSucceeded: boolean
}

/**
 * Returns the planning-only retry instruction string when the input
 * matches the pattern, or null otherwise. Pure function; no side
 * effects. The loop is responsible for budget tracking and history
 * mutation.
 */
export function resolvePlanningOnlyRetry(input: PlanningOnlyResolveInput): string | null {
  const text = input.assistantText.trim()
  if (text.length === 0 || text.length > MAX_PLANNING_TEXT_LENGTH) {
    return null
  }

  if (text.includes('```')) {
    return null
  }

  if (input.priorToolCallsSucceeded) {
    return null
  }

  if (!isActionableUserMessage(input.lastUserMessage)) {
    return null
  }

  if (COMPLETION_RE.test(text)) {
    return null
  }

  const hasStructuredPlan = PLAN_HEADING_RE.test(text) && BULLET_RE.test(text)
  const hasPromiseAndAction = PROMISE_RE.test(text) && ACTION_VERB_RE.test(text)

  if (!hasStructuredPlan && !hasPromiseAndAction) {
    return null
  }

  return PLANNING_ONLY_RETRY_INSTRUCTION
}

/**
 * True if the user's message looks like a request for action or an
 * answer. False for pure acknowledgements ("ok", "thanks") and casual
 * chatter that the model is allowed to end without further work.
 */
export function isActionableUserMessage(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return false
  }
  if (ACTIONABLE_DIRECTIVE_RE.test(trimmed)) {
    return true
  }
  if (ACTIONABLE_REQUEST_RE.test(trimmed)) {
    return true
  }
  return false
}
