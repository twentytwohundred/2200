/**
 * Brain note types and schemas (Epic 8 Phase A PR A).
 *
 * A brain note is a markdown file with YAML frontmatter at
 * `<home>/agents/<name>/brain/<slug>.md`. The file is the source of
 * truth per [[2026-04-24-brain-is-files-not-database]]: the SQLite
 * FTS5 index (PR B) is rebuildable from the file content, never the
 * other way around.
 *
 * Frontmatter is intentionally permissive on `type`. The runtime
 * does not enforce a closed set; callers can pass any string. The
 * conventional types live in [[08-agent-brain]] and reflect what
 * Hobby's existing memory uses (feedback, project, user, reference,
 * journal, freeform).
 */
import { z } from 'zod'

export const BRAIN_SCHEMA_VERSION = 1

export const BrainFrontmatterSchema = z.object({
  brain_schema_version: z.literal(1),
  /** Human-readable note title. Slug is derived separately. */
  title: z.string().min(1),
  /**
   * Note type. Free-form string, see [[08-agent-brain]] for the
   * conventional values. Defaulted to 'freeform' on read if absent.
   */
  type: z.string().min(1).default('freeform'),
  /** Tags for filtering and FTS5 ranking. Empty array allowed. */
  tags: z.array(z.string().min(1)).default([]),
  /** ISO timestamp of first write. Set by the store on create. */
  created: z.string().min(1),
  /** ISO timestamp of last write. Bumped by the store on every save. */
  updated: z.string().min(1),
  /**
   * Outbound `[[slug]]` references parsed from the body at write
   * time. Stored in frontmatter so consumers don't need to re-parse
   * the body. Inbound (backlink) traversal is a Phase C deliverable.
   */
  links: z.array(z.string().min(1)).default([]),
})
export type BrainFrontmatter = z.infer<typeof BrainFrontmatterSchema>

export interface BrainNote {
  /** The slug, also the basename of the file (without .md). */
  slug: string
  /** Absolute path to the markdown file. */
  path: string
  frontmatter: BrainFrontmatter
  /** Frontmatter fields beyond the canonical schema. Round-trip preserved. */
  extras: Record<string, unknown>
  /** The markdown body, with no frontmatter and no trailing newline normalization. */
  body: string
}

/**
 * Derive a filesystem-safe slug from a free-form title. Lowercases,
 * collapses whitespace into single dashes, strips characters outside
 * `[a-z0-9-]`, trims leading/trailing dashes, and caps at 80 chars.
 *
 * The store's collision strategy appends `-2`, `-3`, ... if the
 * derived slug already exists (Phase A spec).
 */
export function deriveSlug(title: string): string {
  const lowered = title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  const dashed = lowered.trim().replace(/[\s_]+/g, '-')
  const cleaned = dashed.replace(/[^a-z0-9-]+/g, '')
  const collapsed = cleaned.replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  const truncated = collapsed.slice(0, 80).replace(/-+$/g, '')
  if (truncated.length === 0) {
    throw new Error(`cannot derive a slug from title "${title}" (no usable characters)`)
  }
  return truncated
}

/**
 * Extract `[[slug]]` references from a body. Matches double-bracketed
 * names that look like slugs; ignores trailing punctuation and
 * markdown styling around the brackets. De-duplicates while
 * preserving first-seen order.
 */
const LINK_RE = /\[\[([a-z0-9][a-z0-9-]{0,79})\]\]/gi
export function extractLinks(body: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const match of body.matchAll(LINK_RE)) {
    const slug = match[1]?.toLowerCase()
    if (slug && !seen.has(slug)) {
      seen.add(slug)
      out.push(slug)
    }
  }
  return out
}
