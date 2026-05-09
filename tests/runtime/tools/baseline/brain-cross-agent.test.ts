import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brainListAgent, brainSearchAgent } from '../../../../src/runtime/tools/baseline/brain.js'
import { BrainStore } from '../../../../src/runtime/brain/store.js'
import { BrainIndex } from '../../../../src/runtime/brain/index-db.js'
import { closeAllBrains } from '../../../../src/runtime/brain/registry.js'
import { grantBrainRead } from '../../../../src/runtime/brain/permissions.js'
import type { ToolContext } from '../../../../src/runtime/mcp/tool.js'

let home: string

async function seedHobbyBrain(): Promise<void> {
  const store = new BrainStore(home, 'hobby')
  await store.write({
    slug: 'gemini-vs-claude',
    title: 'Comparing Gemini and Claude',
    type: 'project',
    tags: ['models', 'gemini', 'claude'],
    body: 'Gemini wins on speed. Claude wins on tool reliability.',
  })
  await store.write({
    slug: 'private-thought',
    title: 'Just a private thought',
    type: 'feedback',
    tags: ['private'],
    body: 'Doug is fast.',
  })
  // Build index from disk so search has something to match.
  const index = BrainIndex.open(home, 'hobby')
  const all = await store.list({ limit: 100 })
  index.rebuildFrom(all)
  index.close()
}

function ctxFor(caller: string): ToolContext {
  return {
    callingAgent: caller,
    home,
    brainDir: 'unused',
    projectDir: 'unused',
    taskId: null,
    callId: 'test-call',
  }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-brainx-'))
  await seedHobbyBrain()
})

afterEach(async () => {
  closeAllBrains()
  await rm(home, { recursive: true, force: true })
})

describe('brain_search_agent', () => {
  it('throws BrainPermissionDeniedError when caller is not in the readers list', async () => {
    await expect(
      brainSearchAgent.execute({ agent: 'hobby', query: 'gemini', limit: 20 }, ctxFor('simon')),
    ).rejects.toThrow(/not authorized to read/)
  })

  it('returns hits when the caller is granted read', async () => {
    await grantBrainRead(home, 'hobby', 'simon')
    const result = (await brainSearchAgent.execute(
      { agent: 'hobby', query: 'gemini', limit: 20 },
      ctxFor('simon'),
    )) as { agent: string; query: string; hits: { slug: string }[] }
    expect(result.agent).toBe('hobby')
    expect(result.hits.length).toBeGreaterThanOrEqual(1)
    expect(result.hits.map((h) => h.slug)).toContain('gemini-vs-claude')
  })

  it('an Agent can always read its own brain (self-search)', async () => {
    const result = (await brainSearchAgent.execute(
      { agent: 'hobby', query: 'gemini', limit: 20 },
      ctxFor('hobby'),
    )) as { hits: { slug: string }[] }
    expect(result.hits.map((h) => h.slug)).toContain('gemini-vs-claude')
  })

  it('returns an empty hits array when the target Agent has no brain index yet', async () => {
    await grantBrainRead(home, 'newcomer', 'hobby')
    const result = (await brainSearchAgent.execute(
      { agent: 'newcomer', query: 'anything', limit: 20 },
      ctxFor('hobby'),
    )) as { hits: unknown[] }
    expect(result.hits).toEqual([])
  })

  it('honors type + tag filters', async () => {
    await grantBrainRead(home, 'hobby', 'simon')
    const result = (await brainSearchAgent.execute(
      {
        agent: 'hobby',
        query: 'gemini',
        limit: 20,
        types: ['project'],
        any_tag: ['models'],
      },
      ctxFor('simon'),
    )) as { hits: { slug: string }[] }
    expect(result.hits.map((h) => h.slug)).toContain('gemini-vs-claude')
  })
})

describe('brain_list_agent', () => {
  it('throws BrainPermissionDeniedError when caller is not in the readers list', async () => {
    await expect(
      brainListAgent.execute({ agent: 'hobby', limit: 50 }, ctxFor('simon')),
    ).rejects.toThrow(/not authorized to read/)
  })

  it('lists notes when granted', async () => {
    await grantBrainRead(home, 'hobby', 'simon')
    const result = (await brainListAgent.execute(
      { agent: 'hobby', limit: 50 },
      ctxFor('simon'),
    )) as { agent: string; notes: { slug: string }[] }
    expect(result.notes.map((n) => n.slug).sort()).toEqual(
      ['gemini-vs-claude', 'private-thought'].sort(),
    )
  })

  it('filters by type', async () => {
    await grantBrainRead(home, 'hobby', 'simon')
    const result = (await brainListAgent.execute(
      { agent: 'hobby', limit: 50, type: 'project' },
      ctxFor('simon'),
    )) as { notes: { slug: string }[] }
    expect(result.notes.map((n) => n.slug)).toEqual(['gemini-vs-claude'])
  })
})
