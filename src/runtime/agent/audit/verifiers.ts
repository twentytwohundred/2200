/**
 * Per-category mechanical verifiers.
 *
 * Each verifier receives one ExtractedClaim plus a VerifierContext
 * (home, agent name, the tool transcript) and returns a ClaimOutcome.
 * They are deliberately mechanical ... no LLM calls happen here. The
 * upstream extractor uses the cheap model to parse the agent's message
 * into structured claims; this layer is the boring "does the evidence
 * match" pass.
 *
 * Resolvers are conservative on purpose. When the evidence channel
 * doesn't cover a verb (e.g. the agent claims to have called an
 * external service we don't have a transcript surface for), we
 * return `unverified` rather than `verified`. False-positive
 * `verified` flags would defeat the purpose of the audit.
 */
import { stat } from 'node:fs/promises'
import type { LoopEvent } from '../detectors/types.js'
import { resolveVirtualPath, PathResolutionError } from '../../storage/path-resolver.js'
import { CredentialRequestStore } from '../../credentials/requests.js'
import type { ClaimOutcome, ExtractedClaim, VerifierContext } from './types.js'

/**
 * The known write-class tools. A claim of `file_create` is verified
 * when at least one of these returned ok=true with a matching path in
 * its args. Kept as a static list rather than introspecting the
 * registry so the audit is robust to mid-flight tool additions.
 *
 * Skills can extend this set per-Agent via the overlay file at
 * `<home>/state/identities/<agent>/identity-audit-overlay.json` (see
 * `audit/overlay.ts`). The verifiers consult `ctx.toolClassOverlay`
 * alongside these constants ... the overlay is additive only.
 */
const WRITE_CLASS_TOOLS = new Set([
  'fs_write',
  'fs_append',
  'brain_write',
  'brain_write_shared',
  'identity_write',
])

const READ_CLASS_TOOLS = new Set([
  'fs_read',
  'fs_list',
  'brain_read',
  'brain_search',
  'brain_search_shared',
  'identity_read',
])

const SEND_CLASS_TOOLS = new Set([
  'pub_send',
  'pub_post_message',
  'chat_send',
  'notification_create',
  'slack_api',
  'discord_api',
  'task_create_for_agent',
  'http_request',
])

function isInClass(
  tool: string,
  baseline: Set<string>,
  ctx: VerifierContext,
  klass: string,
): boolean {
  if (baseline.has(tool)) return true
  if (ctx.toolClassOverlay?.[tool] === klass) return true
  return false
}

/** Dispatch on category. */
export async function verifyClaim(
  claim: ExtractedClaim,
  ctx: VerifierContext,
): Promise<ClaimOutcome> {
  switch (claim.category) {
    case 'file_create':
      return await verifyFileCreate(claim, ctx)
    case 'file_read':
      return verifyFileRead(claim, ctx)
    case 'external_send':
      return verifyExternalSend(claim, ctx)
    case 'tool_invoke':
      return verifyToolInvoke(claim, ctx)
    case 'process_count':
      return verifyProcessCount(claim, ctx)
    case 'refusal':
      return verifyRefusal(claim)
    case 'credential_request':
      return await verifyCredentialRequest(claim, ctx)
  }
}

/**
 * file_create: was a write-class tool called with a path matching the
 * claim's path? Optionally cross-checks the filesystem to confirm the
 * file ended up non-empty on disk. A successful tool call AND a
 * non-empty file = verified.
 *
 * Conservative on path matching: we accept exact match or one being a
 * prefix of the other (some tools take dir + filename separately and
 * we don't reassemble). When the claim has no path we can only verify
 * "some write happened" by counting write-class tool calls.
 */
