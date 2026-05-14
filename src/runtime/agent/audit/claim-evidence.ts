/**
 * Claim-vs-evidence audit pass (orchestrator).
 *
 * Doug's mandate (2026-05-14): "if an Agent says they did something,
 * they need to have done it." Belt-and-suspenders verification for the
 * whole fleet ... lesser models are the primary target since they
 * hallucinate narration most often, but the pass runs on every Agent
 * so an operator never has to trust narration without backing.
 *
 * Pipeline:
 *   1. extractClaims (cheap-model LLM, structured-output)
 *   2. verifyClaim per claim (mechanical, no LLM)
 *   3. aggregate severity (silent / passive / normal / important)
 *
 * The pass returns a `ClaimEvidenceAuditResult` to the AgentProcess.
 * Downstream effects (brain log append, inbox notification, chat
 * inline card, WS event) are handled by AgentProcess based on the
 * severity ... this module is pure data in / data out plus the LLM
 * + filesystem side effects of the extractor / verifier.
 *
 * Failure mode: if the cheap-model call fails or the operator hasn't
 * configured a provider, the extractor returns []. The audit then
 * reports `silent` and writes a "no claims extracted" brain log line.
 * The task pipeline is never blocked by an audit failure.
 */
import type { LLMProvider } from '../../llm/provider.js'
import type { LoopEvent } from '../detectors/types.js'
import { extractClaims } from './claim-extractor.js'
import type { AuditSeverity, ClaimAuditRecord, ClaimEvidenceAuditResult } from './types.js'
import { verifyClaim } from './verifiers.js'
import { loadAuditOverlay } from './overlay.js'

export interface RunClaimEvidenceAuditArgs {
  /** 2200_HOME. */
  home: string
  /** Agent under audit. */
  agentName: string
  /** Final assistant message body that the agent ended the task with. */
  finalMessage: string
  /** Whether the audited task was idempotency=destructive. */
  destructive: boolean
  /** Full loop event log for the task. */
  events: readonly LoopEvent[]
  /** Cheap-model LLM provider for claim extraction. */
  provider: LLMProvider
  /** Model id for the cheap-model call. */
  modelId: string
  /**
   * Optional warning sink for non-fatal failures inside the
   * extraction pass. Lets the caller surface "audit was attempted
   * but the cheap-model call failed / parsed empty" without an
   * exception bubble.
   */
  onWarn?: (reason: string, details?: Record<string, unknown>) => void
}

/**
 * Run the audit pass. Always returns a result (never throws); failure
 * to extract / verify degrades to `silent` so the caller can keep the
 * task flow moving.
 */
export async function runClaimEvidenceAudit(
  args: RunClaimEvidenceAuditArgs,
): Promise<ClaimEvidenceAuditResult> {
  const claims = await extractClaims({
    body: args.finalMessage,
    provider: args.provider,
    modelId: args.modelId,
    ...(args.onWarn ? { onWarn: args.onWarn } : {}),
  })

  if (claims.length === 0) {
    return {
      records: [],
      severity: 'silent',
      summary: 'no factual claims extracted from the final reply',
      destructive: args.destructive,
    }
  }

  // Per-Agent tool-class overlay (skill-installed audit hints). One read
  // per audit pass; merged into the verifier's class predicates so
  // newly-installed skill tools classify correctly without per-tool
  // wiring in verifiers.ts.
  let toolClassOverlay: Record<string, string> = {}
  try {
    toolClassOverlay = await loadAuditOverlay(args.home, args.agentName)
  } catch (err) {
    args.onWarn?.(`audit overlay load failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  const records: ClaimAuditRecord[] = []
  for (const claim of claims) {
    try {
      const outcome = await verifyClaim(claim, {
        home: args.home,
        agentName: args.agentName,
        events: args.events,
        toolClassOverlay,
      })
      records.push({ claim, outcome })
    } catch (err) {
      // A verifier blew up. Surface as unverified rather than silently
      // dropping the claim ... the operator should know the audit
      // pipeline itself is failing.
      records.push({
        claim,
        outcome: {
          status: 'unverified',
          reason: `verifier error: ${err instanceof Error ? err.message : String(err)}`,
        },
      })
    }
  }

  const severity = aggregateSeverity(records, args.destructive)
  const summary = composeSummary(records, severity)

  return {
    records,
    severity,
    summary,
    destructive: args.destructive,
  }
}

/**
 * Severity mapping:
 *   - all verified           → silent
 *   - any unverified, non-destructive → passive
 *   - any unverified, destructive     → normal
 *   - any contradicted                → important
 *
 * Contradicted always escalates above unverified; one contradicted
 * claim is enough to flip the whole turn to important.
 */
function aggregateSeverity(
  records: readonly ClaimAuditRecord[],
  destructive: boolean,
): AuditSeverity {
  let hasContradicted = false
  let hasUnverified = false
  for (const r of records) {
    if (r.outcome.status === 'contradicted') hasContradicted = true
    else if (r.outcome.status === 'unverified') hasUnverified = true
  }
  if (hasContradicted) return 'important'
  if (hasUnverified) return destructive ? 'normal' : 'passive'
  return 'silent'
}

function composeSummary(records: readonly ClaimAuditRecord[], severity: AuditSeverity): string {
  const verified = records.filter((r) => r.outcome.status === 'verified').length
  const unverified = records.filter((r) => r.outcome.status === 'unverified').length
  const contradicted = records.filter((r) => r.outcome.status === 'contradicted').length
  if (severity === 'silent' && records.length > 0) {
    return `${String(verified)} of ${String(records.length)} claims verified`
  }
  if (severity === 'silent') return 'no factual claims extracted'
  const parts: string[] = []
  if (contradicted > 0) parts.push(`${String(contradicted)} contradicted`)
  if (unverified > 0) parts.push(`${String(unverified)} unverified`)
  if (verified > 0) parts.push(`${String(verified)} verified`)
  return parts.join(' · ')
}
