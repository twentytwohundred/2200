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
 *     (the default-v1.yaml script enforces this); if missing, the
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
}

/**
 * Translate a transcript into a HandoffDocument. Pure (modulo the
 * default `os.hostname()`); throws when the transcript lacks the
 * data the Identity layer needs.
 */
export function buildHandoffFromTranscript(args: BuildHandoffArgs): HandoffDocument {
  const t = args.transcript

  const agentName = findAnswerByTag(t, AGENT_NAME_TAG)
  if (agentName === undefined || agentName.trim().length === 0) {
    throw new Error(
      `interview transcript is missing an answer for intent_tag "${AGENT_NAME_TAG}"; the onboarding script must include this question in every branch`,
    )
  }
  const cleanName = normalizeAgentName(agentName)

  const agentType = stripBranchSuffix(t.chosen_branch)

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
