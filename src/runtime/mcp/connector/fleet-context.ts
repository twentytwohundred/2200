/**
 * Fleet orientation packet for the `get_fleet_context` tool.
 *
 * Builds a small, structured summary an MCP client (Grok in
 * particular) can pass through into its own conversation so the
 * fleet's current shape is on hand for the next minute of dialogue.
 *
 * Deliberately small. The Phase 1 lock calls this "light"; the rich
 * standing-brief layer is PR 3 territory. The aim here is: an
 * operator returning to a Grok conversation after a long gap sees
 * enough of the fleet to continue without losing the thread.
 */
import { BrainStore } from '../../brain/store.js'
import { listNotifications } from '../../notifications/reader.js'
import type { StateSnapshotResult } from '../../control-plane/protocol.js'

export interface FleetContextDeps {
  home: string
  snapshot: () => Promise<StateSnapshotResult> | StateSnapshotResult
  /**
   * Wall-clock for "served at" stamping; useful in tests so the
   * packet is deterministic.
   */
  now?: () => Date
}

export interface FleetContextAgentSummary {
  name: string
  state: string
  current_task_id: string | null
  last_heartbeat: string | null
}

export interface FleetContextThreadSummary {
  slug: string
  display_name: string
  primary_agent: string | null
  contribution_count: number
  last_contribution_at: string | null
}

export interface FleetContextActivitySummary {
  ts: string
  tier: string
  agent: string
  kind: string
}

export interface FleetContextPacket {
  schema_version: 1
  served_at: string
  agents: FleetContextAgentSummary[]
  threads: FleetContextThreadSummary[]
  recent_activity: FleetContextActivitySummary[]
}

const MAX_AGENTS = 10
const MAX_THREADS = 10
const MAX_RECENT_ACTIVITY = 5

export async function buildFleetContext(deps: FleetContextDeps): Promise<FleetContextPacket> {
  const now = deps.now?.() ?? new Date()
  const snapshot = await deps.snapshot()

  const agents: FleetContextAgentSummary[] = Object.values(snapshot.agents)
    .slice(0, MAX_AGENTS)
    .map((a) => ({
      name: a.name,
      state: a.state,
      current_task_id: a.current_task_id,
      last_heartbeat: a.last_heartbeat,
    }))

  const threads: FleetContextThreadSummary[] = await listResearchThreads(deps.home)

  const recent_activity: FleetContextActivitySummary[] = await listRecentActivity(deps.home)

  return {
    schema_version: 1,
    served_at: now.toISOString(),
    agents,
    threads: threads.slice(0, MAX_THREADS),
    recent_activity: recent_activity.slice(0, MAX_RECENT_ACTIVITY),
  }
}

async function listResearchThreads(home: string): Promise<FleetContextThreadSummary[]> {
  const store = BrainStore.forShared(home)
  const notes = await store.list({ tag: 'research-thread', limit: MAX_THREADS * 2 })
  return notes
    .map((note) => {
      const extras = note.extras
      // Strip the `research-` prefix we mint in contributions.ts to
      // surface the bare thread name to consumers.
      const bareSlug = note.slug.startsWith('research-')
        ? note.slug.slice('research-'.length)
        : note.slug
      const displayName =
        (typeof extras['display_name'] === 'string' ? extras['display_name'] : null) ?? bareSlug
      const primaryAgent =
        typeof extras['primary_agent'] === 'string' ? extras['primary_agent'] : null
      const contributionCount =
        typeof extras['contribution_count'] === 'number' ? extras['contribution_count'] : 0
      const lastContributionAt =
        typeof extras['last_contribution_at'] === 'string' ? extras['last_contribution_at'] : null
      return {
        slug: bareSlug,
        display_name: displayName,
        primary_agent: primaryAgent,
        contribution_count: contributionCount,
        last_contribution_at: lastContributionAt,
      }
    })
    .sort((a, b) => {
      if (a.last_contribution_at === null && b.last_contribution_at === null) return 0
      if (a.last_contribution_at === null) return 1
      if (b.last_contribution_at === null) return -1
      return b.last_contribution_at.localeCompare(a.last_contribution_at)
    })
}

async function listRecentActivity(home: string): Promise<FleetContextActivitySummary[]> {
  // Recent operator-visible (non-passive) and selected passive Inbox
  // events. The Inbox is the canonical record of "what happened" in
  // the fleet over short windows; the connector layer's own
  // call_received events would dominate this without filtering, so
  // we exclude passive-tier audit events and surface only the kinds
  // a returning operator probably wants to know about.
  const notes = await listNotifications(home, { tier: ['normal', 'important', 'critical'] })
  return notes
    .slice(-MAX_RECENT_ACTIVITY * 4) // hand a small window to the post-filter sort
    .map((n) => ({
      ts: n.frontmatter.ts,
      tier: n.frontmatter.tier,
      agent: n.frontmatter.agent,
      kind: n.frontmatter.kind,
    }))
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, MAX_RECENT_ACTIVITY)
}