async function verifyFileCreate(
  claim: ExtractedClaim,
  ctx: VerifierContext,
): Promise<ClaimOutcome> {
  const writeCalls = findToolCallEnds(ctx.events, (t) =>
    isInClass(t, WRITE_CLASS_TOOLS, ctx, 'file_create'),
  )
  const successful = writeCalls.filter((e) => e.ok)

  // The filesystem outranks the transcript.
  //
  // When the claim names a path, `stat` is direct evidence about the
  // exact thing claimed, and it is available regardless of what the
  // transcript shows. This check used to sit BELOW an early return for
  // "no write-class tool call", which meant the strongest evidence was
  // skipped in precisely the case it settles: an Agent that names a
  // file and never wrote one.
  //
  // That ordering had a real cost. Severity keys off status ...
  // `unverified` is passive, `contradicted` is important ... so a
  // fabricated file surfaced as a chip the operator was inclined to
  // dismiss rather than a notification. Field case: an Agent ran two
  // web searches, wrote nothing, reported "Created text file:
  // /project/trending_playlist.txt" with half the contents filled in as
  // bracketed placeholders, and the audit could only say "unverified".
  // The file was plainly absent; the audit had every means to say so.
  if (claim.path) {
    let resolvedAbsolute: string
    try {
      resolvedAbsolute = resolveVirtualPath(claim.path, {
        home: ctx.home,
        callingAgent: ctx.agentName,
      }).absolute
    } catch (err) {
      if (err instanceof PathResolutionError) {
        // Outside the virtual-fs scope, so existence is not checkable.
        // A successful write does NOT rescue this claim: the write that
        // succeeded may well have gone somewhere else entirely, and
        // "some file was written" is not evidence for "THIS file was
        // written". The only thing still worth asserting is the case
        // where every write failed.
        if (writeCalls.length > 0 && successful.length === 0) {
          return {
            status: 'contradicted',
            reason: `write attempted (${String(writeCalls.length)} call${writeCalls.length === 1 ? '' : 's'}) but none returned ok`,
          }
        }
        return {
          status: 'unverified',
          reason: `claimed path "${claim.path}" not under a 2200 fs prefix; cannot verify existence`,
        }
      }
      throw err
    }

    // `null` means absent. Any stat failure ... ENOENT, a broken
    // symlink, a permission error ... is treated the same way: we
    // cannot see the file the Agent named.
    const s = await stat(resolvedAbsolute).catch(() => null)

    if (s === null) {
      return {
        status: 'contradicted',
        reason:
          writeCalls.length === 0
            ? `claimed "${claim.verb} ${claim.object}" at "${claim.path}", but no write-class tool call was made and the file does not exist`
            : `claimed path "${claim.path}" does not exist on disk after the writes`,
      }
    }
    if (!s.isFile()) {
      return {
        status: 'contradicted',
        reason: `path "${claim.path}" exists but is not a file (size=${String(s.size)})`,
      }
    }
    if (s.size === 0) {
      return { status: 'contradicted', reason: `path "${claim.path}" exists but is empty` }
    }

    // The file is there and non-empty. Whether THIS task put it there
    // is a separate question: with no successful write in the
    // transcript the file may simply predate the task, so the claim is
    // unattributable rather than confirmed.
    if (successful.length === 0) {
      return {
        status: 'unverified',
        reason:
          writeCalls.length === 0
            ? `"${claim.path}" exists (${String(s.size)} bytes) but no write-class tool call was made in this task; cannot attribute it to this turn`
            : `"${claim.path}" exists (${String(s.size)} bytes) but no write call returned ok in this task`,
      }
    }
    return {
      status: 'verified',
      evidence: `${String(successful.length)} write call${successful.length === 1 ? '' : 's'} ok; ${claim.path} exists (${String(s.size)} bytes)`,
    }
  }

  return transcriptOnlyFileCreate(claim, writeCalls.length, successful.length, {})
}

/**
 * Fallback reasoning for a `file_create` claim the filesystem cannot
 * settle ... either no path was named or the named path is outside the
 * virtual-fs scope. Transcript evidence is all there is.
 */
function transcriptOnlyFileCreate(
  claim: ExtractedClaim,
  writeCount: number,
  successCount: number,
  opts: { pathNote?: string },
): ClaimOutcome {
  const suffix = opts.pathNote ? ` (${opts.pathNote})` : ''
  if (writeCount === 0) {
    return {
      status: 'unverified',
      reason: `claim "${claim.verb} ${claim.object}" has no write-class tool call in the transcript${suffix}`,
    }
  }
  if (successCount === 0) {
    return {
      status: 'contradicted',
      reason: `write attempted (${String(writeCount)} call${writeCount === 1 ? '' : 's'}) but none returned ok${suffix}`,
    }
  }
  return {
    status: 'verified',
    evidence: `${String(successCount)} write-class tool call${successCount === 1 ? '' : 's'} ok${suffix}`,
  }
}

