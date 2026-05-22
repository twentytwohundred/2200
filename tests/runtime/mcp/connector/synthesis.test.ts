/**
 * Tests for the standing-brief read/write helpers + frontmatter
 * mutation surface.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrainStore } from '../../../../src/runtime/brain/store.js'
import {
  briefSlug,
  listSynthesisStates,
  readBrief,
  updateAnchorFrontmatter,
  writeBrief,
} from '../../../../src/runtime/mcp/connector/synthesis.js'
import { writeThreadContribution } from '../../../../src/runtime/mcp/connector/contributions.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-synthesis-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('briefSlug', () => {
  it('namespaces the brief by appending -brief', () => {
    expect(briefSlug('tesla-grok-mcp-spike')).toBe('research-tesla-grok-mcp-spike-brief')
  })
})

describe('writeBrief + readBrief', () => {
  it('round-trips the brief body + provenance through the sibling note', async () => {
    const written = await writeBrief({
      home,
      threadSlug: 'tesla-grok-mcp-spike',
      briefBody: '## Current state\n\nThe MCP Voice API supports custom connectors.',
      provenance: {
        brief_schema_version: 1,
        source_thread: 'tesla-grok-mcp-spike',
        synthesized_through: '2026-05-23T10:00:00Z',
        contribution_count: 3,
        contribution_first_at: '2026-05-22T09:00:00Z',
        contribution_last_at: '2026-05-23T10:00:00Z',
        contributor_sources: ['mcp-connector'],
        synthesizing_agent: 'hobby',
        brief_written_at: '2026-05-23T10:01:00Z',
      },
    })
    expect(written.created).toBe(true)
    expect(written.slug).toBe('research-tesla-grok-mcp-spike-brief')

    const read = await readBrief(home, 'tesla-grok-mcp-spike')
    expect(read).not.toBeNull()
    expect(read?.body).toContain('Current state')
    expect(read?.provenance?.contribution_count).toBe(3)
    expect(read?.provenance?.contributor_sources).toEqual(['mcp-connector'])
    expect(read?.provenance?.synthesizing_agent).toBe('hobby')
  })

  it('returns null when no brief exists', async () => {
    expect(await readBrief(home, 'never-existed')).toBeNull()
  })

  it('rewrites the brief on subsequent calls (created=false)', async () => {
    const baseProv = {
      brief_schema_version: 1 as const,
      source_thread: 'thread-x',
      synthesized_through: '2026-05-23T10:00:00Z',
      contribution_count: 1,
      contribution_first_at: '2026-05-23T10:00:00Z',
      contribution_last_at: '2026-05-23T10:00:00Z',
      contributor_sources: ['mcp-connector'],
      synthesizing_agent: 'hobby',
      brief_written_at: '2026-05-23T10:01:00Z',
    }
    await writeBrief({ home, threadSlug: 'thread-x', briefBody: 'first', provenance: baseProv })
    const second = await writeBrief({
      home,
      threadSlug: 'thread-x',
      briefBody: 'second',
      provenance: { ...baseProv, contribution_count: 2 },
    })
    expect(second.created).toBe(false)
    const read = await readBrief(home, 'thread-x')
    // BrainStore preserves a trailing newline from the serializer.
    expect(read?.body.trimEnd()).toBe('second')
    expect(read?.provenance?.contribution_count).toBe(2)
  })
})

describe('listSynthesisStates', () => {
  it('returns empty when no research threads exist', async () => {
    expect(await listSynthesisStates(home)).toEqual([])
  })

  it('lists thread anchors (excluding their brief siblings)', async () => {
    await writeThreadContribution({
      home,
      threadSlug: 'thread-a',
      payload: { research_findings: 'x', reasoning: 'y', sources: [], open_questions: [] },
    })
    await writeBrief({
      home,
      threadSlug: 'thread-a',
      briefBody: 'brief',
      provenance: {
        brief_schema_version: 1,
        source_thread: 'thread-a',
        synthesized_through: '2026-05-23T10:00:00Z',
        contribution_count: 1,
        contribution_first_at: '2026-05-23T10:00:00Z',
        contribution_last_at: '2026-05-23T10:00:00Z',
        contributor_sources: ['mcp-connector'],
        synthesizing_agent: 'hobby',
        brief_written_at: '2026-05-23T10:01:00Z',
      },
    })
    const states = await listSynthesisStates(home)
    expect(states).toHaveLength(1)
    expect(states[0]?.threadSlug).toBe('thread-a')
  })

  it('reads synthesis frontmatter (pending, blocked, failure count)', async () => {
    await writeThreadContribution({
      home,
      threadSlug: 'thread-x',
      primaryAgent: 'hobby',
      payload: { research_findings: 'x', reasoning: 'y', sources: [], open_questions: [] },
      now: () => new Date('2026-05-23T10:00:00Z'),
    })
    await updateAnchorFrontmatter({
      home,
      threadSlug: 'thread-x',
      updates: { synthesis_blocked: true, synthesis_failure_count: 3 },
    })
    const states = await listSynthesisStates(home)
    expect(states[0]?.blocked).toBe(true)
    expect(states[0]?.failureCount).toBe(3)
    expect(states[0]?.pendingSynthesisAt).toBe('2026-05-23T10:00:00.000Z')
    expect(states[0]?.primaryAgent).toBe('hobby')
  })
})

describe('updateAnchorFrontmatter', () => {
  it('patches the anchor without touching the body', async () => {
    await writeThreadContribution({
      home,
      threadSlug: 'patch-me',
      payload: { research_findings: 'original', reasoning: 'r', sources: [], open_questions: [] },
    })
    const before = await BrainStore.forShared(home).read('research-patch-me')
    await updateAnchorFrontmatter({
      home,
      threadSlug: 'patch-me',
      updates: { synthesis_blocked: true },
    })
    const after = await BrainStore.forShared(home).read('research-patch-me')
    expect(after.body).toBe(before.body)
    expect(after.extras['synthesis_blocked']).toBe(true)
  })

  it('deletes a key when an update sets it to null', async () => {
    await writeThreadContribution({
      home,
      threadSlug: 'patch-me',
      payload: { research_findings: 'x', reasoning: 'y', sources: [], open_questions: [] },
    })
    await updateAnchorFrontmatter({
      home,
      threadSlug: 'patch-me',
      updates: { pending_synthesis_at: null },
    })
    const after = await BrainStore.forShared(home).read('research-patch-me')
    expect(after.extras['pending_synthesis_at']).toBeUndefined()
  })
})

describe('writeThreadContribution sets pending_synthesis_at + preserves synthesis state', () => {
  it('first contribute sets pending_synthesis_at to the contribution time', async () => {
    await writeThreadContribution({
      home,
      threadSlug: 'thread-y',
      payload: { research_findings: 'a', reasoning: 'b', sources: [], open_questions: [] },
      now: () => new Date('2026-05-23T10:00:00Z'),
    })
    const note = await BrainStore.forShared(home).read('research-thread-y')
    expect(note.extras['pending_synthesis_at']).toBe('2026-05-23T10:00:00.000Z')
  })

  it('preserves synthesis_blocked + failure count across subsequent contributes', async () => {
    await writeThreadContribution({
      home,
      threadSlug: 'thread-z',
      payload: { research_findings: 'a', reasoning: 'b', sources: [], open_questions: [] },
    })
    await updateAnchorFrontmatter({
      home,
      threadSlug: 'thread-z',
      updates: { synthesis_blocked: true, synthesis_failure_count: 3 },
    })
    await writeThreadContribution({
      home,
      threadSlug: 'thread-z',
      payload: { research_findings: 'c', reasoning: 'd', sources: [], open_questions: [] },
    })
    const note = await BrainStore.forShared(home).read('research-thread-z')
    expect(note.extras['synthesis_blocked']).toBe(true)
    expect(note.extras['synthesis_failure_count']).toBe(3)
  })
})
