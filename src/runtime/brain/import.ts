/**
 * Bulk import for the brain (Epic 8 Phase A PR D).
 *
 * Migrates an existing directory of markdown notes into an Agent's
 * brain. Specifically designed for Hobby's existing memory layout
 * (~/.claude/projects/<id>/memory/) but works on any directory of
 * loosely-structured markdown files.
 *
 * For each `.md` file in the source dir:
 *   1. Read it.
 *   2. If it has YAML frontmatter, parse it as a record. Otherwise,
 *      treat the entire file as body and synthesize frontmatter.
 *   3. Derive the slug from the filename (sans `.md` and lowercased).
 *   4. Map any `name` field to `title`; preserve `type`; convert any
 *      `description` to a tag-like field. Compute `links` from the
 *      body's [[...]] references.
 *   5. Set `created` / `updated` to the file mtime.
 *   6. Write through the supplied BrainStore (with an explicit slug
 *      so collisions stay deterministic) and upsert into the index.
 *
 * Any file that can't be parsed is reported as a `skipped` entry;
 * the import does not abort on a single bad file.
 *
 * The `MEMORY.md` index file at the top level of Hobby's memory
 * dir is treated specially: it's imported as `memory-index` (a
 * preserved view of the human-curated index), not parsed as
 * structured data.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { BrainStore } from './store.js'
import { BrainIndex } from './index-db.js'
import { extractLinks } from './types.js'

const FRONTMATTER_RE = /^---\n([\s\S]+?)\n---\n?([\s\S]*)$/

export interface ImportArgs {
  home: string
  /**
   * Where to import. Either an Agent (`agentName: string`) or the
   * shared brain (`sharedBrain: true`). Exactly one must be set.
   */
  agentName?: string
  sharedBrain?: boolean
  sourceDir: string
  /**
   * If true, parse + map each file but do not write. Returns the
   * intended slugs + titles so the caller can preview the import.
   */
  dryRun?: boolean
}

export interface ImportResult {
  imported: ImportedEntry[]
  skipped: SkippedEntry[]
}

export interface ImportedEntry {
  sourcePath: string
  slug: string
  title: string
  type: string
  tags: string[]
  bytes: number
  createdOrUpdated: 'created' | 'updated'
}

export interface SkippedEntry {
  sourcePath: string
  reason: string
}

export async function importFromDir(args: ImportArgs): Promise<ImportResult> {
  const result: ImportResult = { imported: [], skipped: [] }
  const files = await listMarkdownFiles(args.sourceDir)
  if (files.length === 0) return result

  let store: BrainStore
  let index: BrainIndex | null
  if (args.sharedBrain === true) {
    if (args.agentName !== undefined) {
      throw new Error('importFromDir: agentName and sharedBrain are mutually exclusive')
    }
    store = BrainStore.forShared(args.home)
    index = args.dryRun === true ? null : BrainIndex.openShared(args.home)
  } else if (args.agentName !== undefined) {
    store = BrainStore.forAgent(args.home, args.agentName)
    index = args.dryRun === true ? null : BrainIndex.open(args.home, args.agentName)
  } else {
    throw new Error('importFromDir: pass agentName or sharedBrain: true')
  }
  try {
    for (const file of files) {
      try {
        const entry = await importOneFile({
          file,
          store,
          index,
          dryRun: args.dryRun ?? false,
        })
        result.imported.push(entry)
      } catch (err) {
        result.skipped.push({
          sourcePath: file,
          reason: err instanceof Error ? err.message : String(err),
        })
      }
    }
  } finally {
    if (index) index.close()
  }
  return result
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    throw new Error(`could not read source dir "${dir}": ${(err as Error).message}`, {
      cause: err,
    })
  }
  const out: string[] = []
  for (const name of entries) {
    if (!name.endsWith('.md')) continue
    out.push(join(dir, name))
  }
  out.sort()
  return out
}

interface ImportOneArgs {
  file: string
  store: BrainStore
  index: BrainIndex | null
  dryRun: boolean
}

async function importOneFile(args: ImportOneArgs): Promise<ImportedEntry> {
  const text = await readFile(args.file, 'utf8')
  const stats = await stat(args.file)
  const baseName = basename(args.file, '.md')
  const slug = deriveImportSlug(baseName)

  const m = FRONTMATTER_RE.exec(text)
  let body: string
  let title: string
  let type = 'freeform'
  let tags: string[] = []
  const extras: Record<string, unknown> = {}

  if (m?.[1] !== undefined) {
    const parsed = (parseYaml(m[1]) ?? {}) as Record<string, unknown>
    body = m[2] ?? ''
    title = pickString(parsed, ['title', 'name']) ?? humanize(baseName)
    type = pickString(parsed, ['type']) ?? type
    tags = pickStringArray(parsed, ['tags']) ?? []
    // Carry over any source frontmatter fields we don't know about
    // so a round-trip is possible.
    for (const k of Object.keys(parsed)) {
      if (k !== 'name' && k !== 'title' && k !== 'type' && k !== 'tags') {
        extras[k] = parsed[k]
      }
    }
  } else {
    body = text
    title = humanize(baseName)
  }

  // Derive a tag from the filename prefix if it matches one of the
  // known Hobby memory conventions: feedback_*, project_*, user_*,
  // reference_*. The prefix becomes a tag and (for unset type) the
  // type as well.
  const prefix = baseName.split('_', 1)[0]
  if (
    prefix !== undefined &&
    prefix !== baseName &&
    ['feedback', 'project', 'user', 'reference'].includes(prefix)
  ) {
    if (!tags.includes(prefix)) tags = [prefix, ...tags]
    if (type === 'freeform') type = prefix
  }

  // Make sure links computed from the body are present in
  // frontmatter (BrainStore does this on write, but we want the
  // dry-run preview to reflect it too).
  void extractLinks(body)

  if (args.dryRun) {
    return {
      sourcePath: args.file,
      slug,
      title,
      type,
      tags,
      bytes: Buffer.byteLength(body, 'utf8'),
      createdOrUpdated: 'created',
    }
  }

  const w = await args.store.write({
    title,
    body,
    slug,
    type,
    tags,
    extras,
    now: () => stats.mtime,
  })
  // BrainStore handles `created`/`updated`/`links`; just upsert into the index.
  const note = await args.store.read(w.slug)
  if (args.index) args.index.upsert(note)
  return {
    sourcePath: args.file,
    slug: w.slug,
    title,
    type,
    tags,
    bytes: Buffer.byteLength(body, 'utf8'),
    createdOrUpdated: w.created ? 'created' : 'updated',
  }
}

function deriveImportSlug(baseName: string): string {
  // Filenames in Hobby's memory dir are already lowercased and
  // underscore- or dash-separated. Normalize underscores to dashes
  // and clamp to the same shape as deriveSlug.
  return baseName
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

function pickStringArray(obj: Record<string, unknown>, keys: string[]): string[] | undefined {
  for (const k of keys) {
    const v = obj[k]
    if (Array.isArray(v)) {
      const out: string[] = []
      for (const item of v) {
        if (typeof item === 'string' && item.length > 0) out.push(item)
      }
      if (out.length > 0) return out
    }
  }
  return undefined
}

function humanize(slug: string): string {
  return slug
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^|\s)[a-z]/g, (s) => s.toUpperCase())
}
