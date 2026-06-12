/**
 * Tests for the agent archive helpers (Epic 17).
 *
 * Cover:
 *  - pickArchiveName: returns base name when free
 *  - pickArchiveName: suffixes -2, -3 on collision
 *  - applyArchiveEdit: rewrites agent_name + inserts archived block
 *  - applyArchiveEdit: clears archived block when null
 *  - applyArchiveEdit: replaces existing archived block
 *  - applyArchiveEdit: preserves the body and other frontmatter
 *  - renameAgentTrees: moves agents/ tree
 *  - renameAgentTrees: moves every per-agent state subtree that exists
 *  - renameAgentTrees: silently skips subtrees that don't exist
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyArchiveEdit,
  pickArchiveName,
  renameAgentTrees,
  todayUtc,
} from '../../../src/runtime/agent/archive.js'

describe('pickArchiveName', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), '2200-archive-pick-'))
    await mkdir(join(home, 'agents'), { recursive: true })
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it('returns the base name when free', () => {
    expect(pickArchiveName(home, 'jodin', '2026-05-14')).toBe('jodin-archived-2026-05-14')
  })

  it('suffixes -2 on first collision', async () => {
    await mkdir(join(home, 'agents', 'jodin-archived-2026-05-14'))
    expect(pickArchiveName(home, 'jodin', '2026-05-14')).toBe('jodin-archived-2026-05-14-2')
  })

  it('keeps walking suffixes when -2 is also taken', async () => {
    await mkdir(join(home, 'agents', 'jodin-archived-2026-05-14'))
    await mkdir(join(home, 'agents', 'jodin-archived-2026-05-14-2'))
    expect(pickArchiveName(home, 'jodin', '2026-05-14')).toBe('jodin-archived-2026-05-14-3')
  })
})

describe('applyArchiveEdit', () => {
  const sampleIdentity = `---
schema_version: 5
agent_name: jodin
agent_role: research assistant
avatar: '🍃'
model:
  provider: anthropic
  model_id: claude-opus-4-7
project_dir: project
brain_dir: brain
created: 2026-04-30
cost_caps:
  daily_usd: 50
  warn_at_pct: 80
  reset_at: 00:00 UTC
  on_breach: block_new_tasks

---
Body text that should not be touched.
`

  it('rewrites agent_name and inserts an archived block', () => {
    const out = applyArchiveEdit(sampleIdentity, {
      agent_name: 'jodin-archived-2026-05-14',
      archived: { at: '2026-05-14T12:00:00.000Z', reason: 'no longer needed' },
    })
    expect(out).toContain('agent_name: jodin-archived-2026-05-14')
    expect(out).toContain('archived:')
    expect(out).toContain("at: '2026-05-14T12:00:00.000Z'")
    expect(out).toContain("reason: 'no longer needed'")
    expect(out).not.toContain('agent_name: jodin\n')
    expect(out).toContain('Body text that should not be touched.')
  })

  it('omits the reason line when none provided', () => {
    const out = applyArchiveEdit(sampleIdentity, {
      agent_name: 'jodin-archived-2026-05-14',
      archived: { at: '2026-05-14T12:00:00.000Z' },
    })
    expect(out).toContain('archived:')
    expect(out).not.toMatch(/reason:/)
  })

  it('clears the archived block when archived: null', () => {
    const archived = applyArchiveEdit(sampleIdentity, {
      agent_name: 'jodin-archived-2026-05-14',
      archived: { at: '2026-05-14T12:00:00.000Z', reason: 'pause' },
    })
    const restored = applyArchiveEdit(archived, { agent_name: 'jodin', archived: null })
    expect(restored).toContain('agent_name: jodin')
    expect(restored).not.toContain('archived:')
    expect(restored).not.toContain("at: '2026-05-14T12:00:00.000Z'")
    expect(restored).toContain('Body text that should not be touched.')
  })

  it('replaces an existing archived block when archiving twice in a row', () => {
    const first = applyArchiveEdit(sampleIdentity, {
      agent_name: 'jodin-archived-2026-05-14',
      archived: { at: '2026-05-14T12:00:00.000Z', reason: 'first' },
    })
    const second = applyArchiveEdit(first, {
      agent_name: 'jodin-archived-2026-06-01',
      archived: { at: '2026-06-01T12:00:00.000Z', reason: 'second' },
    })
    expect(second).toContain('agent_name: jodin-archived-2026-06-01')
    expect(second).toContain("at: '2026-06-01T12:00:00.000Z'")
    expect(second).toContain("reason: 'second'")
    expect(second).not.toContain("at: '2026-05-14T12:00:00.000Z'")
    expect(second).not.toContain("reason: 'first'")
  })

  it('escapes single quotes in reason', () => {
    const out = applyArchiveEdit(sampleIdentity, {
      agent_name: 'jodin-archived-2026-05-14',
      archived: { at: '2026-05-14T12:00:00.000Z', reason: "operator's call" },
    })
    expect(out).toContain("reason: 'operator''s call'")
  })
})

describe('renameAgentTrees', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), '2200-archive-rename-'))
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  async function writeFixture(name: string): Promise<void> {
    // Create one file under each per-agent subtree so we can assert
    // they all migrate together.
    const subtrees = [
      ['agents', name, 'identity.md'],
      ['state', 'agents', name, 'schedules', 's1.json'],
      ['state', 'telemetry', name, '2026-05-14.jsonl'],
      ['state', 'credentials', name, 'salt'],
      ['state', 'budget', name, '2026-05-14.json'],
      ['state', 'brain', name, 'brain.db'],
      ['state', 'identities', name, 'keys', 'salt'],
    ]
    for (const parts of subtrees) {
      const path = join(home, ...parts)
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, parts[parts.length - 1] ?? '')
    }
  }

  it('moves every per-agent subtree that exists', async () => {
    await writeFixture('jodin')
    await renameAgentTrees(home, 'jodin', 'jodin-archived-2026-05-14')
    // Old paths gone:
    await expect(stat(join(home, 'agents', 'jodin'))).rejects.toThrow()
    await expect(stat(join(home, 'state', 'agents', 'jodin'))).rejects.toThrow()
    await expect(stat(join(home, 'state', 'budget', 'jodin'))).rejects.toThrow()
    // New paths populated:
    expect(
      (await readFile(join(home, 'agents', 'jodin-archived-2026-05-14', 'identity.md'), 'utf8'))
        .length,
    ).toBeGreaterThan(0)
    expect(
      (
        await readFile(
          join(home, 'state', 'budget', 'jodin-archived-2026-05-14', '2026-05-14.json'),
          'utf8',
        )
      ).length,
    ).toBeGreaterThan(0)
  })

  it('silently skips subtrees that do not exist', async () => {
    // Only the agents/ root exists; everything else missing.
    await mkdir(join(home, 'agents', 'sparse'), { recursive: true })
    await writeFile(join(home, 'agents', 'sparse', 'identity.md'), 'x')
    await expect(
      renameAgentTrees(home, 'sparse', 'sparse-archived-2026-05-14'),
    ).resolves.not.toThrow()
    expect(
      await readFile(join(home, 'agents', 'sparse-archived-2026-05-14', 'identity.md'), 'utf8'),
    ).toBe('x')
  })

  it('roundtrips: rename then rename back is a no-op on contents', async () => {
    await writeFixture('hobby')
    await renameAgentTrees(home, 'hobby', 'hobby-archived-2026-05-14')
    await renameAgentTrees(home, 'hobby-archived-2026-05-14', 'hobby')
    expect(
      (await readFile(join(home, 'agents', 'hobby', 'identity.md'), 'utf8')).length,
    ).toBeGreaterThan(0)
  })
})

describe('todayUtc', () => {
  it('returns YYYY-MM-DD', () => {
    expect(todayUtc(new Date('2026-05-14T03:00:00.000Z'))).toBe('2026-05-14')
  })
  it('uses UTC, not local', () => {
    // 2026-05-14T01:00:00Z is still 2026-05-14 in UTC even if local
    // is one day earlier in the Pacific.
    expect(todayUtc(new Date('2026-05-14T01:00:00.000Z'))).toBe('2026-05-14')
  })
})
