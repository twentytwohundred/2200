/**
 * Tests for the catalog-gap tracker (Phase F §0a-2 follow-up).
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  listCatalogGaps,
  recordCatalogGap,
  resolveGapsDir,
  slugifyGapId,
  CatalogGapFrontmatterSchema,
} from '../../../src/runtime/onboarding/catalog-gap.js'

describe('slugifyGapId', () => {
  it('produces a kebab-case slug from free-form text', () => {
    expect(slugifyGapId('Notion integration for note sync')).toBe(
      'notion-integration-for-note-sync',
    )
  })

  it('strips leading/trailing dashes and collapses runs', () => {
    expect(slugifyGapId('  ---hello---world---  ')).toBe('hello-world')
  })

  it('caps length at 60 chars', () => {
    const long = 'a'.repeat(200)
    expect(slugifyGapId(long).length).toBeLessThanOrEqual(60)
  })

  it('returns a timestamp fallback when slug would be empty', () => {
    const fixed = new Date('2026-05-18T12:00:00.000Z')
    const out = slugifyGapId('!@#$%', fixed)
    expect(out).toMatch(/^gap-2026-05-18-/)
  })

  it('returns a timestamp fallback when slug starts with a digit', () => {
    const fixed = new Date('2026-05-18T12:00:00.000Z')
    expect(slugifyGapId('123 numeric start', fixed)).toMatch(/^gap-/)
  })
})

describe('CatalogGapFrontmatterSchema', () => {
  it('accepts a minimal valid entry with defaults filled in', () => {
    const parsed = CatalogGapFrontmatterSchema.parse({
      id: 'notion',
      recorded_at: '2026-05-18T12:00:00.000Z',
      operator_description: 'Notion integration',
    })
    expect(parsed.context).toBe('manual')
    expect(parsed.status).toBe('open')
    expect(parsed.related_intent_tags).toEqual([])
  })

  it('rejects an id with uppercase or underscores', () => {
    expect(() =>
      CatalogGapFrontmatterSchema.parse({
        id: 'BadName',
        recorded_at: '2026-05-18T12:00:00.000Z',
        operator_description: 'x',
      }),
    ).toThrow()
    expect(() =>
      CatalogGapFrontmatterSchema.parse({
        id: 'snake_case',
        recorded_at: '2026-05-18T12:00:00.000Z',
        operator_description: 'x',
      }),
    ).toThrow()
  })

  it('rejects an empty operator_description', () => {
    expect(() =>
      CatalogGapFrontmatterSchema.parse({
        id: 'x',
        recorded_at: '2026-05-18T12:00:00.000Z',
        operator_description: '',
      }),
    ).toThrow()
  })
})

describe('recordCatalogGap + listCatalogGaps', () => {
  let gapsDir: string

  beforeEach(async () => {
    gapsDir = await mkdtemp(join(tmpdir(), '2200-gaps-'))
  })

  afterEach(async () => {
    await rm(gapsDir, { recursive: true, force: true })
  })

  it('writes a valid markdown file with frontmatter to the dir', async () => {
    const rec = await recordCatalogGap({
      operator_description: 'I want Notion sync',
      dir: gapsDir,
      now: () => new Date('2026-05-18T12:00:00.000Z'),
    })
    expect(rec.frontmatter.id).toBe('i-want-notion-sync')
    expect(rec.frontmatter.context).toBe('manual')
    expect(rec.frontmatter.status).toBe('open')
    const onDisk = await readFile(rec.source_path, 'utf-8')
    expect(onDisk).toContain('id: i-want-notion-sync')
    expect(onDisk).toContain('operator_description: I want Notion sync')
    expect(onDisk).toContain('status: open')
  })

  it('honors an explicit id', async () => {
    const rec = await recordCatalogGap({
      operator_description: 'something',
      id: 'custom-slug',
      dir: gapsDir,
      now: () => new Date('2026-05-18T12:00:00.000Z'),
    })
    expect(rec.frontmatter.id).toBe('custom-slug')
    expect(rec.source_path).toContain('custom-slug.md')
  })

  it('persists context, agent_name, and related_intent_tags when provided', async () => {
    const rec = await recordCatalogGap({
      operator_description: 'Linear integration',
      context: 'onboarding',
      agent_name: 'pilot',
      related_intent_tags: ['linear', 'project_management'],
      dir: gapsDir,
      now: () => new Date('2026-05-18T12:00:00.000Z'),
    })
    expect(rec.frontmatter.context).toBe('onboarding')
    expect(rec.frontmatter.agent_name).toBe('pilot')
    expect(rec.frontmatter.related_intent_tags).toEqual(['linear', 'project_management'])
  })

  it('attaches an optional body when provided', async () => {
    const rec = await recordCatalogGap({
      operator_description: 'with body',
      body: 'Longer rationale here.\n\nMultiline.',
      dir: gapsDir,
      now: () => new Date('2026-05-18T12:00:00.000Z'),
    })
    expect(rec.body).toBe('Longer rationale here.\n\nMultiline.')
    const onDisk = await readFile(rec.source_path, 'utf-8')
    expect(onDisk).toContain('Longer rationale here.')
  })

  it('throws when a gap with the same id already exists (no silent overwrite)', async () => {
    await recordCatalogGap({
      operator_description: 'first',
      id: 'dup',
      dir: gapsDir,
      now: () => new Date('2026-05-18T12:00:00.000Z'),
    })
    await expect(
      recordCatalogGap({
        operator_description: 'second',
        id: 'dup',
        dir: gapsDir,
        now: () => new Date('2026-05-18T12:00:01.000Z'),
      }),
    ).rejects.toThrow(/already exists/)
  })

  it('with if_exists="skip", returns the existing record unchanged', async () => {
    const first = await recordCatalogGap({
      operator_description: 'first description',
      id: 'idempotent',
      dir: gapsDir,
      now: () => new Date('2026-05-18T12:00:00.000Z'),
    })
    const second = await recordCatalogGap({
      operator_description: 'different description on the second call',
      id: 'idempotent',
      dir: gapsDir,
      now: () => new Date('2026-05-18T13:00:00.000Z'),
      if_exists: 'skip',
    })
    expect(second.frontmatter.id).toBe('idempotent')
    expect(second.frontmatter.recorded_at).toBe(first.frontmatter.recorded_at)
    expect(second.frontmatter.operator_description).toBe('first description')
  })

  it('with if_exists="fail" explicitly (matches default), still throws', async () => {
    await recordCatalogGap({
      operator_description: 'first',
      id: 'explicit-fail',
      dir: gapsDir,
      now: () => new Date('2026-05-18T12:00:00.000Z'),
    })
    await expect(
      recordCatalogGap({
        operator_description: 'second',
        id: 'explicit-fail',
        dir: gapsDir,
        now: () => new Date('2026-05-18T12:00:01.000Z'),
        if_exists: 'fail',
      }),
    ).rejects.toThrow(/already exists/)
  })

  it('lists recorded gaps sorted by recorded_at descending', async () => {
    await recordCatalogGap({
      operator_description: 'older',
      id: 'older',
      dir: gapsDir,
      now: () => new Date('2026-05-17T12:00:00.000Z'),
    })
    await recordCatalogGap({
      operator_description: 'newer',
      id: 'newer',
      dir: gapsDir,
      now: () => new Date('2026-05-18T12:00:00.000Z'),
    })
    const list = await listCatalogGaps({ dir: gapsDir })
    expect(list.map((r) => r.frontmatter.id)).toEqual(['newer', 'older'])
  })

  it('filters by status', async () => {
    await recordCatalogGap({
      operator_description: 'open one',
      id: 'open-one',
      dir: gapsDir,
      now: () => new Date('2026-05-18T12:00:00.000Z'),
    })
    // Manually craft a resolved entry on disk (recordCatalogGap only
    // writes status=open; the resolved transition happens via direct
    // file edit per v1 scope).
    const resolvedYaml = `---
id: resolved-one
recorded_at: 2026-05-18T12:00:00.000Z
operator_description: resolved sample
context: manual
related_intent_tags: []
status: resolved
resolution_note: subsumed by google-workspace
---
`
    await writeFile(join(gapsDir, 'resolved-one.md'), resolvedYaml, 'utf-8')
    const onlyOpen = await listCatalogGaps({ dir: gapsDir, status: 'open' })
    expect(onlyOpen.map((r) => r.frontmatter.id)).toEqual(['open-one'])
    const onlyResolved = await listCatalogGaps({ dir: gapsDir, status: 'resolved' })
    expect(onlyResolved.map((r) => r.frontmatter.id)).toEqual(['resolved-one'])
  })

  it('returns [] when the dir does not exist (fresh install)', async () => {
    const missing = join(tmpdir(), '2200-gaps-missing-does-not-exist')
    expect(await listCatalogGaps({ dir: missing })).toEqual([])
  })

  it('skips malformed entries with a warn (no throw) instead of erroring out', async () => {
    await recordCatalogGap({
      operator_description: 'good entry',
      id: 'good',
      dir: gapsDir,
      now: () => new Date('2026-05-18T12:00:00.000Z'),
    })
    await writeFile(join(gapsDir, 'malformed.md'), 'no frontmatter here', 'utf-8')
    const list = await listCatalogGaps({ dir: gapsDir })
    expect(list.map((r) => r.frontmatter.id)).toEqual(['good'])
  })

  it('skips README.md to keep documentation files out of the listing', async () => {
    await recordCatalogGap({
      operator_description: 'real entry',
      id: 'real',
      dir: gapsDir,
      now: () => new Date('2026-05-18T12:00:00.000Z'),
    })
    await writeFile(join(gapsDir, 'README.md'), '# README\nDocs.', 'utf-8')
    const list = await listCatalogGaps({ dir: gapsDir })
    expect(list.map((r) => r.frontmatter.id)).toEqual(['real'])
  })
})

describe('resolveGapsDir', () => {
  let envSnapshot: string | undefined
  beforeEach(() => {
    envSnapshot = process.env['_2200_GAPS_DIR']
    delete process.env['_2200_GAPS_DIR']
  })
  afterEach(() => {
    if (envSnapshot === undefined) delete process.env['_2200_GAPS_DIR']
    else process.env['_2200_GAPS_DIR'] = envSnapshot
  })

  it('honors the _2200_GAPS_DIR env override when the dir exists', async () => {
    const tmp = await mkdtemp(join(tmpdir(), '2200-gaps-env-'))
    try {
      process.env['_2200_GAPS_DIR'] = tmp
      expect(resolveGapsDir()).toBe(tmp)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  it('falls through when _2200_GAPS_DIR points at a non-existent path', () => {
    process.env['_2200_GAPS_DIR'] = '/var/folders/does-not-exist-anywhere-blah'
    // The function will still try the local and dev fallbacks. We don't
    // assert a specific result here (depends on $HOME / cwd); we just
    // assert it doesn't throw and doesn't return the bogus env path.
    expect(resolveGapsDir()).not.toBe('/var/folders/does-not-exist-anywhere-blah')
  })
})