/**
 * file_read: was a read-class tool called? Same prefix-match
 * tolerance as file_create. We do NOT check filesystem post-hoc
 * because a successful read does not leave a trace.
 */
function verifyFileRead(claim: ExtractedClaim, ctx: VerifierContext): ClaimOutcome {
  const readCalls = findToolCallEnds(ctx.events, (t) =>
    isInClass(t, READ_CLASS_TOOLS, ctx, 'file_read'),
  )
  if (readCalls.length === 0) {
    return {
      status: 'unverified',
      reason: `claim "${claim.verb} ${claim.object}" has no read-class tool call in the transcript`,
    }
  }
  const successful = readCalls.filter((e) => e.ok)
  if (successful.length === 0) {
    return {
      status: 'contradicted',
      reason: `read attempted (${String(readCalls.length)} call${readCalls.length === 1 ? '' : 's'}) but none returned ok`,
    }
  }
  return {
    status: 'verified',
    evidence: `${String(successful.length)} read-class tool call${successful.length === 1 ? '' : 's'} ok`,
  }
}

/**
 * external_send: was a send-class tool called? We cannot verify the
 * *content* of the message reached the recipient (no recipient-side
 * read receipt at v1), only that the agent dispatched.
 */
function verifyExternalSend(claim: ExtractedClaim, ctx: VerifierContext): ClaimOutcome {
  const sendCalls = findToolCallEnds(ctx.events, (t) =>
    isInClass(t, SEND_CLASS_TOOLS, ctx, 'external_send'),
  )
  if (sendCalls.length === 0) {
    return {
      status: 'unverified',
      reason: `claim "${claim.verb} ${claim.object}" has no send-class tool call in the transcript`,
    }
  }
  const successful = sendCalls.filter((e) => e.ok)
  if (successful.length === 0) {
    return {
      status: 'contradicted',
      reason: `send attempted (${String(sendCalls.length)} call${sendCalls.length === 1 ? '' : 's'}) but none returned ok`,
    }
  }
  return {
    status: 'verified',
    evidence: `${String(successful.length)} send-class tool call${successful.length === 1 ? '' : 's'} ok`,
  }
}

/**
 * tool_invoke: agent named a specific tool. Look for a tool_call_end
 * with that exact tool name and ok=true.
 */
function verifyToolInvoke(claim: ExtractedClaim, ctx: VerifierContext): ClaimOutcome {
  if (!claim.tool) {
    return {
      status: 'unverified',
      reason: `tool_invoke claim is missing the tool name; cannot verify`,
    }
  }
  const matching = findToolCallEnds(ctx.events, (t) => t === claim.tool)
  if (matching.length === 0) {
    return {
      status: 'contradicted',
      reason: `claim "called ${claim.tool}" but no tool_call_end for that tool in the transcript`,
    }
  }
  const successful = matching.filter((e) => e.ok)
  if (successful.length === 0) {
    return {
      status: 'contradicted',
      reason: `${claim.tool} called ${String(matching.length)}x; none returned ok`,
    }
  }
  return {
    status: 'verified',
    evidence: `${claim.tool}: ${String(successful.length)} ok / ${String(matching.length)} total`,
  }
}

/**
 * process_count: claim that a quantity was processed. Count successful
 * tool calls in the transcript and compare. Tolerance: ±1 to account
 * for fence-post counting differences.
 */
