import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearMigrationSentinel,
  isMigrationComplete,
  migrateOwnerlessNotesToEmbassy,
} from '../../../../../src/runtime/mcp/connector/embassy/note-migration.js'
import { BrainStore } from '../../../../../src/runtime/brain/store.js'
import { initHome, initAgentDirs } from '../../../../../src/runtime/storage/init.js'

let home: string
const embassy = 'grok-embassy'
const otherAgent = 'simon'

async function stubAgent(home: string, name: string): Promise<void> {
  const dir = join(home, name + '.identity.md')
  await writeFile(
    dir,
    [
      '---',
      'schema_version: 5',
      `agent_name: ${name}`,
      'agent_role: "test"',
      'model:',
      '  tier: frontier',
      '  provider: anthropic',
      '  model_id: claude-opus-4-7',
      'tools: []',
      `project_dir: ${join(home, 'agents', name, 'project')}`,
      `brain_dir: ${join(home, 'agents', name, 'brain')}`,
      'created: 2026-05-26',
      '---',
      '',
      '# Identity',
    ].join('\n'),
  )
  await initAgentDirs(home, name, dir)
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-note-migration-'))
  await initHome(home)
  await mkdir(join(home, 'agents'), { recursive: true })
  await stubAgent(home, embassy)
  await stubAgent(home, otherAgent)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('isMigrationComplete', () => {
  it('returns false on a fresh home', async () => {
    expect(await isMigrationComplete(home)).toBe(false)
  })
})

describe('migrateOwnerlessNotesToEmbassy', () => {
  it('migrates research threads from shared brain to embassy', async () => {
    const shared = BrainStore.forShared(home)
    await shared.write({
      slug: 'research-x',
      title: 'Research: x',
      body: 'thread body',
      type: 'research-thread',
      tags: ['research-thread'],
      extras: { contribution_count: 3 },
    })
    const summary = await migrateOwnerlessNotesToEmbassy(home, embassy)
    expect(summary.migrated_threads).toBe(1)
    expect(summary.skipped_already_complete).toBe(false)
    // Embassy brain now has it
    const embassyStore = BrainStore.forAgent(home, embassy)
    const moved = await embassyStore.read('research-x')
    expect(moved.frontmatter.tags).toContain('relationship-history')
    expect(moved.frontmatter.tags).toContain('research-thread')
    expect(moved.extras['contribution_count']).toBe(3)
    expect(moved.extras['migrated_from']).toBe('shared/brain')
    // Original is gone
    expect(await shared.tryRead('research-x')).toBeNull()
  })

  it('migrates standing briefs', async () => {
    const shared = BrainStore.forShared(home)
    await shared.write({
      slug: 'research-x-brief',
      title: 'Brief: x',
      body: 'brief body',
      type: 'standing-brief',
      tags: ['standing-brief', 'research-thread'],
    })
    const summary = await migrateOwnerlessNotesToEmbassy(home, embassy)
    expect(summary.migrated_briefs).toBe(1)
    const embassyStore = BrainStore.forAgent(home, embassy)
    const moved = await embassyStore.read('research-x-brief')
    expect(moved.frontmatter.tags).toContain('standing-brief')
    expect(moved.frontmatter.tags).toContain('relationship-history')
  })

  it('migrates per-agent grok-contributions, recording target_agent', async () => {
    const otherStore = BrainStore.forAgent(home, otherAgent)
    await otherStore.write({
      slug: 'grok-contribution-20260526-abc',
      title: 'Grok contribution',
      body: 'contribution body',
      type: 'contribution',
      tags: ['grok-contribution'],
    })
    const summary = await migrateOwnerlessNotesToEmbassy(home, embassy)
    expect(summary.migrated_agent_contributions).toBe(1)
    const embassyStore = BrainStore.forAgent(home, embassy)
    const moved = await embassyStore.read('grok-contribution-20260526-abc')
    expect(moved.extras['target_agent']).toBe(otherAgent)
    expect(moved.frontmatter.tags).toContain('relationship-history')
    expect(await otherStore.tryRead('grok-contribution-20260526-abc')).toBeNull()
  })

  it('skips contributions in the embassy itself (idempotent re-runs)', async () => {
    const embassyStore = BrainStore.forAgent(home, embassy)
    await embassyStore.write({
      slug: 'grok-contribution-existing',
      title: 'Already in embassy',
      body: 'body',
      type: 'contribution',
      tags: ['grok-contribution', 'relationship-history'],
    })
    const summary = await migrateOwnerlessNotesToEmbassy(home, embassy)
    expect(summary.migrated_agent_contributions).toBe(0)
  })

  it('writes the sentinel on completion; second run no-ops', async () => {
    await migrateOwnerlessNotesToEmbassy(home, embassy)
    expect(await isMigrationComplete(home)).toBe(true)
    const second = await migrateOwnerlessNotesToEmbassy(home, embassy)
    expect(second.skipped_already_complete).toBe(true)
  })

  it('clearMigrationSentinel lets the migration re-run', async () => {
    await migrateOwnerlessNotesToEmbassy(home, embassy)
    await clearMigrationSentinel(home)
    expect(await isMigrationComplete(home)).toBe(false)
  })
})
