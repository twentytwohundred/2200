/**
 * Shelf store (Phase 2 / PR-B2).
 *
 * Each item is a single markdown file with YAML frontmatter under
 *   `agents/<embassy>/brain/shelf/<shelf-item-id>.md`
 *
 * Same on-disk idiom as Brain notes (so the existing brain search +
 * read surfaces could surface shelf items in the future; not wired
 * in B2). The shelf store reads/writes only via these helpers — the
 * embassy's eight internal tools call into this module.
 *
 * Why bespoke (not BrainStore)?
 *  - Frontmatter is type-specific (`shelf_item_id`, `status`,
 *    `collected_at`, `provenance.*` etc.) and Zod-validated here.
 *  - Listing filters by status / type / priority are domain-specific.
 *  - Surfaces (`shelf_preview` in B4) need cheap-by-design metadata
 *    extraction; the store's `list` returns parsed records.
 */
import { mkdir, readdir, readFile, unlink, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as yamlParse, stringify as yamlStringify } from 'yaml'
import { atomicWriteFile } from '../../../../util/atomic-write.js'
import { agentPaths } from '../../../../storage/layout.js'
import {
  ShelfItemFrontmatterSchema,
  isStandingType,
  ONE_SHOT_TYPES,
  type ShelfItemFrontmatter,
  type ShelfItemPriority,
  type ShelfItemStatus,
  type ShelfItemType,
} from './types.js'

const DIR_MODE = 0o700
const FILE_MODE = 0o600

function shelfDir(home: string, embassyAgent: string): string {
  return join(agentPaths(home, embassyAgent).brain, 'shelf')
}

function shelfItemPath(home: string, embassyAgent: string, shelfItemId: string): string {
  return join(shelfDir(home, embassyAgent), `${shelfItemId}.md`)
}

export interface ShelfItemRecord {
  frontmatter: ShelfItemFrontmatter
  body: string
  path: string
}

/** Parse a markdown file with `---` frontmatter into (frontmatter, body). */
function splitFrontmatter(raw: string): { fmText: string; body: string } {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(raw)
  if (m === null) {
    throw new Error('shelf item file is missing YAML frontmatter')
  }
  return { fmText: m[1] ?? '', body: m[2] ?? '' }
}

export async function ensureShelfDir(home: string, embassyAgent: string): Promise<void> {
  await mkdir(shelfDir(home, embassyAgent), { recursive: true, mode: DIR_MODE })
}

/**
 * Persist a shelf item. Atomic write; mode 0600. Caller is
 * responsible for ensuring the frontmatter is consistent (e.g.,
 * `collected_at` present iff `status === 'collected'`).
 */
export async function writeShelfItem(
  home: string,
  embassyAgent: string,
  frontmatter: ShelfItemFrontmatter,
  body: string,
): Promise<string> {
  // Validation BEFORE the write so we never persist garbage.
  ShelfItemFrontmatterSchema.parse(frontmatter)
  if (frontmatter.status === 'collected' && frontmatter.collected_at === null) {
    throw new Error('shelf item with status=collected must carry a collected_at timestamp')
  }
  if (frontmatter.status === 'pending' && frontmatter.collected_at !== null) {
    throw new Error('shelf item with status=pending must NOT carry a collected_at timestamp')
  }
  await ensureShelfDir(home, embassyAgent)
  const path = shelfItemPath(home, embassyAgent, frontmatter.shelf_item_id)
  const yaml = yamlStringify(frontmatter, { lineWidth: 0 })
  const content = `---\n${yaml}---\n\n${body}`
  await atomicWriteFile(path, content)
  await chmod(path, FILE_MODE)
  return path
}

export async function readShelfItem(
  home: string,
  embassyAgent: string,
  shelfItemId: string,
): Promise<ShelfItemRecord | null> {
  const path = shelfItemPath(home, embassyAgent, shelfItemId)
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const { fmText, body } = splitFrontmatter(raw)
  const fm = ShelfItemFrontmatterSchema.parse(yamlParse(fmText))
  return { frontmatter: fm, body, path }
}

export async function deleteShelfItem(
  home: string,
  embassyAgent: string,
  shelfItemId: string,
): Promise<boolean> {
  try {
    await unlink(shelfItemPath(home, embassyAgent, shelfItemId))
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

export interface ListShelfArgs {
  status?: ShelfItemStatus
  type?: ShelfItemType
  priority?: ShelfItemPriority
  /** Hard cap on returned items. Default 200. */
  limit?: number
}

/**
 * List shelf items, oldest-ingested first. Filters by status / type
 * / priority. Used by the embassy's `list_my_shelf` tool (full
 * bodies) — the model-facing bounded preview lives in B4.
 */
export async function listShelfItems(
  home: string,
  embassyAgent: string,
  args: ListShelfArgs = {},
): Promise<ShelfItemRecord[]> {
  let entries: string[]
  try {
    entries = await readdir(shelfDir(home, embassyAgent))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: ShelfItemRecord[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const id = entry.slice(0, -'.md'.length)
    const rec = await readShelfItem(home, embassyAgent, id).catch(() => null)
    if (rec === null) continue
    if (args.status !== undefined && rec.frontmatter.status !== args.status) continue
    if (args.type !== undefined && rec.frontmatter.type !== args.type) continue
    if (args.priority !== undefined && rec.frontmatter.priority !== args.priority) continue
    out.push(rec)
  }
  out.sort((a, b) =>
    a.frontmatter.provenance.ingested_at.localeCompare(b.frontmatter.provenance.ingested_at),
  )
  if (args.limit !== undefined && out.length > args.limit) {
    return out.slice(0, args.limit)
  }
  return out
}

/**
 * Apply the type-driven collection transition (spec section 6).
 * Called from the model-facing read path in B4 once the model has
 * received the full body in-call. Idempotent: a second pull after
 * collection is a no-op.
 *
 * One-shot types: status → collected, collected_at stamped.
 * Standing types: status STAYS pending (the model received the
 *   content but the embassy holds the item for re-surfacing).
 *
 * Returns the updated record (or the unchanged record for standing).
 */
export async function applyCollectionTransition(
  home: string,
  embassyAgent: string,
  shelfItemId: string,
  pulledAt: Date,
): Promise<{ record: ShelfItemRecord; transitioned: boolean }> {
  const rec = await readShelfItem(home, embassyAgent, shelfItemId)
  if (rec === null)
    throw new Error(`unknown shelf_item_id "${shelfItemId}" for embassy "${embassyAgent}"`)
  if (rec.frontmatter.status === 'collected') {
    return { record: rec, transitioned: false }
  }
  if (isStandingType(rec.frontmatter.type)) {
    // Standing item: stays pending after preview-or-pull.
    return { record: rec, transitioned: false }
  }
  // One-shot: transition.
  const updated: ShelfItemFrontmatter = {
    ...rec.frontmatter,
    status: 'collected',
    collected_at: pulledAt.toISOString(),
  }
  await writeShelfItem(home, embassyAgent, updated, rec.body)
  return { record: { ...rec, frontmatter: updated }, transitioned: true }
}

export { ONE_SHOT_TYPES }
