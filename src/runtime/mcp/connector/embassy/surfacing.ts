/**
 * Shelf surfacing for `get_fleet_context` (Phase 2 / PR-B4).
 *
 * Locked 2026-05-26/27 (per the B4 design note + Doug's confirmation):
 *
 *   - Hard cap 10 items inline (middle of the 8–12 band).
 *   - Excerpt is the first 500 chars of the body, truncated on a word
 *     boundary when possible; "..." appended if truncated.
 *   - `self_reflected: true` iff the item's `source.client_id`
 *     matches the calling OAuth client_id.
 *   - When `self_reflected`, the excerpt is PREFIXED by a model-readable
 *     sentence varying by `source_type` (embassy_autonomous vs
 *     human_curated).
 *   - Prioritization order (spec section 7, mechanical):
 *       1. Standing items never previously collected
 *       2. Highest priority (`priority === 'high'`)
 *       3. Most recent `ingested_at` (descending)
 *       4. Previously collected standing items (lower priority)
 *     Implementation uses a deterministic score so tests are
 *     reproducible.
 *   - Long-tail summary folded INTO the `shelf_preview` block
 *     (single-block API, more discoverable than a parallel field):
 *     `total_pending`, `standing_pending`, `one_shot_pending`,
 *     `next_priority_ids` (next 10 ids without content).
 */
import { isStandingType, type ShelfItemFrontmatter } from './shelf/types.js'
import { listShelfItems } from './shelf/store.js'

export const SHELF_PREVIEW_CAP = 10
export const NEXT_PRIORITY_IDS_CAP = 10
export const EXCERPT_CHARS = 500

export interface ShelfPreviewItem {
  shelf_item_id: string
  type: ShelfItemFrontmatter['type']
  priority: 'high' | 'normal'
  ingested_at: string
  excerpt: string
  provenance: {
    source_type: 'human_curated' | 'embassy_autonomous'
    source_origin: 'inbox' | 'direct' | 'embassy_note' | 'contribution'
    source_curator: string
    original_contribution_slug: string | null
  }
  self_reflected: boolean
}

export interface ShelfPreview {
  items: ShelfPreviewItem[]
  total_pending: number
  standing_pending: number
  one_shot_pending: number
  /** Next 10 highest-priority item IDs (without content) past the inline cap, for the model's reference. */
  next_priority_ids: string[]
}

/**
 * Build the `shelf_preview` block for one inbound call.
 *
 * Reads the embassy's shelf, classifies each pending item, sorts by
 * the locked priority order, returns the bounded preview + the
 * long-tail summary.
 *
 * Returns null (NOT an empty block) when there's no embassy for the
 * calling client — `get_fleet_context` omits the field entirely
 * rather than render an empty section.
 */
export async function buildShelfPreview(
  home: string,
  embassyAgent: string,
  callingClientId: string | null,
): Promise<ShelfPreview> {
  const items = await listShelfItems(home, embassyAgent, { limit: 1000 })
  // The cohort we surface from: pending items. Collected one-shots
  // are out of rotation. Collected standing items are eligible per
  // the locked priority order, but at a LOWER score than pending.
  const candidates = items.filter(
    (r) => r.frontmatter.status === 'pending' || isStandingType(r.frontmatter.type),
  )

  // Compute scores. Higher = surfaces sooner.
  const scored = candidates.map((rec) => ({ rec, score: scoreItem(rec.frontmatter) }))
  scored.sort((a, b) => b.score - a.score)

  const totalPending = items.filter((r) => r.frontmatter.status === 'pending').length
  const standingPending = items.filter(
    (r) => r.frontmatter.status === 'pending' && isStandingType(r.frontmatter.type),
  ).length
  const oneShotPending = totalPending - standingPending

  const preview = scored
    .slice(0, SHELF_PREVIEW_CAP)
    .map(({ rec }) => itemToPreview(rec, callingClientId))
  const nextIds = scored
    .slice(SHELF_PREVIEW_CAP, SHELF_PREVIEW_CAP + NEXT_PRIORITY_IDS_CAP)
    .map(({ rec }) => rec.frontmatter.shelf_item_id)

  return {
    items: preview,
    total_pending: totalPending,
    standing_pending: standingPending,
    one_shot_pending: oneShotPending,
    next_priority_ids: nextIds,
  }
}

/**
 * Score formula (locked deterministic order). Higher = higher
 * priority. Layered to mirror the spec's bullet list exactly.
 *
 * 1. Standing pending → +1_000_000_000 (always above everything else)
 * 2. Priority high   → +  100_000_000
 * 3. Recent ingested → up to +60 * 60 * 24 * 365 seconds-since-epoch
 *                      contribution (ascending normalised time).
 * 4. Standing collected → -1_000_000_000 (always below pending standing
 *                         items, but kept eligible for rotation).
 */
function scoreItem(fm: ShelfItemFrontmatter): number {
  const standing = isStandingType(fm.type)
  const standingPending = standing && fm.status === 'pending'
  const standingCollected = standing && fm.status === 'collected'
  let s = 0
  if (standingPending) s += 1_000_000_000
  if (standingCollected) s -= 1_000_000_000
  if (fm.priority === 'high') s += 100_000_000
  // Add the ingested_at unix seconds so newer surfaces sooner.
  // Spec orders by "most recent ingested_at descending" — score adds
  // (newer = higher) to make it tie-break correctly.
  const t = Date.parse(fm.provenance.ingested_at)
  if (!Number.isNaN(t)) s += Math.floor(t / 1000)
  return s
}

function itemToPreview(
  rec: { frontmatter: ShelfItemFrontmatter; body: string },
  callingClientId: string | null,
): ShelfPreviewItem {
  const fm = rec.frontmatter
  const selfReflected = callingClientId !== null && fm.source.client_id === callingClientId
  let excerpt = truncateExcerpt(rec.body, EXCERPT_CHARS)
  if (selfReflected) {
    excerpt = renderSelfReflectedPrefix(fm.source_type) + '\n\n' + excerpt
  }
  return {
    shelf_item_id: fm.shelf_item_id,
    type: fm.type,
    priority: fm.priority,
    ingested_at: fm.provenance.ingested_at,
    excerpt,
    provenance: {
      source_type: fm.source_type,
      source_origin: fm.source.origin,
      source_curator: fm.source.curator,
      original_contribution_slug: fm.provenance.original_contribution_slug,
    },
    self_reflected: selfReflected,
  }
}

function renderSelfReflectedPrefix(sourceType: 'human_curated' | 'embassy_autonomous'): string {
  if (sourceType === 'human_curated') {
    return 'This item was previously contributed by you and an operator curated it for your return.'
  }
  return 'This item was previously contributed by you and the fleet flagged it for your return.'
}

function truncateExcerpt(body: string, max: number): string {
  if (body.length <= max) return body
  // Truncate on a word boundary near the cap.
  const slice = body.slice(0, max)
  const lastSpace = slice.lastIndexOf(' ')
  // Don't backtrack more than 20% of the cap looking for a space.
  const cutAt = lastSpace >= max * 0.8 ? lastSpace : max
  return body.slice(0, cutAt) + '...'
}
