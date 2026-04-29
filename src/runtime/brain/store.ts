/**
 * BrainStore: per-Agent filesystem-backed brain (Epic 8 Phase A PR A).
 *
 * One markdown file per note at
 *   <home>/agents/<name>/brain/<slug>.md
 *
 * The store covers create/upsert/read/list/delete/exists. Slug
 * derivation (with collision suffixing) is here; link extraction
 * runs on every write so the frontmatter `links` array stays
 * consistent with the body.
 *
 * The SQLite FTS5 index (PR B) sits on top of this store: every
 * BrainStore write triggers an upsert into the index, every delete
 * triggers an index delete. Index rebuild walks this store's
 * `list()` to repopulate.
 */
import { readdir, readFile, rm, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile } from '../util/atomic-write.js'
import { agentPaths, homePaths } from '../storage/layout.js'
import {
  BRAIN_SCHEMA_VERSION,
  deriveSlug,
  extractLinks,
  type BrainFrontmatter,
  type BrainNote,
} from './types.js'
import { parseBrainNote, serializeBrainNote } from './serialize.js'

export interface WriteNoteArgs {
  /** Title; required. Slug derived from this if `slug` not provided. */
  title: string
  /** Markdown body. */
  body: string
  /** Optional override slug. If absent, derived from title with collision suffix. */
  slug?: string
  /** Optional note type. Defaults to 'freeform'. */
  type?: string
  /** Optional tags. */
  tags?: string[]
  /** Optional extras (round-trip-preserved frontmatter beyond the canonical set). */
  extras?: Record<string, unknown>
  /** Test injection. */
  now?: () => Date
}

export interface WriteNoteResult {
  slug: string
  path: string
  /** True if this call created the file; false if it updated an existing slug. */
  created: boolean
}

export interface ListFilters {
  type?: string
  tag?: string
  /** Cap on results. Default 1000 (effectively unlimited for Phase A). */
  limit?: number
}

export class BrainStore {
  private readonly resolvedDir: string

  /**
   * Construct a BrainStore. Two shapes:
   *   new BrainStore(home, agentName)  ... per-Agent (Phase A; legacy callers).
   *   BrainStore.forAgent(home, name) ... per-Agent (preferred).
   *   BrainStore.forShared(home)       ... shared brain (Epic 8 Phase B).
   */
  constructor(home: string, agentName: string)
  constructor(opts: { dir: string })
  constructor(homeOrOpts: string | { dir: string }, agentName?: string) {
    if (typeof homeOrOpts === 'string') {
      if (!agentName) {
        throw new Error('BrainStore: agentName required when constructed with (home, agentName)')
      }
      this.resolvedDir = agentPaths(homeOrOpts, agentName).brain
    } else {
      this.resolvedDir = homeOrOpts.dir
    }
  }

  /** Per-Agent brain at <home>/agents/<name>/brain. */
  static forAgent(home: string, agentName: string): BrainStore {
    return new BrainStore({ dir: agentPaths(home, agentName).brain })
  }

  /** Shared brain at <home>/shared/brain (Epic 8 Phase B). */
  static forShared(home: string): BrainStore {
    return new BrainStore({ dir: homePaths(home).sharedBrain })
  }

  /** Resolve the brain dir without touching disk. */
  dir(): string {
    return this.resolvedDir
  }

  /** Resolve a slug to its file path. */
  pathFor(slug: string): string {
    return join(this.dir(), `${slug}.md`)
  }

  /**
   * Write a note. If `slug` is provided, that slug is used as-is and
   * the call is upsert-style; if absent, the slug is derived from
   * the title and the store appends `-2`, `-3`, ... on collision.
   *
   * `created` is preserved on update; `updated` is bumped to
   * `now()`. Links are recomputed from the body.
   */
  async write(args: WriteNoteArgs): Promise<WriteNoteResult> {
    const now = (args.now ?? (() => new Date()))().toISOString()
    let slug: string
    let created = true
    let createdAt = now
    if (args.slug !== undefined && args.slug.length > 0) {
      slug = args.slug
      const existing = await this.tryRead(slug)
      if (existing) {
        created = false
        createdAt = existing.frontmatter.created
      }
    } else {
      slug = await this.deriveUniqueSlug(args.title)
    }

    const fm: BrainFrontmatter = {
      brain_schema_version: BRAIN_SCHEMA_VERSION,
      title: args.title,
      type: args.type ?? 'freeform',
      tags: args.tags ?? [],
      created: createdAt,
      updated: now,
      links: extractLinks(args.body),
    }
    const note: Omit<BrainNote, 'slug' | 'path'> = {
      frontmatter: fm,
      extras: args.extras ?? {},
      body: args.body,
    }
    await mkdir(this.dir(), { recursive: true })
    const path = this.pathFor(slug)
    await atomicWriteFile(path, serializeBrainNote(note))
    return { slug, path, created }
  }

  /** Read a note by slug. Throws if missing or malformed. */
  async read(slug: string): Promise<BrainNote> {
    const path = this.pathFor(slug)
    const text = await readFile(path, 'utf8')
    const parsed = parseBrainNote(text, path)
    return { slug, path, ...parsed }
  }

  /** Read a note by slug, returning null if missing. */
  async tryRead(slug: string): Promise<BrainNote | null> {
    try {
      return await this.read(slug)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  /** Whether a slug exists on disk. */
  async exists(slug: string): Promise<boolean> {
    try {
      await stat(this.pathFor(slug))
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw err
    }
  }

  /**
   * List notes. Filtered by type/tag if supplied. Returns notes
   * sorted by `updated` descending (most recent first).
   *
   * Tolerates malformed files: bad notes are skipped, the rest are
   * returned. Use `2200 brain rebuild` to surface bad files
   * explicitly when needed.
   */
  async list(filters: ListFilters = {}): Promise<BrainNote[]> {
    const limit = filters.limit ?? 1000
    let entries: string[]
    try {
      entries = await readdir(this.dir())
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const notes: BrainNote[] = []
    for (const name of entries) {
      if (!name.endsWith('.md')) continue
      const slug = name.slice(0, -3)
      let note: BrainNote | null
      try {
        note = await this.tryRead(slug)
      } catch {
        // Tolerate malformed files (bad frontmatter, schema drift,
        // partial writes from a crashed process). `2200 brain
        // rebuild` (PR D) is the explicit surface for reconciling
        // these; list silently skips so a single bad file doesn't
        // break the search UX.
        continue
      }
      if (!note) continue
      if (filters.type !== undefined && note.frontmatter.type !== filters.type) continue
      if (filters.tag !== undefined && !note.frontmatter.tags.includes(filters.tag)) continue
      notes.push(note)
    }
    notes.sort((a, b) => b.frontmatter.updated.localeCompare(a.frontmatter.updated))
    return notes.slice(0, limit)
  }

  /** Delete a note. Idempotent (no-op on missing). */
  async delete(slug: string): Promise<void> {
    await rm(this.pathFor(slug), { force: true })
  }

  /**
   * Internal: derive a slug from a title and find the next free
   * collision suffix. Probes up to N times before giving up; the
   * cap exists to prevent pathological cases.
   */
  private async deriveUniqueSlug(title: string): Promise<string> {
    const base = deriveSlug(title)
    if (!(await this.exists(base))) return base
    for (let i = 2; i < 1000; i += 1) {
      const candidate = `${base}-${String(i)}`
      if (!(await this.exists(candidate))) return candidate
    }
    throw new Error(`could not find a free slug for title "${title}" within 1000 attempts`)
  }
}
