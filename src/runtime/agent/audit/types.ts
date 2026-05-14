/**
 * Shared types for the claim-vs-evidence audit pass.
 *
 * Doug's call (2026-05-14): "if an Agent says they did something, they
 * need to have done it." Belt-and-suspenders verification for every
 * Agent in the fleet; especially load-bearing for the cheaper models
 * where hallucinated narration of work-not-done is most common.
 *
 * Pipeline (see `claim-evidence.ts` for the orchestrator):
 *   1. Cheap-model LLM extracts declarative claims from the agent's
 *      final reply into a fixed 5-verb taxonomy.
 *   2. Per-category verifiers cross-reference each claim against the
 *      tool transcript + filesystem state + pub message stream.
 *   3. Each claim resolves to `verified | unverified | contradicted`.
 *   4. The pass aggregates a severity and writes the brain log,
 *      inbox notification, and inline chat audit card.
 */
import type { LoopEvent } from '../detectors/types.js'

/**
 * The locked verb taxonomy. Every claim the extractor returns must
 * belong to exactly one of these categories. Verifiers are matched
 * 1:1 to the category so the runtime knows which evidence channel
 * to consult.
 *
 * Why a closed taxonomy: open-ended "the agent said something" is a
 * regex-on-prose problem the cheap model is bad at. A closed taxonomy
 * lets us prompt the extractor for a JSON schema match and reject
 * anything outside it.
 */
export type ClaimCategory =
  /** "I wrote / saved / created X" where X is a file or external resource. */
  | 'file_create'
  /** "I read / loaded / opened X" ... informs the agent's downstream claims. */
  | 'file_read'
  /**
   * "I sent / posted / broadcast X to Y" ... covers pub messages,
   * notifications, emails, Slack/Discord posts, any outbound action
   * with an external recipient.
   */
  | 'external_send'
  /**
   * "I called / ran / invoked tool X" ... explicit tool name in the
   * claim. Verifier looks for a `tool_call_end` with `ok: true` for
   * that tool in the transcript.
   */
  | 'tool_invoke'
  /**
   * "I checked / processed / found N items" ... claim about a quantity.
   * Verifier counts matching tool calls in the transcript.
   */
  | 'process_count'
  /**
   * "I refuse / I cannot / I will not + reason" ... an explicit policy
   * refusal. Distinct from a vague "I didn't do it" because it
   * carries a reason (the agent is asserting a guideline violation,
   * not just acknowledging incompletion). Verified by the text
   * itself ... no tool log needed; refusal IS the action.
   *
   * This category exists specifically so the kick-back loop can't
   * coerce an agent into overriding its safety training. When the
   * audit recognizes a structured refusal, severity stays silent
   * and the task ends in the REFUSED state. The operator sees a
   * refusal note in the chat, not a fabricated success.
   *
   * Defense against prompt injection in public pubs (Doug 2026-05-14):
   * an adversary asking an Agent to expose a credential should
   * encounter a refusal that the audit recognizes and accepts ...
   * never a coercion path that forces the agent to comply.
   */
  | 'refusal'

/**
 * A single claim extracted from the agent's final reply. The extractor
 * is required to populate `category`, `verb`, and `object`; the
 * structured fields are populated when the category demands them.
 */
export interface ExtractedClaim {
  category: ClaimCategory
  /** Surface verb the agent used ("created", "saved", "pushed", "refuse"). */
  verb: string
  /** Object of the verb ("the cover image", "/shared/vault/keys/simon.pub"). */
  object: string
  /** Populated for file_create / file_read. Virtual or absolute path. */
  path?: string
  /** Populated for process_count. */
  count?: number
  /** Populated for tool_invoke. Specific tool name the agent named. */
  tool?: string
  /** Populated for external_send. Pub name, channel, recipient. */
  target?: string
  /** Populated for refusal. Operator-readable reason the agent declined. */
  reason?: string
}

/**
 * Outcome of verifying one claim against the tool transcript +
 * filesystem state. `evidence` (verified) and `reason` (un/contra)
 * are operator-readable strings that surface in the inbox + chat
 * card.
 */
export type ClaimOutcome =
  | { status: 'verified'; evidence: string }
  | { status: 'unverified'; reason: string }
  | { status: 'contradicted'; reason: string }

/** Outcome paired with the claim it audited. */
export interface ClaimAuditRecord {
  claim: ExtractedClaim
  outcome: ClaimOutcome
}

/**
 * Severity tier the audit pass maps to for the inbox notification +
 * chat card emphasis. The mapping:
 *   - all verified → silent (brain log only; no notification)
 *   - any unverified on a non-destructive task → passive
 *   - any unverified on a destructive task → normal
 *   - any contradicted → important (and always renders the inline card)
 */
export type AuditSeverity = 'silent' | 'passive' | 'normal' | 'important'

/** Aggregate result of one audit pass. Consumed by AgentProcess. */
export interface ClaimEvidenceAuditResult {
  /** One record per extracted claim. */
  records: ClaimAuditRecord[]
  severity: AuditSeverity
  /** Short one-line summary for the inbox + chat card header. */
  summary: string
  /** Was the audited task destructive? Threads through to severity. */
  destructive: boolean
}

/**
 * Reasons a claim was deemed unverifiable; helpful in the audit log
 * and operator inbox so the operator can act (or update guidance).
 */
export interface VerifierContext {
  /** 2200_HOME root. Verifiers need it to check filesystem state. */
  home: string
  /** Agent under audit. */
  agentName: string
  /** The transcript of tool calls + their outcomes. */
  events: readonly LoopEvent[]
}
