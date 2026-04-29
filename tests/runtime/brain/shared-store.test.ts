import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrainStore } from '../../../src/runtime/brain/store.js'
import { BrainIndex } from '../../../src/runtime/brain/index-db.js'
import { homePaths } from '../../../src/runtime/storage/layout.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-shared-brain-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('BrainStore.forShared', () => {
  it('writes shared notes under <home>/shared/brain', async () => {
    const store = BrainStore.forShared(home)
    expect(store.dir()).toBe(homePaths(home).sharedBrain)

    const result = await store.write({
      title: 'Hello shared',
      body: 'Notes for everyone.',
    })
    expect(result.created).toBe(true)
    expect(result.path).toContain('shared/brain/')
    expect(result.slug).toBe('hello-shared')

    const note = await store.read(result.slug)
    expect(note.frontmatter.title).toBe('Hello shared')
    expect(note.body.trim()).toBe('Notes for everyone.')
  })

  it('does not collide with per-Agent brains', async () => {
    const sharedStore = BrainStore.forShared(home)
    const agentStore = BrainStore.forAgent(home, 'hobby')

    await sharedStore.write({ title: 'Shared note', body: 'shared body' })
    await agentStore.write({ title: 'Shared note', body: 'agent body' })

    expect(sharedStore.dir()).not.toBe(agentStore.dir())
    const sharedRead = await sharedStore.read('shared-note')
    const agentRead = await agentStore.read('shared-note')
    expect(sharedRead.body.trim()).toBe('shared body')
    expect(agentRead.body.trim()).toBe('agent body')
  })

  it('list / search go through the shared index', async () => {
    const store = BrainStore.forShared(home)
    await store.write({ title: 'Operations runbook', body: 'How we deploy 2200.' })
    await store.write({ title: 'Voice + framing', body: 'Prose conventions.' })
    await store.write({ title: 'Random note', body: 'Just some prose.' })

    const all = await store.list({ limit: 100 })
    expect(all.map((n) => n.frontmatter.title).sort()).toEqual([
      'Operations runbook',
      'Random note',
      'Voice + framing',
    ])

    const index = BrainIndex.openShared(home)
    try {
      index.rebuildFrom(all)
      const hits = index.search('operations')
      expect(hits.some((h) => h.slug === 'operations-runbook')).toBe(true)
    } finally {
      index.close()
    }
  })
})
