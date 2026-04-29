/**
 * BrainIndex: SQLite FTS5 index over a per-Agent brain
 * (Epic 8 Phase A PR B).
 *
 * The index is a search accelerator on top of the BrainStore
 * markdown files. The files are the source of truth per
 * [[2026-04-24-brain-is-files-not-database]]; this DB is a derived
 * artifact that can always be rebuilt by walking the brain dir.
 *
 * Schema: one `notes` table holding the canonical fields plus a
 * body_hash column for drift detection, and a `notes_fts` external-
 * content FTS5 virtual table over title + tags + body. Triggers
 * keep the FTS table in sync with the canonical table on insert /
 * update / delete.
 *
 * Single-writer per Agent. v1 trusts that only the Agent process
 * (and the rebuild CLI) opens the DB. Cross-process write
 * contention is out of scope for Phase A.
 */
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { agentBrainIndexPath, homePaths } from '../storage/layout.js'
import type { BrainNote } from './types.js'

export class BrainIndexNotFoundError extends Error {
  constructor(public readonly path: string) {
    super(`brain index not found at ${path}`)
    this.name = 'BrainIndexNotFoundError'
  }
}

export interface SearchHit {
  slug: string
  title: string
  type: string
  tags: string[]
  /** FTS5 snippet of the matching region; HTML-free, may include `<<` `>>` markers around terms. */
  snippet: string
  /** FTS5 bm25 score; lower is better in bm25's convention. We negate and present as "score" for clarity. */
  score: number
}

export interface SearchOptions {
  limit?: number
  /** Optional filter: only these types. */
  types?: string[]
  /** Optional filter: must include at least one of these tags. */
  anyTag?: string[]
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  slug      TEXT PRIMARY KEY,
  title     TEXT NOT NULL,
  type      TEXT NOT NULL,
  tags      TEXT NOT NULL,
  created   TEXT NOT NULL,
  updated   TEXT NOT NULL,
  links     TEXT NOT NULL,
  body      TEXT NOT NULL,
  body_hash TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  slug UNINDEXED,
  title,
  tags,
  body,
  content='notes',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts (rowid, slug, title, tags, body)
  VALUES (new.rowid, new.slug, new.title, new.tags, new.body);
END;

CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, slug, title, tags, body)
  VALUES ('delete', old.rowid, old.slug, old.title, old.tags, old.body);
END;

CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, slug, title, tags, body)
  VALUES ('delete', old.rowid, old.slug, old.title, old.tags, old.body);
  INSERT INTO notes_fts (rowid, slug, title, tags, body)
  VALUES (new.rowid, new.slug, new.title, new.tags, new.body);
END;

