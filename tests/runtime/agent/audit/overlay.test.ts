import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addOverlayEntries,
  loadAuditOverlay,
  readOverlayEntries,
  removeOverlayEntries,
} from '../../../../src/runtime/agent/audit/overlay.js'
import { agentIdentityDir } from '../../../../src/runtime/storage/layout.js'

let home: string

async function ensureIdentityDir(agent: string): Promise<void> {
  await mkdir(agentIdentityDir(home, agent), { recursive: true })
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-overlay-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('loadAuditOverlay', () => {
  it('returns an empty map when no overlay file exists', async () => {
    await ensureIdentityDir('hobby')
    expect(await loadAuditOverlay(home, 'hobby')).toEqual({})
  })

  it('collapses entries into a tool→class map', async () => {
    await ensureIdentityDir('hobby')
    await addOverlayEntries({
      home,
      agentName: 'hobby',
      skillSlug: 'openpub',
      toolClasses: {
        'openpub.check_in': 'external_send',
        'openpub.search_pubs': 'file_read',
      },
    })
    expect(await loadAuditOverlay(home, 'hobby')).toEqual({
      'openpub.check_in': 'external_send',
      'openpub.search_pubs': 'file_read',
    })
  })

  it('a later skill wins over an earlier one for the same tool name', async () => {
    await ensureIdentityDir('hobby')
    await addOverlayEntries({
      home,
      agentName: 'hobby',
      skillSlug: 'skill-a',
      toolClasses: { 'shared.tool': 'file_read' },
    })
    await addOverlayEntries({
      home,
      agentName: 'hobby',
      skillSlug: 'skill-b',
      toolClasses: { 'shared.tool': 'external_send' },
    })
    expect(await loadAuditOverlay(home, 'hobby')).toEqual({
      'shared.tool': 'external_send',
    })
  })
})

describe('addOverlayEntries / removeOverlayEntries', () => {
  it('replaces entries from the same skill on re-add', async () => {
    await ensureIdentityDir('hobby')
    await addOverlayEntries({
      home,
      agentName: 'hobby',
      skillSlug: 'openpub',
      toolClasses: { 'openpub.check_in': 'external_send' },
    })
    await addOverlayEntries({
      home,
      agentName: 'hobby',
      skillSlug: 'openpub',
      toolClasses: { 'openpub.search_pubs': 'file_read' },
    })
    const entries = await readOverlayEntries(home, 'hobby')
    expect(entries.map((e) => e.tool).sort()).toEqual(['openpub.search_pubs'])
  })

  it('preserves entries from other skills when removing one skill', async () => {
    await ensureIdentityDir('hobby')
    await addOverlayEntries({
      home,
      agentName: 'hobby',
      skillSlug: 'openpub',
      toolClasses: { 'openpub.check_in': 'external_send' },
    })
    await addOverlayEntries({
      home,
      agentName: 'hobby',
      skillSlug: 'slackish',
      toolClasses: { 'slackish.post': 'external_send' },
    })
    await removeOverlayEntries({ home, agentName: 'hobby', skillSlug: 'openpub' })
    const map = await loadAuditOverlay(home, 'hobby')
    expect(map).toEqual({ 'slackish.post': 'external_send' })
  })

  it('removing the last entry deletes the overlay file', async () => {
    await ensureIdentityDir('hobby')
    await addOverlayEntries({
      home,
      agentName: 'hobby',
      skillSlug: 'openpub',
      toolClasses: { 'openpub.check_in': 'external_send' },
    })
    const path = join(agentIdentityDir(home, 'hobby'), 'identity-audit-overlay.json')
    expect((await stat(path)).isFile()).toBe(true)
    await removeOverlayEntries({ home, agentName: 'hobby', skillSlug: 'openpub' })
    await expect(stat(path)).rejects.toThrow()
  })

  it('round-trips JSON on disk', async () => {
    await ensureIdentityDir('hobby')
    await addOverlayEntries({
      home,
      agentName: 'hobby',
      skillSlug: 'openpub',
      toolClasses: { 'openpub.check_in': 'external_send' },
    })
    const path = join(agentIdentityDir(home, 'hobby'), 'identity-audit-overlay.json')
    const raw = JSON.parse(await readFile(path, 'utf8')) as {
      schema_version: number
      entries: { tool: string; class: string; skill: string; installed_at: string }[]
    }
    expect(raw.schema_version).toBe(1)
    expect(raw.entries).toHaveLength(1)
    expect(raw.entries[0]).toMatchObject({
      tool: 'openpub.check_in',
      class: 'external_send',
      skill: 'openpub',
    })
    expect(raw.entries[0]?.installed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('readOverlayEntries (malformed file)', () => {
  it('rejects a malformed overlay file with a thrown error', async () => {
    await ensureIdentityDir('hobby')
    const path = join(agentIdentityDir(home, 'hobby'), 'identity-audit-overlay.json')
    await writeFile(path, '{ not valid json }')
    await expect(readOverlayEntries(home, 'hobby')).rejects.toThrow()
  })

  it('rejects an overlay file with an unknown class value', async () => {
    await ensureIdentityDir('hobby')
    const path = join(agentIdentityDir(home, 'hobby'), 'identity-audit-overlay.json')
    await writeFile(
      path,
      JSON.stringify({
        schema_version: 1,
        entries: [{ tool: 'x', class: 'bogus', skill: 'a', installed_at: 'now' }],
      }),
    )
    await expect(readOverlayEntries(home, 'hobby')).rejects.toThrow()
  })
})
