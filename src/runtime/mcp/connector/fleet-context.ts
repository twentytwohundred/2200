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
import { readBrief, briefSlug } from './synthesis.js'
import { resolveCallingEmbassy } from './embassy/routing.js'
import { buildShelfPreview, type ShelfPreview } from './embassy/surfacing.js'

export interface FleetContextDeps {
  home: string
  snapshot: () => Promise<StateSnapshotResult> | StateSnapshotResult
  /**
   * OAuth client_id of the inbound call. Determines `shelf_preview`
   * embassy lookup + `self_reflected` detection. Null for static-
   * bearer callers (no embassy + no self_reflected).
   */
  callingClientId?: string | null
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
  /** First ~500 chars of the synthesized brief, or null if no brief exists yet. */
  brief_excerpt: string | null
  /** ISO timestamp the brief is "current as of"; null if no brief yet. */
  brief_synthesized_through: string | null
  /** True iff `synthesized_through < last_contribution_at`. */
  brief_stale: boolean
  /** True iff three consecutive synthesis failures have blocked the thread. */
  brief_blocked: boolean
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
  /**
   * Shelf preview for the calling embassy (PR-B4). Omitted entirely
   * when the caller is not bound to a registered conduit (static-
   * bearer callers or unregistered OAuth clients). Bounded to 10
   * inline items + a `next_priority_ids` long-tail list per spec
   * section 7.
   */
  shelf_preview?: ShelfPreview
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

  // Shelf preview (PR-B4). Look up the calling embassy via the
  // routing helper; null result → omit `shelf_preview` from the
  // response entirely (vs returning an empty block — keeps the
  // packet compact for static-bearer / unregistered callers).
  const callingClientId = deps.callingClientId ?? null
  const embassy = await resolveCallingEmbassy(deps.home, callingClientId)
  const shelf_preview =
    embassy !== null
      ? await buildShelfPreview(deps.home, embassy.embassyAgent, callingClientId)
      : null

  const packet: FleetContextPacket = {
    schema_version: 1,
    served_at: now.toISOString(),
    agents,
    threads: threads.slice(0, MAX_THREADS),
    recent_activity: recent_activity.slice(0, MAX_RECENT_ACTIVITY),
  }
  if (shelf_preview !== null) packet.shelf_preview = shelf_preview
  return packet
}

async function listResearchThreads(home: string): Promise<FleetContextThreadSummary[]> {
  const store = BrainStore.forShared(home)
  const notes = await store.list({ tag: 'research-thread', limit: MAX_THREADS * 2 })
  // The brief sibling note also carries `research-thread`; filter to
  // anchors only (the brief is additionally tagged `standing-brief`).
  const anchors = notes.filter((n) => !n.frontmatter.tags.includes('standing-brief'))
  const summaries: FleetContextThreadSummary[] = []
  for (const note of anchors) {
    const extras = note.extras
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
    const synthesizedThrough =
      typeof extras['synthesized_through'] === 'string' ? extras['synthesized_through'] : null
    const blocked =
      typeof extras['synthesis_blocked'] === 'boolean' ? extras['synthesis_blocked'] : false
    const brief = await readBrief(home, bareSlug)
    const briefExcerpt =
      brief === null
        ? null
        : brief.body.length <= BRIEF_EXCERPT_CHARS
          ? brief.body
          : brief.body.slice(0, BRIEF_EXCERPT_CHARS) +
            '\n\n...(truncated; call get_research_brief for full text)'
    const stale =
      synthesizedThrough === null
        ? lastContributionAt !== null
        : lastContributionAt !== null && synthesizedThrough < lastContributionAt
    summaries.push({
      slug: bareSlug,
      display_name: displayName,
      primary_agent: primaryAgent,
      contribution_count: contributionCount,
      last_contribution_at: lastContributionAt,
      brief_excerpt: briefExcerpt,
      brief_synthesized_through: synthesizedThrough,
      brief_stale: stale,
      brief_blocked: blocked,
    })
  }
  return summaries.sort((a, b) => {
    if (a.last_contribution_at === null && b.last_contribution_at === null) return 0
    if (a.last_contribution_at === null) return 1
    if (b.last_contribution_at === null) return -1
    return b.last_contribution_at.localeCompare(a.last_contribution_at)
  })
}

const BRIEF_EXCERPT_CHARS = 500

export { briefSlug }

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
