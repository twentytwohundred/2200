/**
 * Tests for the per-Agent and per-thread contribution write helpers.
 *
 * Each contribution is a normal Brain note (per Doug's 2026-05-23
 * decision), so the assertions check that the note round-trips
 * through `BrainStore` and shows up in tag/list queries the way
 * Agents and operators will use them. Slug validation tests cover
 * the documented divergence from the pub-name rule (threads must
 * start with a letter).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrainStore } from '../../../../src/runtime/brain/store.js'
import {
  sluggifyThreadName,
  validateThreadSlug,
  writeAgentContribution,
  writeThreadContribution,
} from '../../../../src/runtime/mcp/connector/contributions.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-contributions-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('sluggifyThreadName', () => {
  it('normalizes free-form names to canonical slugs', () => {
    expect(sluggifyThreadName('Tesla Grok MCP Spike')).toBe('tesla-grok-mcp-spike')
    expect(sluggifyThreadName('  research_topic 1 ')).toBe('research-topic-1')
    expect(sluggifyThreadName('Foo Bar!@#Baz')).toBe('foo-barbaz')
  })

  it('strips a leading digit run so threads start with a letter', () => {
    expect(sluggifyThreadName('2200-architecture')).toBe('architecture')
    expect(sluggifyThreadName('123foo')).toBe('foo')
  })

  it('returns an empty string when no usable letters remain', () => {
    expect(sluggifyThreadName('!!!')).toBe('')
    expect(sluggifyThreadName('123')).toBe('')
  })
})

describe('validateThreadSlug', () => {
  it('accepts well-formed names', () => {
    const result = validateThreadSlug('Tesla Grok MCP Spike')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.slug).toBe('tesla-grok-mcp-spike')
  })

  it('rejects names with no usable letters and surfaces the input verbatim', () => {
    const result = validateThreadSlug('!!!')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('!!!')
  })
})

describe('writeAgentContribution', () => {
  it("writes a contribution as a normal Brain note in the Agent's brain", async () => {
    const result = await writeAgentContribution({
      home,
      agentName: 'hobby',
      payload: {
        research_findings: 'Tesla in-car Grok supports custom MCP connectors via the Voice API.',
        reasoning: 'Cross-referenced grok.com docs + Voice API release notes.',
        sources: [{ url: 'https://docs.x.ai/grok/connectors', title: 'xAI connectors docs' }],
        open_questions: ['Does the Tesla surface honor allowed_tools?'],
      },
    })
    expect(result.slug).toMatch(/^grok-contribution-\d{17}-[0-9a-f]{6}$/)
    expect(result.path).toContain('/agents/hobby/brain/')

    const store = BrainStore.forAgent(home, 'hobby')
    const note = await store.read(result.slug)
    expect(note.frontmatter.type).toBe('contribution')
    expect(note.frontmatter.tags).toContain('grok-contribution')
    expect(note.extras['contributor']).toBe('mcp-connector')
    expect(note.body).toContain('Research findings')
    expect(note.body).toContain('Tesla in-car Grok supports custom MCP connectors')
    expect(note.body).toContain('https://docs.x.ai/grok/connectors')
  })

  it("appears in the Agent's brain list filtered by the grok-contribution tag", async () => {
    await writeAgentContribution({
      home,
      agentName: 'hobby',
      payload: {
        research_findings: 'A',
        reasoning: 'B',
        sources: [],
        open_questions: [],
      },
    })
    await writeAgentContribution({
      home,
      agentName: 'hobby',
      payload: {
        research_findings: 'C',
        reasoning: 'D',
        sources: [],
        open_questions: [],
      },
    })
    const list = await BrainStore.forAgent(home, 'hobby').list({ tag: 'grok-contribution' })
    expect(list).toHaveLength(2)
  })
})

describe('writeThreadContribution', () => {
  it('creates the thread anchor on first write and tags it research-thread', async () => {
    const result = await writeThreadContribution({
      home,
      threadSlug: 'tesla-grok-mcp-spike',
      displayName: 'Tesla Grok MCP spike',
      primaryAgent: 'hobby',
      payload: {
        research_findings: 'A',
        reasoning: 'B',
        sources: [],
        open_questions: [],
      },
    })
    expect(result.created).toBe(true)
    expect(result.contributionCount).toBe(1)
    expect(result.slug).toBe('research-tesla-grok-mcp-spike')

    const store = BrainStore.forShared(home)
    const note = await store.read('research-tesla-grok-mcp-spike')
    expect(note.frontmatter.type).toBe('research-thread')
    expect(note.frontmatter.tags).toContain('research-thread')
    expect(note.extras['display_name']).toBe('Tesla Grok MCP spike')
    expect(note.extras['primary_agent']).toBe('hobby')
    expect(note.extras['contribution_count']).toBe(1)
  })

  it('appends subsequent contributions as ## <timestamp> sections', async () => {
    await writeThreadContribution({
      home,
      threadSlug: 'tesla-grok-mcp-spike',
      payload: { research_findings: 'first', reasoning: 'r1', sources: [], open_questions: [] },
    })
    await writeThreadContribution({
      home,
      threadSlug: 'tesla-grok-mcp-spike',
      payload: { research_findings: 'second', reasoning: 'r2', sources: [], open_questions: [] },
    })
    const note = await BrainStore.forShared(home).read('research-tesla-grok-mcp-spike')
    expect(note.body.match(/^##\s+\d{4}-\d{2}-\d{2}T/gm)?.length).toBe(2)
    expect(note.body).toContain('first')
    expect(note.body).toContain('second')
    expect(note.extras['contribution_count']).toBe(2)
  })

  it('preserves primary_agent across subsequent writes (set once)', async () => {
    await writeThreadContribution({
      home,
      threadSlug: 'tesla-grok-mcp-spike',
      primaryAgent: 'hobby',
      payload: { research_findings: 'first', reasoning: 'r1', sources: [], open_questions: [] },
    })
    await writeThreadContribution({
      home,
      threadSlug: 'tesla-grok-mcp-spike',
      primaryAgent: 'someone-else', // ignored on subsequent writes
      payload: { research_findings: 'second', reasoning: 'r2', sources: [], open_questions: [] },
    })
    const note = await BrainStore.forShared(home).read('research-tesla-grok-mcp-spike')
    expect(note.extras['primary_agent']).toBe('hobby')
  })
})
