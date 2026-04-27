/**
 * Tests for the per-Agent per-pub watermark file.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getWatermark, loadWatermarks, setWatermark } from '../../../src/runtime/pub/watermark.js'
import { agentPaths } from '../../../src/runtime/storage/layout.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-watermark-'))
  await mkdir(agentPaths(home, 'hobby').root, { recursive: true })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('loadWatermarks', () => {
  it('returns empty shape on first read (no file yet)', async () => {
    const file = await loadWatermarks(home, 'hobby')
    expect(file).toEqual({ schema_version: 1, pubs: {} })
  })

  it('throws on malformed JSON', async () => {
    const { writeFile } = await import('node:fs/promises')
    await mkdir(join(agentPaths(home, 'hobby').root, 'state'), { recursive: true })
    await writeFile(
      join(agentPaths(home, 'hobby').root, 'state', 'pub-watermarks.json'),
      '{not json',
      'utf8',
    )
    await expect(loadWatermarks(home, 'hobby')).rejects.toThrow(/not valid JSON/)
  })

  it('throws on wrong schema_version', async () => {
    const { writeFile } = await import('node:fs/promises')
    await mkdir(join(agentPaths(home, 'hobby').root, 'state'), { recursive: true })
    await writeFile(
      join(agentPaths(home, 'hobby').root, 'state', 'pub-watermarks.json'),
      JSON.stringify({ schema_version: 2, pubs: {} }),
      'utf8',
    )
    await expect(loadWatermarks(home, 'hobby')).rejects.toThrow(/schema_version/)
  })
})

describe('setWatermark + getWatermark', () => {
  it('round-trips a watermark', async () => {
    await setWatermark(home, 'hobby', 'ops', {
      pub_id: '01919c4f-aaaa-7000-8000-000000000001',
      last_read_message_id: '01919c4f-bbbb-7000-8000-000000000002',
      last_read_ts: '2026-04-27T15:00:00.000Z',
    })
    const got = await getWatermark(home, 'hobby', 'ops')
    expect(got?.last_read_message_id).toBe('01919c4f-bbbb-7000-8000-000000000002')
    expect(got?.pub_id).toBe('01919c4f-aaaa-7000-8000-000000000001')
  })

  it('getWatermark returns null when the pub has no watermark yet', async () => {
    const got = await getWatermark(home, 'hobby', 'ops')
    expect(got).toBeNull()
  })

  it('preserves other pubs when updating one', async () => {
    await setWatermark(home, 'hobby', 'ops', {
      pub_id: 'p1',
      last_read_message_id: 'm1',
      last_read_ts: 't1',
    })
    await setWatermark(home, 'hobby', 'family', {
      pub_id: 'p2',
      last_read_message_id: 'm2',
      last_read_ts: 't2',
    })
    const file = await loadWatermarks(home, 'hobby')
    expect(file.pubs['ops']?.last_read_message_id).toBe('m1')
    expect(file.pubs['family']?.last_read_message_id).toBe('m2')
  })

  it('idempotent re-set with same value', async () => {
    const wm = { pub_id: 'p1', last_read_message_id: 'm1', last_read_ts: 't1' }
    await setWatermark(home, 'hobby', 'ops', wm)
    await setWatermark(home, 'hobby', 'ops', wm)
    const got = await getWatermark(home, 'hobby', 'ops')
    expect(got).toEqual(wm)
  })
})
