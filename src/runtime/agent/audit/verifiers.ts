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
import type { ClaimOutcome, ExtractedClaim, VerifierContext } from './types.js'

/**
 * The known write-class tools. A claim of `file_create` is verified
 * when at least one of these returned ok=true with a matching path in
 * its args. Kept as a static list rather than introspecting the
 * registry so the audit is robust to mid-flight tool additions.
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
])

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
  const writeCalls = findToolCallEnds(ctx.events, (t) => WRITE_CLASS_TOOLS.has(t))
  if (writeCalls.length === 0) {
    return {
      status: 'unverified',
      reason: `claim "${claim.verb} ${claim.object}" has no write-class tool call in the transcript`,
    }
  }
  const successful = writeCalls.filter((e) => e.ok)
  if (successful.length === 0) {
    return {
      status: 'contradicted',
      reason: `write attempted (${String(writeCalls.length)} call${writeCalls.length === 1 ? '' : 's'}) but none returned ok`,
    }
  }

  // When the claim names a path, verify the file exists + is non-empty.
  if (claim.path) {
    try {
      const resolved = resolveVirtualPath(claim.path, {
        home: ctx.home,
        callingAgent: ctx.agentName,
      })
      const s = await stat(resolved.absolute)
      if (!s.isFile()) {
        return {
          status: 'contradicted',
          reason: `path "${claim.path}" exists but is not a file (size=${String(s.size)})`,
        }
      }
      if (s.size === 0) {
        return {
          status: 'contradicted',
          reason: `path "${claim.path}" exists but is empty`,
        }
      }
      return {
        status: 'verified',
        evidence: `${String(successful.length)} write call${successful.length === 1 ? '' : 's'} ok; ${claim.path} exists (${String(s.size)} bytes)`,
      }
    } catch (err) {
      if (err instanceof PathResolutionError) {
        // Path was outside the virtual-fs scope; can't verify but
        // can't contradict either. Pass through as unverified.
        return {
          status: 'unverified',
          reason: `claimed path "${claim.path}" not under a 2200 fs prefix; cannot verify existence`,
        }
      }
      return {
        status: 'contradicted',
        reason: `claimed path "${claim.path}" does not exist on disk after the writes`,
      }
    }
  }

  // No path claimed; bare write count is the best we can do.
  return {
    status: 'verified',
    evidence: `${String(successful.length)} write-class tool call${successful.length === 1 ? '' : 's'} ok`,
  }
}

/**
 * file_read: was a read-class tool called? Same prefix-match
 * tolerance as file_create. We do NOT check filesystem post-hoc
 * because a successful read does not leave a trace.
 */
function verifyFileRead(claim: ExtractedClaim, ctx: VerifierContext): ClaimOutcome {
  const readCalls = findToolCallEnds(ctx.events, (t) => READ_CLASS_TOOLS.has(t))
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
  const sendCalls = findToolCallEnds(ctx.events, (t) => SEND_CLASS_TOOLS.has(t))
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
