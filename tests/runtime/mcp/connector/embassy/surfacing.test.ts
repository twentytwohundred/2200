/**
 * Unit tests for the shelf_preview surfacing logic (PR-B4).
 * Verifies the locked priority order, self_reflected detection,
 * excerpt truncation, and long-tail summary counts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildShelfPreview,
  EXCERPT_CHARS,
  SHELF_PREVIEW_CAP,
} from '../../../../../src/runtime/mcp/connector/embassy/surfacing.js'
import { writeShelfItem } from '../../../../../src/runtime/mcp/connector/embassy/shelf/store.js'
import {
  newShelfItemId,
  type ShelfItemFrontmatter,
  type ShelfItemType,
} from '../../../../../src/runtime/mcp/connector/embassy/shelf/types.js'

let home: string
const embassy = 'grok-embassy'
const callingClientId = 'grok-aaa'

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-surfacing-'))
  await mkdir(join(home, 'agents', embassy, 'brain'), { recursive: true })
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

interface FixtureOpts {
  type?: ShelfItemType
  priority?: 'high' | 'normal'
  status?: 'pending' | 'collected'
  ingested_at?: string
  source_client_id?: string | null
  source_type?: 'human_curated' | 'embassy_autonomous'
  body?: string
}

async function place(opts: FixtureOpts = {}): Promise<string> {
  const id = newShelfItemId()
  const fm: ShelfItemFrontmatter = {
    schema_version: 1,
    shelf_item_id: id,
    type: opts.type ?? 'question',
    source_type: opts.source_type ?? 'embassy_autonomous',
    source: {
      origin: 'direct',
      reference: null,
      curator: embassy,
      client_id: opts.source_client_id === undefined ? callingClientId : opts.source_client_id,
      timestamp: '2026-05-27T10:00:00.000Z',
    },
    target_model: 'grok',
    provenance: {
      ingested_at: opts.ingested_at ?? '2026-05-27T10:00:00.000Z',
      ingested_by: embassy,
      original_contribution_slug: null,
      chain: [],
    },
    priority: opts.priority ?? 'normal',
    status: opts.status ?? 'pending',
    collected_at: opts.status === 'collected' ? '2026-05-27T11:00:00.000Z' : null,
    sensitivity: 'none',
  }
  await writeShelfItem(home, embassy, fm, opts.body ?? 'body')
  return id
}

describe('buildShelfPreview', () => {
  it('returns an empty preview when the shelf is empty', async () => {
    const p = await buildShelfPreview(home, embassy, callingClientId)
    expect(p.items).toHaveLength(0)
    expect(p.total_pending).toBe(0)
    expect(p.standing_pending).toBe(0)
    expect(p.one_shot_pending).toBe(0)
  })

  it('counts pending vs collected correctly in the summary', async () => {
    await place({ type: 'question' })
    await place({ type: 'context' })
    await place({
      type: 'question',
      status: 'collected',
    })
    const p = await buildShelfPreview(home, embassy, callingClientId)
    expect(p.total_pending).toBe(2)
    expect(p.one_shot_pending).toBe(1)
    expect(p.standing_pending).toBe(1)
  })

  it('orders standing-pending items above one-shot-pending of the same priority', async () => {
    const oneshot = await place({
      type: 'question',
      priority: 'normal',
      ingested_at: '2026-05-27T11:00:00.000Z',
    })
    const standing = await place({
      type: 'context',
      priority: 'normal',
      ingested_at: '2026-05-27T10:00:00.000Z', // OLDER than the one-shot
    })
    const p = await buildShelfPreview(home, embassy, callingClientId)
    expect(p.items[0]?.shelf_item_id).toBe(standing)
    expect(p.items[1]?.shelf_item_id).toBe(oneshot)
  })

  it('orders high priority above normal within the same standing/one-shot class', async () => {
    const normal = await place({
      type: 'question',
      priority: 'normal',
      ingested_at: '2026-05-27T11:00:00.000Z',
    })
    const high = await place({
      type: 'question',
      priority: 'high',
      ingested_at: '2026-05-27T10:00:00.000Z',
    })
    const p = await buildShelfPreview(home, embassy, callingClientId)
    expect(p.items[0]?.shelf_item_id).toBe(high)
    expect(p.items[1]?.shelf_item_id).toBe(normal)
  })

  it('orders by recent ingested_at descending as the final tie-breaker', async () => {
    const older = await place({
      type: 'question',
      priority: 'normal',
      ingested_at: '2026-05-27T09:00:00.000Z',
    })
    const newer = await place({
      type: 'question',
      priority: 'normal',
      ingested_at: '2026-05-27T11:00:00.000Z',
    })
    const p = await buildShelfPreview(home, embassy, callingClientId)
    expect(p.items[0]?.shelf_item_id).toBe(newer)
    expect(p.items[1]?.shelf_item_id).toBe(older)
  })

  it('places collected standing items below all pending items', async () => {
    const collectedStanding = await place({
      type: 'context',
      status: 'collected',
      ingested_at: '2026-05-27T11:00:00.000Z',
    })
    const pendingOneshot = await place({
      type: 'question',
      ingested_at: '2026-05-27T09:00:00.000Z',
    })
    const p = await buildShelfPreview(home, embassy, callingClientId)
    expect(p.items[0]?.shelf_item_id).toBe(pendingOneshot)
    expect(p.items[1]?.shelf_item_id).toBe(collectedStanding)
  })

  it('caps inline items at SHELF_PREVIEW_CAP and feeds the rest into next_priority_ids', async () => {
    const N = SHELF_PREVIEW_CAP + 5
    for (let i = 0; i < N; i++) {
      await place({ ingested_at: `2026-05-27T10:${String(i).padStart(2, '0')}:00.000Z` })
    }
    const p = await buildShelfPreview(home, embassy, callingClientId)
    expect(p.items).toHaveLength(SHELF_PREVIEW_CAP)
    expect(p.next_priority_ids).toHaveLength(5)
  })
})

describe('self_reflected detection', () => {
  it('marks self_reflected: true when the item came from the calling client', async () => {
    await place({ source_client_id: callingClientId })
    const p = await buildShelfPreview(home, embassy, callingClientId)
    expect(p.items[0]?.self_reflected).toBe(true)
  })

  it('marks self_reflected: false when client_ids differ', async () => {
    await place({ source_client_id: 'different-client' })
    const p = await buildShelfPreview(home, embassy, callingClientId)
    expect(p.items[0]?.self_reflected).toBe(false)
  })

  it('marks self_reflected: false when the item has no client_id', async () => {
    await place({ source_client_id: null })
    const p = await buildShelfPreview(home, embassy, callingClientId)
    expect(p.items[0]?.self_reflected).toBe(false)
  })

  it('prefixes the embassy_autonomous variant when self_reflected', async () => {
    await place({ source_type: 'embassy_autonomous', body: 'the original body' })
    const p = await buildShelfPreview(home, embassy, callingClientId)
    expect(p.items[0]?.excerpt).toContain('the fleet flagged it for your return')
    expect(p.items[0]?.excerpt).toContain('the original body')
  })

  it('prefixes the human_curated variant when self_reflected', async () => {
    await place({ source_type: 'human_curated', body: 'the original body' })
    const p = await buildShelfPreview(home, embassy, callingClientId)
    expect(p.items[0]?.excerpt).toContain('an operator curated it for your return')
  })
})

describe('excerpt truncation', () => {
  it('returns the full body when it fits in EXCERPT_CHARS', async () => {
    const short = 'this fits comfortably under the cap'
    await place({ body: short, source_client_id: 'different' })
    const p = await buildShelfPreview(home, embassy, callingClientId)
    expect(p.items[0]?.excerpt).toBe(short)
  })

  it('truncates a long body on a word boundary with "..." appended', async () => {
    const longBody = 'a '.repeat(500) + 'distinctword'
    await place({ body: longBody, source_client_id: 'different' })
    const p = await buildShelfPreview(home, embassy, callingClientId)
    expect(p.items[0]?.excerpt.length).toBeLessThanOrEqual(EXCERPT_CHARS + 3)
    expect(p.items[0]?.excerpt.endsWith('...')).toBe(true)
    expect(p.items[0]?.excerpt).not.toContain('distinctword')
  })
})
