/**
 * Frontmatter + body parse and serialize for brain notes
 * (Epic 8 Phase A PR A).
 *
 * Mirrors the pattern used by NotificationStore (Epic 7) and
 * TaskStore (Epic 2): YAML frontmatter delimited by `---`, body
 * after. The whole-file representation is what lands on disk; the
 * BrainStore is the only thing that should call these functions.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { BrainFrontmatterSchema, type BrainFrontmatter, type BrainNote } from './types.js'

const FRONTMATTER_RE = /^---\n([\s\S]+?)\n---\n?([\s\S]*)$/

export interface ParsedBrainFile {
  frontmatter: BrainFrontmatter
  extras: Record<string, unknown>
  body: string
}

/**
 * Parse a brain note file's whole text into frontmatter + body.
 * Strict on schema (Zod parse), tolerant on extra frontmatter keys
 * (round-trip preserved via `extras`).
 */
export function parseBrainNote(text: string, sourcePath: string): ParsedBrainFile {
  const m = FRONTMATTER_RE.exec(text)
  if (m?.[1] === undefined) {
    throw new Error(`brain note at ${sourcePath} has no YAML frontmatter`)
  }
  const yamlText = m[1]
  const body = m[2] ?? ''
  const parsed = parseYaml(yamlText) as Record<string, unknown> | null
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`brain note at ${sourcePath} has empty or non-object frontmatter`)
  }
  const fm = BrainFrontmatterSchema.parse(parsed)
  const extras: Record<string, unknown> = {}
  const canonicalKeys = new Set([
    'brain_schema_version',
    'title',
    'type',
    'tags',
    'created',
    'updated',
    'links',
  ])
  for (const k of Object.keys(parsed)) {
    if (!canonicalKeys.has(k)) extras[k] = parsed[k]
  }
  return { frontmatter: fm, extras, body }
}

/**
 * Serialize a brain note back to a markdown file body. The
 * frontmatter ordering is canonical (matching the Zod schema's field
 * order); extras come after the canonical fields.
 *
 * The body is written verbatim; trailing newline normalization is
 * the caller's choice (the store appends a single trailing \n if
 * the body doesn't already end in one).
 */
export function serializeBrainNote(note: Omit<BrainNote, 'slug' | 'path'>): string {
  const fm: Record<string, unknown> = {
    brain_schema_version: note.frontmatter.brain_schema_version,
    title: note.frontmatter.title,
    type: note.frontmatter.type,
    tags: note.frontmatter.tags,
    created: note.frontmatter.created,
    updated: note.frontmatter.updated,
    links: note.frontmatter.links,
    ...note.extras,
  }
  const yamlText = stringifyYaml(fm).trimEnd()
  const trailing = note.body.endsWith('\n') ? '' : '\n'
  return `---\n${yamlText}\n---\n${note.body}${trailing}`
}
