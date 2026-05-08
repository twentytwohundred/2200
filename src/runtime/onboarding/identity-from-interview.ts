/**
 * Translate an InterviewTranscript into a HandoffDocument
 * (Epic 14 Phase A PR C).
 *
 * The onboarding flow's bridge to Epic 5's migration substrate. Once
 * the transcript exists, we shape it as a HandoffDocument and pipe it
 * through Epic 5's `buildIdentityFromHandoff` ... the same code path
 * that registers a migrated Agent. This means an onboarded Agent and
 * a migrated Agent end up with the same Identity-file shape; the
 * difference is just provenance (where the body content came from).
 *
 * Extraction:
 *   - agent_name: the answer to the question whose intent_tag is
 *     'agent_name'. v1 expects the question to exist in every branch
 *     (the default-v2.yaml script enforces this); if missing, the
 *     translator throws ... a script without an agent_name question
 *     is an operator-fixable bug.
 *   - agent_type: derived from the chosen branch id ('email_agent_branch'
 *     → 'email_agent', 'project_agent_branch' → 'project_agent', etc.).
 *     Strips a trailing '_branch' suffix; if no suffix, uses the branch
 *     id verbatim.
 *   - identity.display_name: same as agent_name.
 *   - identity.notification_policy: defaulted to passive/normal/important
 *     (Identity loader applies the same default; we set explicitly so
 *     it round-trips to ts callers).
 *   - budget.daily_cap_usd: defaulted at the onboarding layer to a
 *     conservative $25/day. Operators adjust per Agent post-spawn via
 *     normal Identity edits.
 *   - brain.inline_notes: a single inline note carrying the LLM's
 *     summary as the continuity-from-onboarding seed.
 *   - provenance: source_system='2200_onboarding', source_host=os.hostname(),
 *     exported_at=transcript.finished_at.
 */
import { hostname } from 'node:os'
import { ONBOARDING_NOTE_SLUG, type InterviewTranscript } from './types.js'
import type { HandoffDocument } from '../migration/types.js'
import type { McpServerSpec } from '../identity/types.js'

const DEFAULT_DAILY_CAP_USD = 25
const AGENT_NAME_TAG = 'agent_name'

export interface BuildHandoffArgs {
  transcript: InterviewTranscript
  /**
   * Override hostname (useful for tests / non-default deployments).
   * Defaults to `os.hostname()`.
   */
  sourceHost?: string
  /**
   * Suggested MCP servers from the tool-suggester (Epic 14 PR C).
   * When provided, baked into the handoff's `mcp_servers[]` so the
   * orchestrator writes them into the Agent's Identity directly. The
   * operator still needs to set the env vars referenced by each
   * server's SecretRef before starting the Agent (until Epic 9 Phase B
   * automates OAuth credential capture).
   */
  mcpServers?: readonly McpServerSpec[]
  /**
   * Preferred LLM model for the new Agent. The onboarding flow
   * passes the picker's selection here so the new Agent's Identity
   * inherits the operator's choice rather than the hardcoded
   * default. Tier defaults to 'frontier' when only provider+model
   * are known.
   */
  model?: { tier?: 'frontier' | 'fast' | 'local'; provider: string; model_id: string }
}

/**
 * Translate a transcript into a HandoffDocument. Pure (modulo the
 * default `os.hostname()`); throws when the transcript lacks the
 * data the Identity layer needs.
 */
