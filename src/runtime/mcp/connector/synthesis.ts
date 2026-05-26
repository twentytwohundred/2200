/**
 * Standing-brief read/write helpers (PR 3 / Phase 1 synthesis layer).
 *
 * The chronological contribution log lives at
 * `<shared>/brain/research-<slug>.md` (PR 2). The synthesized
 * standing brief lives in a sibling note at
 * `<shared>/brain/research-<slug>-brief.md`. The two-file model
 * keeps the surfaces clean:
 *
 *   - Log file is append-only (each contribute_to_thread adds a
 *     `## <ISO ts>` section).
 *   - Brief file is full-rewrite each time the primary Agent
 *     re-synthesizes the thread.
 *
 * Provenance (per Grok review, 2026-05-23) lives in the brief
 * note's frontmatter — `synthesized_through`, `contribution_count`,
 * `contribution_first_at`, `contribution_last_at`,
 * `contributor_sources` — so the operator always has a machine-
 * readable record of what was synthesized, regardless of how well
 * the brief body itself cites its sources.
 */
import { BrainStore } from '../../brain/store.js'

export const BRIEF_SCHEMA_VERSION = 1
export const BRIEF_TAGS = ['research-thread', 'standing-brief']

export interface BriefProvenance {
  /** Schema version of this provenance block. */
  brief_schema_version: 1
  /** Thread slug (bare, without the `research-` prefix). */
  source_thread: string
  /** Thread's `pending_synthesis_at` at the moment synthesis started — what this brief is "current as of". */
  synthesized_through: string
  /** Number of chronological contributions that produced this brief. */
  contribution_count: number
  /** ISO timestamp of the earliest contribution. */
  contribution_first_at: string | null
  /** ISO timestamp of the latest contribution synthesized in. */
  contribution_last_at: string | null
  /** Distinct sources that contributed (e.g., `["mcp-connector"]`). */
  contributor_sources: string[]
  /** Synthesizing Agent. */
  synthesizing_agent: string
  /** Optional: token usage of the synthesis call, if recorded. */
  token_usage?: {
    input?: number | undefined
    output?: number | undefined
    total?: number | undefined
  }
  /** Optional: synthesis duration. */
  duration_ms?: number
  /** ISO timestamp the brief was last written. Matches the note's `updated`. */
  brief_written_at: string
}

export interface WriteBriefArgs {
  home: string
  threadSlug: string
  /** Markdown body of the synthesized brief. */
  briefBody: string
  /** Provenance metadata; see {@link BriefProvenance}. */
  provenance: BriefProvenance
  /** Injected clock (tests). */
  now?: () => Date
}

export interface WriteBriefResult {
  slug: string
  path: string
  created: boolean
}

export function briefSlug(threadSlug: string): string {
  return `research-${threadSlug}-brief`
}

/**
 * Write (or rewrite) the sibling brief note. Full rewrite each
 * time — the brief is a current-state synthesis, not an append log.
 */
export async function writeBrief(args: WriteBriefArgs): Promise<WriteBriefResult> {
  const now = args.now?.() ?? new Date()
  const store = BrainStore.forShared(args.home)
  const slug = briefSlug(args.threadSlug)
  const existing = await store.tryRead(slug)
  const created = existing === null
  const provenance: BriefProvenance = {
    ...args.provenance,
    brief_written_at: now.toISOString(),
  }
  const title = `Standing brief: ${args.threadSlug}`
  const result = await store.write({
    slug,
    title,
    body: args.briefBody,
    type: 'standing-brief',
    tags: [...BRIEF_TAGS],
    extras: { ...provenance },
    now: () => now,
  })
  return { slug: result.slug, path: result.path, created }
}

/**
 * Read the brief note for a thread. Returns null when no brief exists.
 *
 * Searches shared brain first (legacy + pre-migration briefs) then
 * each registered embassy's brain (PR-B3b: briefs now land in the
 * embassy that owns the conduit). Embassy ownership is opaque to
 * the read path — operators (and the get_research_brief tool) ask
 * by thread slug, the right store wins.
 */
