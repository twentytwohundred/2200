/**
 * Tests for the per-pub Agent roster (Epic 3.6 PR K).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readRoster, rosterPath, upsertRosterEntry } from '../../../src/runtime/pub/roster.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-roster-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('roster', () => {
  it('returns an empty roster when the file does not exist', async () => {
    const roster = await readRoster(home, 'ops')
    expect(roster.schema_version).toBe(1)
    expect(roster.agents).toEqual([])
  })

  it('upserts a new entry, creating the file and parent dirs', async () => {
    const after = await upsertRosterEntry(home, 'ops', {
      agent_id: 'a-1',
      agent_name: 'hobby',
      display_name: 'hobby',
      role_blurb: 'primary build agent',
    })
    expect(after.agents).toHaveLength(1)
    const reread = await readRoster(home, 'ops')
    expect(reread.agents[0]?.agent_id).toBe('a-1')
    expect(reread.agents[0]?.role_blurb).toBe('primary build agent')
  })

  it('replaces an existing entry by agent_id (idempotent)', async () => {
    await upsertRosterEntry(home, 'ops', {
      agent_id: 'a-1',
      agent_name: 'hobby',
      display_name: 'hobby',
      role_blurb: 'old',
    })
    await upsertRosterEntry(home, 'ops', {
      agent_id: 'a-1',
      agent_name: 'hobby',
      display_name: 'hobby',
      role_blurb: 'new',
    })
    const roster = await readRoster(home, 'ops')
    expect(roster.agents).toHaveLength(1)
    expect(roster.agents[0]?.role_blurb).toBe('new')
  })

  it('appends multiple distinct entries', async () => {
    await upsertRosterEntry(home, 'ops', {
      agent_id: 'a-1',
      agent_name: 'hobby',
      display_name: 'hobby',
      role_blurb: 'primary build agent',
    })
    await upsertRosterEntry(home, 'ops', {
      agent_id: 'a-2',
      agent_name: 'simon',
      display_name: 'simon',
      role_blurb: 'devops',
    })
    const roster = await readRoster(home, 'ops')
    expect(roster.agents.map((a) => a.agent_id).sort()).toEqual(['a-1', 'a-2'])
  })

  it('trims and bounds role_blurb on write', async () => {
    const overlong = 'x'.repeat(1000)
    await upsertRosterEntry(home, 'ops', {
      agent_id: 'a-1',
      agent_name: 'hobby',
      display_name: 'hobby',
      role_blurb: `   ${overlong}   `,
    })
    const roster = await readRoster(home, 'ops')
    const stored = roster.agents[0]?.role_blurb ?? ''
    expect(stored.length).toBeLessThanOrEqual(240)
    expect(stored.startsWith('x')).toBe(true) // trimmed
  })

  it('throws on a malformed roster file (operator-fixable corruption)', async () => {
    const path = rosterPath(home, 'ops')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '{"schema_version": 1, "agents": "not-an-array"}', 'utf8')
    await expect(readRoster(home, 'ops')).rejects.toThrow(/malformed/)
  })
})