export function buildHandoffFromTranscript(args: BuildHandoffArgs): HandoffDocument {
  const t = args.transcript

  const agentNameRaw = findAnswerByTag(t, AGENT_NAME_TAG)
  // Soft fallback for v2 LLM-driven interviews: if the interviewer
  // never reached the agent_name goal (model timed out, forced
  // 'done' on a malformed directive, etc.), synthesize a name from
  // the opening answer so the spawn can still produce an Identity
  // the operator can rename later. The v1 (retired) scripts always
  // included an agent_name question, so this path didn't apply.
  const cleanName =
    agentNameRaw !== undefined && agentNameRaw.trim().length > 0
      ? normalizeAgentName(agentNameRaw)
      : synthesizeAgentName(t)

  // agent_type derivation:
  //   - v1 (scripted, retired): the chosen branch id mapped one-to-one
  //     ('email_agent_branch' → 'email_agent')
  //   - v2 (LLM-driven): chosen_branch is always 'llm_driven', which
  //     is a poor user-facing tag. Default to a generic 'agent'; the
  //     downstream 'humanizeAgentType' renders that as "agent" cleanly,
  //     and operators can edit the Identity post-spawn if they want a
  //     more specific role.
  const agentType = t.chosen_branch === 'llm_driven' ? 'agent' : stripBranchSuffix(t.chosen_branch)

  return {
    frontmatter: {
      handoff_schema_version: 1,
      agent_name: cleanName,
      agent_type: agentType,
      identity: {
        display_name: cleanName,
        notification_policy: {
          tiers_allowed: ['passive', 'normal', 'important'],
        },
      },
      brain: {
        inline_notes: [
          {
            title: 'Continuity from onboarding',
            slug: ONBOARDING_NOTE_SLUG,
            type: 'continuity',
            tags: ['onboarding', agentType],
            body: t.summary,
          },
        ],
      },
      budget: {
        daily_cap_usd: DEFAULT_DAILY_CAP_USD,
      },
      schedules: [],
      mcp_servers: args.mcpServers !== undefined ? [...args.mcpServers] : [],
      ...(args.model !== undefined
        ? {
            model: {
              tier: args.model.tier ?? ('frontier' as const),
              provider: args.model.provider,
              model_id: args.model.model_id,
            },
          }
        : {}),
      provenance: {
        source_system: '2200_onboarding',
        source_host: args.sourceHost ?? hostname(),
        exported_at: t.finished_at,
      },
    },
    body: t.summary,
    source_path: null,
  }
}

/**
 * Find the answer to the first question with the given intent_tag.
 * Returns undefined if no question carries that tag.
 */
function findAnswerByTag(t: InterviewTranscript, tag: string): string | undefined {
  for (const entry of t.entries) {
    if (entry.intent_tag === tag) return entry.answer
  }
  return undefined
}

/**
 * Strip a trailing '_branch' suffix from a branch id to derive an
 * agent_type tag. 'email_agent_branch' → 'email_agent'. 'freeform_branch'
 * → 'freeform'. A branch id without the suffix is returned verbatim.
 */
function stripBranchSuffix(branchId: string): string {
  return branchId.endsWith('_branch') ? branchId.slice(0, -'_branch'.length) : branchId
}

/**
 * Normalize a free-form name answer into a valid Agent name. Lowercases,
 * strips characters outside `[a-z0-9_-]`, collapses runs of separators,
 * and trims leading/trailing separators. The result must satisfy the
 * Identity's agent_name regex; if the cleanup leaves an empty string
 * (the user typed only special characters), throws.
 */
function normalizeAgentName(raw: string): string {
  const lowered = raw.toLowerCase().trim()
  const cleaned = lowered
    .replace(/[\s.]+/g, '-')
    .replace(/[^a-z0-9_-]+/g, '')
    .replace(/[-_]{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
  if (cleaned.length === 0 || !/^[a-z]/.test(cleaned)) {
    throw new Error(
      `agent_name "${raw}" cannot be normalized to a valid identifier (must start with a lowercase letter, then lowercase letters / digits / underscores / dashes only)`,
    )
  }
  return cleaned
}

/**
 * v2 fallback: derive an agent name from the opening answer when no
 * explicit agent_name turn was captured. Takes the first 24 chars of
 * the opening answer (or the first transcript entry's answer),
 * normalizes, and prefixes with 'agent-' if the result doesn't start
 * with a letter. The operator can rename in the preview before
 * confirming.
 */
function synthesizeAgentName(t: InterviewTranscript): string {
  const seed = (t.entries[0]?.answer ?? '').slice(0, 24).trim()
  if (seed.length > 0) {
    try {
      const normalized = normalizeAgentName(seed)
      // Cap length so unwieldy openings don't yield 24-char-prefix
      // names; 16 is comfortable for an Identity slug.
      return normalized.slice(0, 16)
    } catch {
      // fall through
    }
  }
  // Last-resort name: timestamp suffix keeps it unique enough that
  // re-spawning back-to-back doesn't collide.
  return `agent-${Date.now().toString(36).slice(-6)}`
}
