/**
 * Tests for `applyCapabilityOverride` (Phase F §12 step 5).
 *
 * Subset-validation semantics are the load-bearing security check ...
 * the HTTP wire must not be able to inject arbitrary Capability ids
 * the session never proposed.
 */
import { describe, expect, it } from 'vitest'
import { applyCapabilityOverride } from '../../../src/runtime/onboarding/capability-override.js'
import type { CapabilityRecord } from '../../../src/runtime/onboarding/capability-loader.js'
import type { CapabilityFrontmatter } from '../../../src/runtime/onboarding/capability-schema.js'
import type { CapabilitySuggestion } from '../../../src/runtime/onboarding/capability-suggest.js'
import type { HandoffDocument } from '../../../src/runtime/migration/types.js'

function makeRecord(id: string): CapabilityRecord {
  const fm: CapabilityFrontmatter = {
    id,
    label: id,
    category: 'dev-tooling',
    description: 'test',
    publisher: 'first-party',
    source: { attribution: 'original' },
    auth: [],
    unlocks: { tools: [], skills: [], extensions: [], providers: [] },
    network_egress: { domains: 'unrestricted' },
    tags: [id],
    requires: { bins: [], os: [], capabilities: [] },
    walkthrough: {},
  }
  return {
    frontmatter: fm,
    body: '# walkthrough',
    source_path: `/test/${id}.md`,
    source_kind: 'first-party',
  }
}

function makeSuggestion(id: string, default_on = false): CapabilitySuggestion {
  return {
    capability: makeRecord(id),
    matched_tags: [id],
    overlap_count: default_on ? 2 : 1,
    confidence: default_on ? 'high' : 'speculative',
    default_on,
  }
}

function makeHandoff(capabilities: string[] = []): HandoffDocument {
  return {
    frontmatter: {
      handoff_schema_version: 1,
      agent_name: 'pilot',
      agent_type: 'agent',
      identity: {
        display_name: 'pilot',
        notification_policy: { tiers_allowed: ['passive', 'normal', 'important'] },
      },
      brain: {},
      budget: { daily_cap_usd: 25 },
      schedules: [],
      mcp_servers: [],
      capabilities,
      provenance: { source_system: '2200_onboarding' },
    },
    body: 'I am the Agent.',
    source_path: null,
  }
}

describe('applyCapabilityOverride: happy paths', () => {
  it('replaces auto-applied capabilities with the operator selection', () => {
    const handoff = makeHandoff(['github']) // auto-applied default_on
    const result = applyCapabilityOverride({
      handoff,
      suggestions: [makeSuggestion('github', true), makeSuggestion('slack', false)],
      selected_ids: ['github', 'slack'], // operator opted-in to the speculative one too
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.handoff.frontmatter.capabilities).toEqual(['github', 'slack'])
  })

  it('preserves every non-capabilities field on the handoff', () => {
    const handoff = makeHandoff(['github'])
    const result = applyCapabilityOverride({
      handoff,
      suggestions: [makeSuggestion('github', true)],
      selected_ids: [],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    // Identity, budget, mcp_servers, agent_name, etc. all unchanged.
    expect(result.handoff.frontmatter.agent_name).toBe('pilot')
    expect(result.handoff.frontmatter.budget.daily_cap_usd).toBe(25)
    expect(result.handoff.frontmatter.mcp_servers).toEqual([])
    expect(result.handoff.body).toBe('I am the Agent.')
  })

  it('empty selection is meaningful (operator deselected everything)', () => {
    const handoff = makeHandoff(['github', 'slack'])
    const result = applyCapabilityOverride({
      handoff,
      suggestions: [makeSuggestion('github', true), makeSuggestion('slack', true)],
      selected_ids: [],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.handoff.frontmatter.capabilities).toEqual([])
  })

  it('does NOT mutate the input handoff', () => {
    const handoff = makeHandoff(['github'])
    applyCapabilityOverride({
      handoff,
      suggestions: [makeSuggestion('github', true), makeSuggestion('slack', false)],
      selected_ids: ['slack'],
    })
    // Original still has the auto-applied set.
    expect(handoff.frontmatter.capabilities).toEqual(['github'])
  })
})

describe('applyCapabilityOverride: subset validation', () => {
  it('rejects any id not in the suggestion list (security boundary)', () => {
    const handoff = makeHandoff([])
    const result = applyCapabilityOverride({
      handoff,
      suggestions: [makeSuggestion('github', true), makeSuggestion('slack', false)],
      selected_ids: ['github', 'notion'], // 'notion' was never suggested
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.invalid_ids).toEqual(['notion'])
  })

  it('reports every invalid id, not just the first one', () => {
    const handoff = makeHandoff([])
    const result = applyCapabilityOverride({
      handoff,
      suggestions: [makeSuggestion('github', true)],
      selected_ids: ['notion', 'linear', 'spotify'],
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.invalid_ids).toEqual(['notion', 'linear', 'spotify'])
  })

  it('treats an empty suggestions list as "no overrides accepted"', () => {
    const handoff = makeHandoff([])
    const result = applyCapabilityOverride({
      handoff,
      suggestions: [],
      selected_ids: ['github'],
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.invalid_ids).toEqual(['github'])
  })

  it('passes when selection is empty AND suggestions is empty (no-op)', () => {
    const handoff = makeHandoff([])
    const result = applyCapabilityOverride({
      handoff,
      suggestions: [],
      selected_ids: [],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.handoff.frontmatter.capabilities).toEqual([])
  })
})