export async function readBrief(
  home: string,
  threadSlug: string,
): Promise<{
  body: string
  provenance: BriefProvenance | null
  path: string
} | null> {
  const slug = briefSlug(threadSlug)
  const stores: BrainStore[] = [BrainStore.forShared(home)]
  const { listConduits } = await import('./embassy/conduits.js')
  const conduits = await listConduits(home).catch(() => [])
  for (const c of conduits) stores.push(BrainStore.forAgent(home, c.embassy_agent))
  for (const store of stores) {
    const note = await store.tryRead(slug)
    if (note === null) continue
    const provenance =
      note.extras['brief_schema_version'] === BRIEF_SCHEMA_VERSION
        ? (note.extras as unknown as BriefProvenance)
        : null
    return { body: note.body, provenance, path: note.path }
  }
  return null
}

export interface ThreadSynthesisState {
  /** Bare thread slug (without `research-` prefix). */
  threadSlug: string
  /** Latest `pending_synthesis_at` from the thread anchor. */
  pendingSynthesisAt: string | null
  /** What the existing brief is current as of, per the anchor. */
  synthesizedThrough: string | null
  /** Consecutive failures since the last successful synthesis. */
  failureCount: number
  /** True iff the operator has blocked synthesis (cleared via `connector synthesis unblock`). */
  blocked: boolean
  /** Primary Agent name (from the thread anchor's frontmatter). */
  primaryAgent: string | null
  /** Last contribution timestamp from the anchor. */
  lastContributionAt: string | null
  /** Display name. */
  displayName: string
  /** Absolute path to the thread anchor. */
  anchorPath: string
}

/** Read the synthesis state for every research thread on disk. */
export async function listSynthesisStates(home: string): Promise<ThreadSynthesisState[]> {
  const store = BrainStore.forShared(home)
  const notes = await store.list({ tag: 'research-thread' })
  const out: ThreadSynthesisState[] = []
  for (const note of notes) {
    // Filter out the brief sibling — both share the `research-thread`
    // tag, but only the chronological log is the anchor we reconcile.
    if (note.frontmatter.tags.includes('standing-brief')) continue
    const slug = note.slug.startsWith('research-') ? note.slug.slice('research-'.length) : note.slug
    out.push({
      threadSlug: slug,
      pendingSynthesisAt: stringOrNull(note.extras['pending_synthesis_at']),
      synthesizedThrough: stringOrNull(note.extras['synthesized_through']),
      failureCount: numberOr(note.extras['synthesis_failure_count'], 0),
      blocked: booleanOr(note.extras['synthesis_blocked'], false),
      primaryAgent: stringOrNull(note.extras['primary_agent']),
      lastContributionAt: stringOrNull(note.extras['last_contribution_at']),
      displayName: stringOrNull(note.extras['display_name']) ?? slug,
      anchorPath: note.path,
    })
  }
  return out
}

export interface UpdateAnchorFrontmatterArgs {
  home: string
  threadSlug: string
  /** Partial updates merged into the anchor's `extras`. */
  updates: Partial<{
    pending_synthesis_at: string | null
    synthesized_through: string | null
    synthesis_failure_count: number
    synthesis_blocked: boolean
  }>
}

/**
 * Patch the anchor's frontmatter without rewriting its body.
 *
 * Reads the existing note, merges the updates into its `extras`,
 * writes it back with the same body. Used by the reconciler /
 * brief-write tool / `connector synthesis unblock` CLI. The anchor's
 * body is preserved verbatim (no contribution-log mutation).
 */
export async function updateAnchorFrontmatter(args: UpdateAnchorFrontmatterArgs): Promise<void> {
  const store = BrainStore.forShared(args.home)
  const slug = `research-${args.threadSlug}`
  const existing = await store.read(slug)
  const newExtras: Record<string, unknown> = { ...existing.extras }
  const updates = args.updates as Record<string, unknown>
  for (const k of Object.keys(updates)) {
    const v = updates[k]
    if (v === null) {
      Reflect.deleteProperty(newExtras, k)
    } else {
      newExtras[k] = v
    }
  }
  await store.write({
    slug,
    title: existing.frontmatter.title,
    body: existing.body,
    type: existing.frontmatter.type,
    tags: existing.frontmatter.tags,
    extras: newExtras,
  })
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' ? v : fallback
}

function booleanOr(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}