function verifyProcessCount(claim: ExtractedClaim, ctx: VerifierContext): ClaimOutcome {
  if (typeof claim.count !== 'number' || claim.count < 0) {
    return {
      status: 'unverified',
      reason: `process_count claim is missing or has non-numeric count`,
    }
  }
  const successful = findToolCallEnds(ctx.events, () => true).filter((e) => e.ok).length
  if (successful >= claim.count - 1 && successful <= claim.count + 1) {
    return {
      status: 'verified',
      evidence: `${String(successful)} successful tool call${successful === 1 ? '' : 's'} (claim: ${String(claim.count)})`,
    }
  }
  return {
    status: 'contradicted',
    reason: `claim said ${String(claim.count)}; transcript shows ${String(successful)} successful tool call${successful === 1 ? '' : 's'}`,
  }
}

/**
 * refusal: agent explicitly declined the task with a reason. Verified
 * by its own text ... refusal IS the action; no tool log needed. We
 * require a non-trivial reason (the verb + object together carry the
 * "why") so a vague "I refuse" without justification falls back to
 * unverified ... that ambiguity should kick back, asking the agent
 * to either commit to the refusal with a reason or take action.
 *
 * This is the safety valve for prompt injection (Doug 2026-05-14):
 * an Agent asked in a public pub to expose a credential should
 * refuse with reason; the audit recognizes it; severity stays
 * silent; the kick-back loop never fires. The agent's safety
 * training is honored, not overridden by audit coercion.
 */
function verifyRefusal(claim: ExtractedClaim): ClaimOutcome {
  const reason = claim.reason ?? claim.object
  if (!reason || reason.trim().length < 8) {
    return {
      status: 'unverified',
      reason:
        'refusal claim has no clear reason; restate as "I refuse: <reason>" so the operator can act',
    }
  }
  return {
    status: 'verified',
    evidence: `policy refusal recognized: "${claim.verb} ${reason.slice(0, 120)}"`,
  }
}

/**
 * credential_request: the agent claims to have asked the operator for a
 * credential via `credential_request` (decision:
 * 2026-05-14-request-credential-substrate). The audit consults the
 * request ledger ... the substrate's source-of-truth for who-asked-for-
 * what. Verified when at least one record exists from this agent
 * matching the claimed credential_name (in ANY state ... the request
 * was made; outcome is the operator's choice and surfaces separately).
 *
 * Without a credential_name in the claim, we can only verify "some
 * request was issued" by counting records from this agent in the
 * current task's window. That weaker form is unverified unless the
 * count is non-zero.
 *
 * Cross-Agent forgery is structurally impossible: the request record's
 * `agent` field is set from the calling loop's identity, not tool
 * args, so an agent can't fabricate a record that appears to come from
 * a different agent. The audit only matches records where
 * `rec.agent === ctx.agentName`.
 */
async function verifyCredentialRequest(
  claim: ExtractedClaim,
  ctx: VerifierContext,
): Promise<ClaimOutcome> {
  const store = new CredentialRequestStore(ctx.home)
  let records
  try {
    records = await store.list({ agent: ctx.agentName })
  } catch (err) {
    return {
      status: 'unverified',
      reason: `could not read credential-request ledger: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (claim.credential_name) {
    const match = records.find((r) => r.credential_name === claim.credential_name)
    if (match) {
      return {
        status: 'verified',
        evidence: `credential request ${match.id} (state=${match.state}) found for ${claim.credential_name}`,
      }
    }
    return {
      status: 'unverified',
      reason: `no credential_request record from ${ctx.agentName} for "${claim.credential_name}"`,
    }
  }
  if (records.length === 0) {
    return {
      status: 'unverified',
      reason: `claim "${claim.verb} ${claim.object}" has no credential_request record from ${ctx.agentName}`,
    }
  }
  return {
    status: 'verified',
    evidence: `${String(records.length)} credential request record${records.length === 1 ? '' : 's'} from ${ctx.agentName} (most recent: ${records.at(-1)?.id ?? '?'})`,
  }
}

// ── Internals ─────────────────────────────────────────────────────────────

function findToolCallEnds(
  events: readonly LoopEvent[],
  predicate: (tool: string) => boolean,
): Extract<LoopEvent, { kind: 'tool_call_end' }>[] {
  const out: Extract<LoopEvent, { kind: 'tool_call_end' }>[] = []
  for (const ev of events) {
    if (ev.kind === 'tool_call_end' && predicate(ev.tool)) {
      out.push(ev)
    }
  }
  return out
}
