/**
 * Tests for BrainIndex (Epic 8 PR B).
 *
 * Uses an in-memory DB to keep tests hermetic. Real on-disk DB
 * behavior (path creation, multi-process not at v1) is exercised by
 * the integration test in PR C/D (where the brain.* MCP tools open
 * the index against a tempdir Agent home).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrainIndex } from '../../../src/runtime/brain/index-db.js'
import type { BrainNote } from '../../../src/runtime/brain/types.js'

let index: BrainIndex

function note(
  partial: Partial<BrainNote> & { slug: string; title: string; body: string },
): BrainNote {
  return {
    slug: partial.slug,
    path: partial.path ?? `/tmp/${partial.slug}.md`,
    frontmatter: {
      brain_schema_version: 1,
      title: partial.title,
      type: partial.frontmatter?.type ?? 'freeform',
      tags: partial.frontmatter?.tags ?? [],
      created: partial.frontmatter?.created ?? '2026-04-28T10:00:00.000Z',
      updated: partial.frontmatter?.updated ?? '2026-04-28T10:00:00.000Z',
      links: partial.frontmatter?.links ?? [],
    },
    extras: partial.extras ?? {},
    body: partial.body,
  }
}

beforeEach(() => {
  index = BrainIndex.openInMemory()
})

afterEach(() => {
  index.close()
})

describe('BrainIndex.upsert + has + size', () => {
  it('starts empty', () => {
    expect(index.size()).toBe(0)
    expect(index.has('whatever')).toBe(false)
  })

  it('inserts a row', () => {
    index.upsert(note({ slug: 'a', title: 'A', body: 'hello world' }))
    expect(index.size()).toBe(1)
    expect(index.has('a')).toBe(true)
  })

  it('updates an existing row instead of duplicating', () => {
    index.upsert(note({ slug: 'a', title: 'first', body: 'one' }))
    index.upsert(note({ slug: 'a', title: 'second', body: 'two' }))
    expect(index.size()).toBe(1)
  })

  it('persists tags as comma-joined and round-trips through search', () => {
    index.upsert(
      note({
        slug: 'a',
        title: 'Tagged',
        body: 'kernel is fast',
        frontmatter: {
          brain_schema_version: 1,
          title: 'Tagged',
          type: 'project',
          tags: ['perf', 'observability'],
          created: '2026-04-28T10:00:00.000Z',
          updated: '2026-04-28T10:00:00.000Z',
          links: [],
        },
      }),
    )
    const hits = index.search('kernel')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.tags).toEqual(['perf', 'observability'])
  })
})

describe('BrainIndex.search', () => {
  beforeEach(() => {
    index.upsert(note({ slug: 'cron', title: 'Cron how-to', body: 'every Monday at 9am' }))
    index.upsert(note({ slug: 'pub', title: 'Pub etiquette', body: 'when to mention an Agent' }))
    index.upsert(
      note({
        slug: 'budget',
        title: 'Budget caps',
        body: 'cap is in usd; threshold of 0.8 warns; 1.0 blocks',
      }),
    )
  })

  it('returns the matching row for a single-term query', () => {
    const hits = index.search('cron')
    expect(hits.map((h) => h.slug)).toEqual(['cron'])
  })

  it('returns the matching row for a multi-term query (AND semantics)', () => {
    const hits = index.search('cap usd')
    expect(hits.map((h) => h.slug)).toEqual(['budget'])
  })

  it('returns empty for a query with no matches', () => {
    const hits = index.search('nonexistent term that does not match')
    expect(hits).toEqual([])
  })

  it('respects the limit', () => {
    // Add a few more rows that all match a common term.
    index.upsert(note({ slug: 'a', title: 'note', body: 'apple banana' }))
    index.upsert(note({ slug: 'b', title: 'note', body: 'apple cherry' }))
    index.upsert(note({ slug: 'c', title: 'note', body: 'apple date' }))
    const hits = index.search('apple', { limit: 2 })
    expect(hits).toHaveLength(2)
  })

  it('filters by type', () => {
    index.upsert(
      note({
        slug: 'fb1',
        title: 'feedback note',
        body: 'apple',
        frontmatter: {
          brain_schema_version: 1,
          title: 'fb1',
          type: 'feedback',
          tags: [],
          created: '2026-04-28T10:00:00.000Z',
          updated: '2026-04-28T10:00:00.000Z',
          links: [],
        },
      }),
    )
    index.upsert(
      note({
        slug: 'fr1',
        title: 'freeform note',
        body: 'apple',
        frontmatter: {
          brain_schema_version: 1,
          title: 'fr1',
          type: 'freeform',
          tags: [],
          created: '2026-04-28T10:00:00.000Z',
          updated: '2026-04-28T10:00:00.000Z',
          links: [],
        },
      }),
    )
    const hits = index.search('apple', { types: ['feedback'] })
    expect(hits.map((h) => h.slug)).toEqual(['fb1'])
  })

  it('filters by tag (OR-of-anyTag semantics)', () => {
    index.upsert(
      note({
        slug: 'tagged-a',
        title: 'a',
        body: 'kernel',
        frontmatter: {
          brain_schema_version: 1,
          title: 'a',
          type: 'freeform',
          tags: ['perf'],
          created: '2026-04-28T10:00:00.000Z',
          updated: '2026-04-28T10:00:00.000Z',
          links: [],
        },
      }),
    )
    index.upsert(
      note({
        slug: 'tagged-b',
        title: 'b',
        body: 'kernel',
        frontmatter: {
          brain_schema_version: 1,
          title: 'b',
          type: 'freeform',
          tags: ['ux'],
          created: '2026-04-28T10:00:00.000Z',
          updated: '2026-04-28T10:00:00.000Z',
          links: [],
        },
      }),
    )
    const hits = index.search('kernel', { anyTag: ['perf'] })
    expect(hits.map((h) => h.slug)).toEqual(['tagged-a'])
  })

  it('produces a snippet around the matching term', () => {
    const hits = index.search('Monday')
    expect(hits[0]!.snippet).toMatch(/<<Monday>>/)
  })

  it('escapes punctuation in single-word bare queries (no FTS syntax error)', () => {
    index.upsert(note({ slug: 'dashed', title: 'dashed', body: 'pub-server runs supervised' }))
    expect(() => index.search('pub-server')).not.toThrow()
    const hits = index.search('pub-server')
    expect(hits.map((h) => h.slug)).toContain('dashed')
  })
})

describe('BrainIndex.delete', () => {
  it('removes the row and its FTS entry', () => {
    index.upsert(note({ slug: 'doomed', title: 'doomed', body: 'apple' }))
    expect(index.has('doomed')).toBe(true)
    index.delete('doomed')
    expect(index.has('doomed')).toBe(false)
    expect(index.search('apple')).toEqual([])
  })

  it('is idempotent on missing slug', () => {
    expect(() => {
      index.delete('never-existed')
    }).not.toThrow()
  })
})

describe('BrainIndex.rebuildFrom', () => {
  it('replaces all rows atomically', () => {
    index.upsert(note({ slug: 'old-1', title: 'old', body: 'apple' }))
    index.upsert(note({ slug: 'old-2', title: 'old', body: 'apple' }))
    expect(index.size()).toBe(2)

    index.rebuildFrom([
      note({ slug: 'fresh-1', title: 'fresh', body: 'banana' }),
      note({ slug: 'fresh-2', title: 'fresh', body: 'banana' }),
      note({ slug: 'fresh-3', title: 'fresh', body: 'banana' }),
    ])

    expect(index.size()).toBe(3)
    expect(index.has('old-1')).toBe(false)
    expect(index.has('fresh-1')).toBe(true)
  })

  it('rebuild from an empty iterable wipes the table', () => {
    index.upsert(note({ slug: 'a', title: 'a', body: 'x' }))
    index.rebuildFrom([])
    expect(index.size()).toBe(0)
  })
})
