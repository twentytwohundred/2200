/**
 * Tests for the brain note store and its type helpers
 * (Epic 8 Phase A PR A).
 *
 * Covers: slug derivation (including collision suffixing), link
 * extraction, round-trip read/write, list filtering, malformed
 * file tolerance, atomic writes (no half-written files), delete
 * idempotency, and that supplied slugs override the derivation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initHome } from '../../../src/runtime/storage/init.js'
import { agentPaths } from '../../../src/runtime/storage/layout.js'
import {
  deriveSlug,
  extractLinks,
  type BrainFrontmatter,
} from '../../../src/runtime/brain/types.js'
import { BrainStore } from '../../../src/runtime/brain/store.js'
import { parseBrainNote, serializeBrainNote } from '../../../src/runtime/brain/serialize.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-brain-store-'))
  await initHome(home)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('deriveSlug', () => {
  it('lowercases and dashes whitespace', () => {
    expect(deriveSlug('Hello World')).toBe('hello-world')
  })
  it('strips punctuation', () => {
    expect(deriveSlug("Doug's Hot Take!")).toBe('dougs-hot-take')
  })
  it('collapses runs of dashes and trims', () => {
    expect(deriveSlug('--multiple   spaces--')).toBe('multiple-spaces')
  })
  it('caps at 80 chars', () => {
    const long = 'a '.repeat(200)
    const slug = deriveSlug(long)
    expect(slug.length).toBeLessThanOrEqual(80)
  })
  it('throws when no usable characters remain', () => {
    expect(() => deriveSlug('!!!')).toThrow(/cannot derive a slug/)
  })
  it('handles accented chars via NFKD-strip (café → cafe)', () => {
    expect(deriveSlug('café')).toBe('cafe')
  })
})

describe('extractLinks', () => {
  it('finds bracket-bracket links', () => {
    expect(extractLinks('See [[my-note]] for details.')).toEqual(['my-note'])
  })
  it('returns multiple links in order without duplicates', () => {
    const body = 'See [[a]] and [[b]] and [[a]] again, plus [[c-d]].'
    expect(extractLinks(body)).toEqual(['a', 'b', 'c-d'])
  })
  it('ignores invalid slug shapes inside brackets', () => {
    expect(extractLinks('No match: [[BAD slug with spaces]] [[ok-slug]]')).toEqual(['ok-slug'])
  })
  it('returns [] when there are no links', () => {
    expect(extractLinks('Plain text body.')).toEqual([])
  })
})

describe('serialize/parse round-trip', () => {
  it('preserves canonical fields', () => {
    const fm: BrainFrontmatter = {
      brain_schema_version: 1,
      title: 'Test note',
      type: 'project',
      tags: ['alpha', 'beta'],
      created: '2026-04-28T10:00:00.000Z',
      updated: '2026-04-28T11:00:00.000Z',
      links: ['other-slug'],
    }
    const text = serializeBrainNote({ frontmatter: fm, extras: {}, body: 'Body content.\n' })
    const parsed = parseBrainNote(text, '/test')
    expect(parsed.frontmatter).toEqual(fm)
    expect(parsed.body).toBe('Body content.\n')
  })

  it('round-trips extras', () => {
    const fm: BrainFrontmatter = {
      brain_schema_version: 1,
      title: 'with extras',
      type: 'feedback',
      tags: [],
      created: '2026-04-28T10:00:00.000Z',
      updated: '2026-04-28T10:00:00.000Z',
      links: [],
    }
    const text = serializeBrainNote({
      frontmatter: fm,
      extras: { source_pr: '#123' },
      body: 'x',
    })
    const parsed = parseBrainNote(text, '/test')
    expect(parsed.extras['source_pr']).toBe('#123')
  })

  it('rejects a file with no frontmatter', () => {
    expect(() => parseBrainNote('no frontmatter here', '/test')).toThrow(/no YAML frontmatter/)
  })
})

describe('BrainStore.write', () => {
  it('creates a new note with a derived slug and returns the right path', async () => {
    const store = new BrainStore(home, 'hobby')
    const r = await store.write({
      title: 'My First Note',
      body: 'Hello world.',
    })
    expect(r.slug).toBe('my-first-note')
    expect(r.created).toBe(true)
    expect(r.path).toBe(join(agentPaths(home, 'hobby').brain, 'my-first-note.md'))
    const text = await readFile(r.path, 'utf8')
    expect(text).toContain('title: My First Note')
    expect(text).toContain('Hello world.')
  })

  it('extracts links from the body into the frontmatter', async () => {
    const store = new BrainStore(home, 'hobby')
    await store.write({
      title: 'parent',
      body: 'Refs [[child-a]] and [[child-b]].',
    })
    const note = await store.read('parent')
    expect(note.frontmatter.links).toEqual(['child-a', 'child-b'])
  })

  it('honors a supplied slug verbatim and treats re-write as upsert', async () => {
    const store = new BrainStore(home, 'hobby')
    const t0 = '2026-04-28T10:00:00.000Z'
    const t1 = '2026-04-28T11:00:00.000Z'
    const first = await store.write({
      title: 'v1',
      body: 'first',
      slug: 'pinned-slug',
      now: () => new Date(t0),
    })
    expect(first.created).toBe(true)
    const second = await store.write({
      title: 'v2',
      body: 'second',
      slug: 'pinned-slug',
      now: () => new Date(t1),
    })
    expect(second.created).toBe(false)
    const note = await store.read('pinned-slug')
    expect(note.body.trim()).toBe('second')
    expect(note.frontmatter.title).toBe('v2')
    // created preserved across upsert; updated bumped to second-write time
    expect(note.frontmatter.created).toBe(t0)
    expect(note.frontmatter.updated).toBe(t1)
  })

  it('appends -2/-3/... on slug collision when no explicit slug is supplied', async () => {
    const store = new BrainStore(home, 'hobby')
    const a = await store.write({ title: 'collide', body: 'one' })
    const b = await store.write({ title: 'collide', body: 'two' })
    const c = await store.write({ title: 'collide', body: 'three' })
    expect(a.slug).toBe('collide')
    expect(b.slug).toBe('collide-2')
    expect(c.slug).toBe('collide-3')
  })

  it('updates `updated` while preserving `created`', async () => {
    const store = new BrainStore(home, 'hobby')
    const t0 = '2026-04-28T10:00:00.000Z'
    const t1 = '2026-04-28T11:00:00.000Z'
    await store.write({
      title: 'note',
      body: 'a',
      slug: 'note',
      now: () => new Date(t0),
    })
    await store.write({
      title: 'note',
      body: 'b',
      slug: 'note',
      now: () => new Date(t1),
    })
    const reread = await store.read('note')
    expect(reread.frontmatter.created).toBe(t0)
    expect(reread.frontmatter.updated).toBe(t1)
    // Title also got refreshed on update.
    expect(reread.frontmatter.title).toBe('note')
  })

  it('defaults type to "freeform" and tags to []', async () => {
    const store = new BrainStore(home, 'hobby')
    const r = await store.write({ title: 'defaults', body: 'x' })
    const note = await store.read(r.slug)
    expect(note.frontmatter.type).toBe('freeform')
    expect(note.frontmatter.tags).toEqual([])
  })
})

describe('BrainStore.list', () => {
  it('returns [] when the dir does not exist', async () => {
    const store = new BrainStore(home, 'hobby')
    expect(await store.list()).toEqual([])
  })

  it('lists notes sorted by updated descending', async () => {
    const store = new BrainStore(home, 'hobby')
    await store.write({
      title: 'oldest',
      body: 'o',
      slug: 'old',
      now: () => new Date('2026-04-26T10:00:00.000Z'),
    })
    await store.write({
      title: 'middle',
      body: 'm',
      slug: 'mid',
      now: () => new Date('2026-04-27T10:00:00.000Z'),
    })
    await store.write({
      title: 'newest',
      body: 'n',
      slug: 'new',
      now: () => new Date('2026-04-28T10:00:00.000Z'),
    })
    const list = await store.list()
    expect(list.map((n) => n.slug)).toEqual(['new', 'mid', 'old'])
  })

  it('filters by type', async () => {
    const store = new BrainStore(home, 'hobby')
    await store.write({ title: 'a', body: 'x', type: 'feedback' })
    await store.write({ title: 'b', body: 'x', type: 'project' })
    await store.write({ title: 'c', body: 'x', type: 'feedback' })
    const list = await store.list({ type: 'feedback' })
    expect(list.map((n) => n.slug).sort()).toEqual(['a', 'c'])
  })

  it('filters by tag', async () => {
    const store = new BrainStore(home, 'hobby')
    await store.write({ title: 'a', body: 'x', tags: ['ops', 'mvp'] })
    await store.write({ title: 'b', body: 'x', tags: ['ops'] })
    await store.write({ title: 'c', body: 'x', tags: ['research'] })
    const list = await store.list({ tag: 'ops' })
    expect(list.map((n) => n.slug).sort()).toEqual(['a', 'b'])
  })

  it('respects the limit', async () => {
    const store = new BrainStore(home, 'hobby')
    for (let i = 0; i < 5; i += 1) {
      await store.write({
        title: `note-${String(i)}`,
        body: 'x',
        now: () => new Date(`2026-04-2${String(i + 1)}T00:00:00.000Z`),
      })
    }
    const list = await store.list({ limit: 2 })
    expect(list).toHaveLength(2)
  })

  it('skips malformed files instead of throwing', async () => {
    const store = new BrainStore(home, 'hobby')
    await store.write({ title: 'good', body: 'g', slug: 'good' })
    const dir = store.dir()
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'broken.md'), 'no frontmatter at all')
    const list = await store.list()
    expect(list.map((n) => n.slug)).toEqual(['good'])
  })
})

describe('BrainStore.delete + exists', () => {
  it('delete removes the file and exists reflects state', async () => {
    const store = new BrainStore(home, 'hobby')
    await store.write({ title: 'doomed', body: 'x', slug: 'doomed' })
    expect(await store.exists('doomed')).toBe(true)
    await store.delete('doomed')
    expect(await store.exists('doomed')).toBe(false)
  })

  it('delete is idempotent on missing slug', async () => {
    const store = new BrainStore(home, 'hobby')
    await expect(store.delete('never-existed')).resolves.not.toThrow()
  })
})

describe('BrainStore.read / tryRead', () => {
  it('read throws ENOENT-shaped error on missing slug', async () => {
    const store = new BrainStore(home, 'hobby')
    await expect(store.read('missing')).rejects.toThrow()
  })

  it('tryRead returns null on missing slug', async () => {
    const store = new BrainStore(home, 'hobby')
    expect(await store.tryRead('missing')).toBeNull()
  })
})