CREATE INDEX IF NOT EXISTS notes_type_idx    ON notes(type);
CREATE INDEX IF NOT EXISTS notes_updated_idx ON notes(updated);
`

export class BrainIndex {
  private readonly db: Database.Database
  private readonly upsertStmt: Database.Statement
  private readonly deleteStmt: Database.Statement
  private readonly getBySlugStmt: Database.Statement

  private constructor(db: Database.Database) {
    this.db = db
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.exec(SCHEMA)
    this.upsertStmt = this.db.prepare(`
      INSERT INTO notes (slug, title, type, tags, created, updated, links, body, body_hash)
      VALUES (@slug, @title, @type, @tags, @created, @updated, @links, @body, @body_hash)
      ON CONFLICT(slug) DO UPDATE SET
        title     = excluded.title,
        type      = excluded.type,
        tags      = excluded.tags,
        created   = excluded.created,
        updated   = excluded.updated,
        links     = excluded.links,
        body      = excluded.body,
        body_hash = excluded.body_hash
    `)
    this.deleteStmt = this.db.prepare(`DELETE FROM notes WHERE slug = ?`)
    this.getBySlugStmt = this.db.prepare(`SELECT * FROM notes WHERE slug = ?`)
  }

  /** Open the index DB for an Agent. Creates the file + schema if absent. */
  static open(home: string, agentName: string): BrainIndex {
    return BrainIndex.openAtPath(agentBrainIndexPath(home, agentName))
  }

  /** Open the shared brain index DB (Epic 8 Phase B). */
  static openShared(home: string): BrainIndex {
    return BrainIndex.openAtPath(homePaths(home).sharedBrainIndex)
  }

  /** Open at an explicit path. Used by both per-Agent and shared factories; tests may also use this. */
  static openAtPath(path: string): BrainIndex {
    mkdirSync(dirname(path), { recursive: true })
    const db = new Database(path)
    return new BrainIndex(db)
  }

  /**
   * Open another Agent's brain index in read-only mode (Epic 8 Phase C).
   * The caller must have already verified permission via
   * `canReadBrain`. SQLite supports concurrent readers + a single
   * writer; the owner Agent's writer is unaffected.
   *
   * Throws `BrainIndexNotFoundError` if the file does not exist (the
   * owner has never written a note).
   */
  static openReadOnlyAtPath(path: string): BrainIndex {
    if (!existsSync(path)) {
      throw new BrainIndexNotFoundError(path)
    }
    const db = new Database(path, { readonly: true, fileMustExist: true })
    return new BrainIndex(db)
  }

  /** In-memory variant for tests. */
  static openInMemory(): BrainIndex {
    return new BrainIndex(new Database(':memory:'))
  }

  /** Close the underlying DB. Idempotent. */
  close(): void {
    if (this.db.open) this.db.close()
  }

  /** Insert or replace a note's index row. Body hash is computed here. */
  upsert(note: BrainNote): void {
    this.upsertStmt.run({
      slug: note.slug,
      title: note.frontmatter.title,
      type: note.frontmatter.type,
      tags: note.frontmatter.tags.join(','),
      created: note.frontmatter.created,
      updated: note.frontmatter.updated,
      links: note.frontmatter.links.join(','),
      body: note.body,
      body_hash: hashBody(note.body),
    })
  }

  /** Remove a note from the index. Idempotent on missing slug. */
  delete(slug: string): void {
    this.deleteStmt.run(slug)
  }

  /**
   * Full-text search across title + tags + body. Caller-provided
   * `query` is treated as an FTS5 MATCH expression; non-trivial
   * queries (multiple words, phrase quotes, etc.) are passed
   * through. Special FTS5 characters in single-word queries are
   * escaped to keep the surface friendly.
   */
  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 20, 200))
    const ftsQuery = toFtsQuery(query)
    const parts: string[] = [
      'SELECT n.slug, n.title, n.type, n.tags,',
      `       snippet(notes_fts, -1, '<<', '>>', '…', 12) AS snippet,`,
      '       bm25(notes_fts) AS bm25',
      'FROM notes_fts',
      'JOIN notes n ON n.rowid = notes_fts.rowid',
      'WHERE notes_fts MATCH ?',
    ]
    const params: unknown[] = [ftsQuery]
    if (opts.types && opts.types.length > 0) {
      parts.push(`AND n.type IN (${opts.types.map(() => '?').join(',')})`)
      params.push(...opts.types)
    }
    if (opts.anyTag && opts.anyTag.length > 0) {
      // tags is comma-joined; do a LIKE per requested tag and OR them.
      // For Phase A this is fine; tag cardinality is small.
      const tagClauses = opts.anyTag.map(() => `(',' || n.tags || ',') LIKE ?`).join(' OR ')
      parts.push(`AND (${tagClauses})`)
      for (const t of opts.anyTag) params.push(`%,${t},%`)
    }
    parts.push('ORDER BY bm25 ASC')
    parts.push('LIMIT ?')
    params.push(limit)
    interface SearchRow {
      slug: string
      title: string
      type: string
      tags: string
      snippet: string
      bm25: number
    }
    const rows = this.db.prepare(parts.join(' ')).all(...params) as SearchRow[]
    return rows.map((r) => ({
      slug: r.slug,
      title: r.title,
      type: r.type,
      tags: r.tags.length > 0 ? r.tags.split(',') : [],
      snippet: r.snippet,
      // bm25 is "lower is better" — invert so a higher number means a better hit.
      score: -r.bm25,
    }))
  }

  /** Number of indexed notes. Useful for tests + the rebuild CLI. */
  size(): number {
    return (this.db.prepare(`SELECT COUNT(*) as n FROM notes`).get() as { n: number }).n
  }

  /** True if a slug is present in the index (cheap; no FTS lookup). */
  has(slug: string): boolean {
    return this.getBySlugStmt.get(slug) !== undefined
  }

  /**
   * Replace the entire index with the supplied set of notes. Used
   * by the rebuild CLI (PR D) and by tests. Wraps in a transaction
   * for atomicity + speed.
   */
  rebuildFrom(notes: Iterable<BrainNote>): void {
    const txn = this.db.transaction((items: BrainNote[]) => {
      this.db.exec(`DELETE FROM notes`)
      for (const n of items) this.upsert(n)
    })
    txn([...notes])
  }
}

function hashBody(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 32)
}

/**
 * Translate a free-form user query into an FTS5 MATCH expression.
 *
 * - Multi-word queries are passed through verbatim (FTS5 ANDs by
 *   default).
 * - Quoted phrases are passed through.
 * - Special chars in a single bare word that would otherwise break
 *   the parser are escaped by wrapping in double quotes.
 *
 * v1 is intentionally simple. If callers need richer syntax (NEAR,
 * column qualifiers) they can pass a query that already looks like
 * valid FTS5 (contains a quote or column prefix) and we trust it.
 */
function toFtsQuery(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return '""'
  const looksLikeFts = /[":^]/.test(trimmed) || /\s+(AND|OR|NOT|NEAR)\s+/.test(trimmed)
  if (looksLikeFts) return trimmed
  // Single-word bare query: wrap in double quotes to dodge syntax errors
  // on chars like "-" that FTS5 would otherwise treat as operators.
  if (!/\s/.test(trimmed)) return `"${trimmed.replace(/"/g, '""')}"`
  // Multi-word: split on whitespace, quote each token, AND them implicitly.
  return trimmed
    .split(/\s+/)
    .map((tok) => `"${tok.replace(/"/g, '""')}"`)
    .join(' ')
}
