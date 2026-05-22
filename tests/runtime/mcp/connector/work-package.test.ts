/**
 * Tests for the work-package read/write helpers (PR 4).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrainStore } from '../../../../src/runtime/brain/store.js'
import {
  listWorkPackages,
  newWorkPackageId,
  patchPackageFrontmatter,
  readWorkPackage,
  workPackageSlug,
  writeProposedPackage,
} from '../../../../src/runtime/mcp/connector/work-package.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-work-package-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('newWorkPackageId', () => {
  it('mints a `pkg_<24 hex>` id', () => {
    const id = newWorkPackageId()
    expect(id).toMatch(/^pkg_[a-f0-9]{24}$/)
  })

  it('does not collide across 200 calls', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) seen.add(newWorkPackageId())
    expect(seen.size).toBe(200)
  })
})

describe('writeProposedPackage', () => {
  it('persists a package as a normal Brain note tagged work-package', async () => {
    const id = newWorkPackageId()
    const result = await writeProposedPackage({
      home,
      packageId: id,
      primaryAgent: 'hobby',
      proposal: {
        title: 'Stand up the Grok connector for Doug',
        summary: 'Get a tunnel up and test end-to-end.',
        proposed_steps: [
          'Mint a connector token',
          'Start an ngrok tunnel pointed at port 2201',
          'Register the connector at grok.com/connectors',
        ],
        target: { kind: 'thread', thread_slug: 'tesla-grok-mcp-spike' },
        success_criteria: ['ngrok URL is reachable', 'Grok call lands in Inbox'],
        risk_notes: ['public tunnel exposes the connector listener'],
        estimated_cost_usd: 0,
        estimated_duration_minutes: 30,
      },
    })
    expect(result.slug).toBe(workPackageSlug(id))

    const note = await BrainStore.forShared(home).read(workPackageSlug(id))
    expect(note.frontmatter.type).toBe('work-package')
    expect(note.frontmatter.tags).toContain('work-package')
    expect(note.frontmatter.tags).toContain('target:thread')
    expect(note.extras['package_id']).toBe(id)
    expect(note.extras['package_status']).toBe('proposed')
    expect(note.extras['primary_agent']).toBe('hobby')
    expect(note.extras['target_kind']).toBe('thread')
    expect(note.extras['target_name']).toBe('tesla-grok-mcp-spike')
    expect(note.frontmatter.title).toContain('Stand up the Grok connector for Doug')
    expect(note.body).toContain('Get a tunnel up')
    expect(note.body).toContain('## Plan')
    expect(note.body).toContain('_(pending; the coordination task has not yet completed)_')
  })
})

describe('patchPackageFrontmatter', () => {
  it('updates the status without rewriting the body', async () => {
    const id = newWorkPackageId()
    await writeProposedPackage({
      home,
      packageId: id,
      primaryAgent: 'hobby',
      proposal: {
        title: 't',
        summary: 's',
        proposed_steps: ['a'],
        target: { kind: 'agent', agent_name: 'hobby' },
      },
    })
    const before = await BrainStore.forShared(home).read(workPackageSlug(id))
    await patchPackageFrontmatter({
      home,
      packageId: id,
      updates: { package_status: 'reviewable', coordination_task_id: 'task_xyz' },
    })
    const after = await BrainStore.forShared(home).read(workPackageSlug(id))
    expect(after.body).toBe(before.body)
    expect(after.extras['package_status']).toBe('reviewable')
    expect(after.extras['coordination_task_id']).toBe('task_xyz')
  })
})

describe('readWorkPackage', () => {
  it('returns null for unknown packages', async () => {
    expect(await readWorkPackage(home, 'pkg_nonexistent')).toBeNull()
  })

  it('returns the parsed record for a written package', async () => {
    const id = newWorkPackageId()
    await writeProposedPackage({
      home,
      packageId: id,
      primaryAgent: 'hobby',
      proposal: {
        title: 'Test package',
        summary: 's',
        proposed_steps: ['a', 'b'],
        target: { kind: 'agent', agent_name: 'hobby' },
      },
    })
    const record = await readWorkPackage(home, id)
    expect(record).not.toBeNull()
    expect(record?.packageId).toBe(id)
    expect(record?.status).toBe('proposed')
    expect(record?.primaryAgent).toBe('hobby')
    expect(record?.proposal.target).toEqual({ kind: 'agent', agent_name: 'hobby' })
  })
})

describe('listWorkPackages', () => {
  it('returns an empty array on a fresh home', async () => {
    expect(await listWorkPackages({ home })).toEqual([])
  })

  it('lists all packages sorted by createdAt descending', async () => {
    const a = newWorkPackageId()
    const b = newWorkPackageId()
    await writeProposedPackage({
      home,
      packageId: a,
      primaryAgent: 'hobby',
      proposal: {
        title: 'older',
        summary: 's',
        proposed_steps: ['x'],
        target: { kind: 'agent', agent_name: 'hobby' },
      },
      now: () => new Date('2026-05-23T10:00:00Z'),
    })
    await writeProposedPackage({
      home,
      packageId: b,
      primaryAgent: 'hobby',
      proposal: {
        title: 'newer',
        summary: 's',
        proposed_steps: ['x'],
        target: { kind: 'agent', agent_name: 'hobby' },
      },
      now: () => new Date('2026-05-23T11:00:00Z'),
    })
    const items = await listWorkPackages({ home })
    expect(items).toHaveLength(2)
    expect(items[0]?.packageId).toBe(b)
    expect(items[1]?.packageId).toBe(a)
  })

  it('filters by status', async () => {
    const a = newWorkPackageId()
    const b = newWorkPackageId()
    for (const id of [a, b]) {
      await writeProposedPackage({
        home,
        packageId: id,
        primaryAgent: 'hobby',
        proposal: {
          title: 't',
          summary: 's',
          proposed_steps: ['x'],
          target: { kind: 'agent', agent_name: 'hobby' },
        },
      })
    }
    await patchPackageFrontmatter({
      home,
      packageId: b,
      updates: { package_status: 'reviewable' },
    })
    const reviewable = await listWorkPackages({ home, status: 'reviewable' })
    expect(reviewable).toHaveLength(1)
    expect(reviewable[0]?.packageId).toBe(b)
  })
})
