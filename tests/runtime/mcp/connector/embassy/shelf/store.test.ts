import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyCollectionTransition,
  deleteShelfItem,
  listShelfItems,
  readShelfItem,
  writeShelfItem,
} from '../../../../../../src/runtime/mcp/connector/embassy/shelf/store.js'
import {
  newShelfItemId,
  type ShelfItemFrontmatter,
} from '../../../../../../src/runtime/mcp/connector/embassy/shelf/types.js'

let home: string
const embassy = 'grok-embassy'

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-shelf-store-'))
  // Bare minimum brain dir for agentPaths to resolve.
  await mkdir(join(home, 'agents', embassy, 'brain'), { recursive: true })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function fixtureItem(overrides: Partial<ShelfItemFrontmatter> = {}): ShelfItemFrontmatter {
  const base: ShelfItemFrontmatter = {
    schema_version: 1,
    shelf_item_id: overrides.shelf_item_id ?? newShelfItemId(),
    type: 'question',
    source_type: 'embassy_autonomous',
    source: {
      origin: 'direct',
      reference: null,
      curator: embassy,
      client_id: 'grok-aaa',
      timestamp: '2026-05-26T10:00:00.000Z',
    },
    target_model: 'grok',
    provenance: {
      ingested_at: '2026-05-26T10:00:00.000Z',
      ingested_by: embassy,
      original_contribution_slug: null,
      chain: [],
    },
    priority: 'normal',
    status: 'pending',
    collected_at: null,
    sensitivity: 'none',
  }
  return { ...base, ...overrides }
}

describe('shelf store: write/read round-trip', () => {
  it('persists a parseable shelf item with frontmatter + body', async () => {
    const fm = fixtureItem()
    await writeShelfItem(home, embassy, fm, 'What is the meaning of life?')
    const rec = await readShelfItem(home, embassy, fm.shelf_item_id)
    expect(rec).not.toBeNull()
    expect(rec?.frontmatter.shelf_item_id).toBe(fm.shelf_item_id)
    expect(rec?.frontmatter.type).toBe('question')
    expect(rec?.frontmatter.status).toBe('pending')
    expect(rec?.body).toContain('meaning of life')
  })

  it('readShelfItem returns null for unknown ids', async () => {
    expect(await readShelfItem(home, embassy, 'shelf_nope')).toBeNull()
  })
})

describe('write validation', () => {
  it('rejects status=collected without a collected_at timestamp', async () => {
    const fm = fixtureItem({ status: 'collected', collected_at: null })
    await expect(writeShelfItem(home, embassy, fm, 'body')).rejects.toThrow(
      /collected_at timestamp/,
    )
  })

  it('rejects status=pending WITH a collected_at timestamp', async () => {
    const fm = fixtureItem({ status: 'pending', collected_at: '2026-05-26T11:00:00.000Z' })
    await expect(writeShelfItem(home, embassy, fm, 'body')).rejects.toThrow(/NOT carry/)
  })
})

describe('listShelfItems', () => {
  it('returns an empty array on missing shelf dir', async () => {
    expect(await listShelfItems(home, embassy)).toEqual([])
  })

  it('lists oldest-first by ingested_at', async () => {
    const older = fixtureItem({
      provenance: {
        ingested_at: '2026-05-26T09:00:00.000Z',
        ingested_by: embassy,
        original_contribution_slug: null,
        chain: [],
      },
    })
    const newer = fixtureItem({
      provenance: {
        ingested_at: '2026-05-26T11:00:00.000Z',
        ingested_by: embassy,
        original_contribution_slug: null,
        chain: [],
      },
    })
    await writeShelfItem(home, embassy, older, 'older body')
    await writeShelfItem(home, embassy, newer, 'newer body')
    const items = await listShelfItems(home, embassy)
    expect(items).toHaveLength(2)
    expect(items[0]?.frontmatter.provenance.ingested_at).toBe('2026-05-26T09:00:00.000Z')
    expect(items[1]?.frontmatter.provenance.ingested_at).toBe('2026-05-26T11:00:00.000Z')
  })

  it('filters by status / type / priority', async () => {
    await writeShelfItem(home, embassy, fixtureItem({ type: 'question', priority: 'normal' }), 'q1')
    await writeShelfItem(
      home,
      embassy,
      fixtureItem({
        type: 'context',
        priority: 'high',
        status: 'collected',
        collected_at: '2026-05-26T11:00:00.000Z',
      }),
      'ctx1',
    )
    await writeShelfItem(home, embassy, fixtureItem({ type: 'question', priority: 'high' }), 'q2')
    expect(await listShelfItems(home, embassy, { type: 'question' })).toHaveLength(2)
    expect(await listShelfItems(home, embassy, { priority: 'high' })).toHaveLength(2)
    expect(await listShelfItems(home, embassy, { status: 'pending' })).toHaveLength(2)
    expect(await listShelfItems(home, embassy, { status: 'collected' })).toHaveLength(1)
  })
})

describe('deleteShelfItem', () => {
  it('is idempotent', async () => {
    const fm = fixtureItem()
    await writeShelfItem(home, embassy, fm, 'body')
    expect(await deleteShelfItem(home, embassy, fm.shelf_item_id)).toBe(true)
    expect(await deleteShelfItem(home, embassy, fm.shelf_item_id)).toBe(false)
  })
})

describe('applyCollectionTransition', () => {
  it('one-shot type: pending → collected on pull', async () => {
    const fm = fixtureItem({ type: 'question' }) // one-shot
    await writeShelfItem(home, embassy, fm, 'body')
    const result = await applyCollectionTransition(
      home,
      embassy,
      fm.shelf_item_id,
      new Date('2026-05-26T12:00:00Z'),
    )
    expect(result.transitioned).toBe(true)
    expect(result.record.frontmatter.status).toBe('collected')
    expect(result.record.frontmatter.collected_at).toBe('2026-05-26T12:00:00.000Z')
  })

  it('standing type: stays pending after pull', async () => {
    const fm = fixtureItem({ type: 'context' }) // standing
    await writeShelfItem(home, embassy, fm, 'body')
    const result = await applyCollectionTransition(home, embassy, fm.shelf_item_id, new Date())
    expect(result.transitioned).toBe(false)
    expect(result.record.frontmatter.status).toBe('pending')
  })

  it('already collected: idempotent no-op', async () => {
    const fm = fixtureItem({
      type: 'question',
      status: 'collected',
      collected_at: '2026-05-26T11:00:00.000Z',
    })
    await writeShelfItem(home, embassy, fm, 'body')
    const result = await applyCollectionTransition(home, embassy, fm.shelf_item_id, new Date())
    expect(result.transitioned).toBe(false)
  })

  it('throws on unknown shelf_item_id', async () => {
    await expect(
      applyCollectionTransition(home, embassy, 'shelf_nope', new Date()),
    ).rejects.toThrow(/unknown shelf_item_id/)
  })
})
