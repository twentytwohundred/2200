/**
 * Shelf item data model (Phase 2 / PR-B2).
 *
 * Per the locked embassy/shelf handoff (2026-05-23) section 5: each
 * shelf item lives at
 *   `agents/<embassy-name>/brain/shelf/<shelf-item-id>.md`
 *
 * The frontmatter shape below mirrors spec section 5 verbatim, with
 * implementation-detail clarifications locked 2026-05-26:
 *  - `shelf_item_id` is `shelf_<24 base32>` (parallel to `pkg_<24 hex>` from PR 4).
 *  - `collected_at` is present iff `status === 'collected'`.
 *  - `provenance.ingested_by` is the embassy Agent name (NOT the OAuth display name).
 *  - `source.client_id` is set by the embassy from its own conduit context;
 *    forgeability is acceptable since the embassy is a trusted component
 *    (threat-model lock 2026-05-26).
 *  - `sensitivity: 'private'` is NEVER directly written here — the gate
 *    in `place_on_shelf` rejects autonomous placement; private items
 *    flow through `request_human_shelf_placement` + operator approval,
 *    which transforms `source_type` to `human_curated` before the actual
 *    write (effective `sensitivity` on the persisted record is therefore
 *    always `'none'` from the on-disk perspective; the operator's
 *    decision IS the desensitization).
 */
import { randomBytes } from 'node:crypto'
import { z } from 'zod'

/** RFC 4648 base32 lowercase (no padding) for shelf_item_id readability. */
function base32Lower(buf: Buffer): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += alphabet.charAt((value >>> (bits - 5)) & 31)
      bits -= 5
    }
  }
  if (bits > 0) out += alphabet.charAt((value << (5 - bits)) & 31)
  return out
}

/** Mint a fresh shelf_item_id: `shelf_<24 base32 chars>`. */
export function newShelfItemId(): string {
  return `shelf_${base32Lower(randomBytes(15)).slice(0, 24)}`
}

/**
 * Item kinds — spec section 5. Collection rules in section 6 are
 * type-driven; see `ONE_SHOT_TYPES` / `STANDING_TYPES` below.
 */
export const ShelfItemTypeSchema = z.enum([
  'question',
  'context',
  'research_request',
  'synthesis_prompt',
  'agenda',
])
export type ShelfItemType = z.infer<typeof ShelfItemTypeSchema>

/**
 * Pure-one-shot types: collected and dropped from the pending set on
 * first full-body retrieval. Per spec section 6, `research_request`
 * is one-shot UNLESS explicitly marked standing via `standing: true`
 * in source/extras (not in v1 schema; reserved).
 */
export const ONE_SHOT_TYPES = new Set<ShelfItemType>(['question', 'research_request'])

/**
 * Standing types: remain `pending` after collection. They re-surface
 * (subject to prioritization) until the embassy explicitly resolves
 * them via `resolve_shelf_item`.
 */
export const STANDING_TYPES = new Set<ShelfItemType>(['context', 'synthesis_prompt', 'agenda'])

export const ShelfItemSourceTypeSchema = z.enum(['human_curated', 'embassy_autonomous'])
export type ShelfItemSourceType = z.infer<typeof ShelfItemSourceTypeSchema>

export const ShelfItemSourceSchema = z.object({
  origin: z.enum(['inbox', 'direct', 'embassy_note', 'contribution']),
  /** Inbox id or contribution slug or originating note ref; null when direct. */
  reference: z.string().nullable(),
  /** Human operator display name OR the embassy agent name, depending on source_type. */
  curator: z.string().min(1),
  /**
   * OAuth client_id this item is attributed to (for `self_reflected` detection
   * in the model-facing preview). Null when the item didn't originate from any
   * remote model (operator direct curation, or fleet-internal).
   */
  client_id: z.string().nullable(),
  timestamp: z.string().min(1),
})
export type ShelfItemSource = z.infer<typeof ShelfItemSourceSchema>

export const ShelfItemProvenanceSchema = z.object({
  /** Stamped at placement-time on the ingestion boundary; never modified. */
  ingested_at: z.string().min(1),
  /** Embassy agent name. */
  ingested_by: z.string().min(1),
  /** Slug of an originating contribution (when applicable). */
  original_contribution_slug: z.string().nullable(),
  /** Optional prior-context links: each entry references a previous shelf_item_id or contribution slug. */
  chain: z.array(z.string().min(1)).default([]),
})
export type ShelfItemProvenance = z.infer<typeof ShelfItemProvenanceSchema>

export const ShelfItemPrioritySchema = z.enum(['high', 'normal'])
export type ShelfItemPriority = z.infer<typeof ShelfItemPrioritySchema>

export const ShelfItemStatusSchema = z.enum(['pending', 'collected'])
export type ShelfItemStatus = z.infer<typeof ShelfItemStatusSchema>

/**
 * Sensitivity on the persisted record. `private` is NEVER directly
 * stored — autonomous private placement is rejected at the
 * `place_on_shelf` gate; human-approved items land with `none`
 * because the operator's approval IS the desensitization.
 *
 * The `sensitivity: 'private'` value lives only in the
 * `request_human_shelf_placement` API parameter and the pending-
 * approval store, never on a shelf item file.
 */
export const ShelfItemSensitivitySchema = z.literal('none')
export type ShelfItemSensitivity = z.infer<typeof ShelfItemSensitivitySchema>

/** Frontmatter on the shelf item file. Body is the actionable content. */
export const ShelfItemFrontmatterSchema = z.object({
  schema_version: z.literal(1),
  shelf_item_id: z.string().min(1),
  type: ShelfItemTypeSchema,
  source_type: ShelfItemSourceTypeSchema,
  source: ShelfItemSourceSchema,
  /** Always `<external-model-slug>` (e.g., `grok`). Not the embassy's name. */
  target_model: z.string().min(1),
  provenance: ShelfItemProvenanceSchema,
  priority: ShelfItemPrioritySchema,
  status: ShelfItemStatusSchema,
  /** ISO 8601; present iff status === 'collected'. */
  collected_at: z.string().nullable(),
  sensitivity: ShelfItemSensitivitySchema,
})
export type ShelfItemFrontmatter = z.infer<typeof ShelfItemFrontmatterSchema>

/** Type guard: standing vs one-shot. */
export function isStandingType(t: ShelfItemType): boolean {
  return STANDING_TYPES.has(t)
}
