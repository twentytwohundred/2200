/**
 * Capability suggestion tests (Phase F §2 + §7).
 */
import { describe, expect, it } from 'vitest'
import {
  findUnmatchedTags,
  suggestCapabilities,
} from '../../../src/runtime/onboarding/capability-suggest.js'
import type { CapabilityRecord } from '../../../src/runtime/onboarding/capability-loader.js'
import type { CapabilityFrontmatter } from '../../../src/runtime/onboarding/capability-schema.js'

function makeRecord(args: {
  id: string
  tags: string[]
  category?: string
  description?: string
}): CapabilityRecord {
  const fm: CapabilityFrontmatter = {
    id: args.id,
    label: args.id,
    category: args.category ?? 'email',
    description: args.description ?? 'A test Capability description.',
    publisher: 'first-party',
    source: { attribution: 'original' },
    auth: [],
    unlocks: { tools: [], skills: [], extensions: [], providers: [] },
    network_egress: { domains: 'unrestricted' },
    tags: args.tags,
    requires: { bins: [], os: [], capabilities: [] },
    walkthrough: {},
  }
  return {
    frontmatter: fm,
    body: '# walkthrough',
    source_path: `/test/${args.id}.md`,
    source_kind: 'first-party',
  }
}

describe('suggestCapabilities: empty cases', () => {
  it('returns empty when interview_tags is empty', () => {
    const caps = [makeRecord({ id: 'gmail', tags: ['email', 'inbox'] })]
    expect(suggestCapabilities({ interview_tags: [], capabilities: caps })).toEqual([])
  })

  it('returns empty when capabilities is empty', () => {
    expect(suggestCapabilities({ interview_tags: ['email'], capabilities: [] })).toEqual([])
  })

  it('returns empty when no overlap exists', () => {
    const caps = [makeRecord({ id: 'gmail', tags: ['email', 'inbox'] })]
    expect(
      suggestCapabilities({ interview_tags: ['calendar', 'meetings'], capabilities: caps }),
    ).toEqual([])
  })
})

describe('suggestCapabilities: ranking', () => {
  it('sorts by overlap_count descending', () => {
    const caps = [
      makeRecord({ id: 'gmail', tags: ['email', 'inbox', 'gmail'] }),
      makeRecord({ id: 'slack', tags: ['chat', 'messaging'] }),
      makeRecord({ id: 'google-workspace', tags: ['email', 'calendar', 'drive', 'workspace'] }),
    ]
    const out = suggestCapabilities({
      interview_tags: ['email', 'inbox', 'gmail', 'calendar', 'workspace'],
      capabilities: caps,
    })
    // gmail: 3 (email, inbox, gmail)
    // google-workspace: 3 (email, calendar, workspace)
    // slack: 0 → filtered out
    expect(out.map((s) => s.capability.frontmatter.id)).toEqual(['gmail', 'google-workspace'])
    expect(out[0]?.overlap_count).toBe(3)
    expect(out[1]?.overlap_count).toBe(3)
  })

  it('uses id-ascending as tiebreaker when overlap_count is equal', () => {
    const caps = [
      makeRecord({ id: 'zebra', tags: ['common'] }),
      makeRecord({ id: 'apple', tags: ['common'] }),
      makeRecord({ id: 'mango', tags: ['common'] }),
    ]
    const out = suggestCapabilities({ interview_tags: ['common'], capabilities: caps })
    expect(out.map((s) => s.capability.frontmatter.id)).toEqual(['apple', 'mango', 'zebra'])
  })
})

describe('suggestCapabilities: confidence + default_on', () => {
  it('marks overlap_count >= 2 as high confidence + default_on true', () => {
    const caps = [makeRecord({ id: 'gmail', tags: ['email', 'inbox'] })]
    const out = suggestCapabilities({
      interview_tags: ['email', 'inbox'],
      capabilities: caps,
    })
    expect(out[0]?.confidence).toBe('high')
    expect(out[0]?.default_on).toBe(true)
  })

  it('marks overlap_count 1 as speculative + default_on false', () => {
    const caps = [makeRecord({ id: 'gmail', tags: ['email', 'inbox'] })]
    const out = suggestCapabilities({ interview_tags: ['email'], capabilities: caps })
    expect(out[0]?.confidence).toBe('speculative')
    expect(out[0]?.default_on).toBe(false)
  })

  it('honors custom high_confidence_threshold', () => {
    const caps = [makeRecord({ id: 'gmail', tags: ['email', 'inbox'] })]
    const out = suggestCapabilities({
      interview_tags: ['email', 'inbox'],
      capabilities: caps,
      high_confidence_threshold: 3,
    })
    expect(out[0]?.confidence).toBe('speculative')
    expect(out[0]?.default_on).toBe(false)
  })

  it('honors custom minimum_overlap (filters out under-threshold)', () => {
    const caps = [makeRecord({ id: 'gmail', tags: ['email', 'inbox'] })]
    const out = suggestCapabilities({
      interview_tags: ['email'],
      capabilities: caps,
      minimum_overlap: 2,
    })
    expect(out).toEqual([])
  })
})

describe('suggestCapabilities: case-insensitive matching', () => {
  it('matches Email against email tag', () => {
    const caps = [makeRecord({ id: 'gmail', tags: ['email', 'inbox'] })]
    const out = suggestCapabilities({ interview_tags: ['Email'], capabilities: caps })
    expect(out).toHaveLength(1)
    expect(out[0]?.matched_tags).toEqual(['email'])
  })

  it('matches EMAIL against email tag', () => {
    const caps = [makeRecord({ id: 'gmail', tags: ['email', 'inbox'] })]
    const out = suggestCapabilities({ interview_tags: ['EMAIL'], capabilities: caps })
    expect(out).toHaveLength(1)
  })
})

describe('suggestCapabilities: matched_tags reporting', () => {
  it('returns matched tags in the Capability frontmatter casing', () => {
    const caps = [makeRecord({ id: 'gmail', tags: ['Email', 'Inbox'] })]
    const out = suggestCapabilities({ interview_tags: ['email', 'inbox'], capabilities: caps })
    expect(out[0]?.matched_tags).toEqual(['Email', 'Inbox'])
  })
})

describe('findUnmatchedTags', () => {
  it('returns [] when interview_tags is empty', () => {
    const caps = [makeRecord({ id: 'gmail', tags: ['email'] })]
    expect(findUnmatchedTags({ interview_tags: [], capabilities: caps })).toEqual([])
  })

  it('returns [] when every interview tag matches some Capability', () => {
    const caps = [
      makeRecord({ id: 'gmail', tags: ['email', 'inbox'] }),
      makeRecord({ id: 'slack', tags: ['chat'] }),
    ]
    expect(findUnmatchedTags({ interview_tags: ['email', 'chat'], capabilities: caps })).toEqual([])
  })

  it('returns ONLY the orphan tags when partial overlap exists', () => {
    const caps = [makeRecord({ id: 'gmail', tags: ['email', 'inbox'] })]
    const out = findUnmatchedTags({
      interview_tags: ['email', 'spotify', 'feedburner'],
      capabilities: caps,
    })
    expect(out).toEqual(['feedburner', 'spotify'])
  })

  it('returns all interview tags when the catalog has zero entries', () => {
    expect(findUnmatchedTags({ interview_tags: ['music', 'podcasts'], capabilities: [] })).toEqual([
      'music',
      'podcasts',
    ])
  })

  it('matches case-insensitively (Email matches email)', () => {
    const caps = [makeRecord({ id: 'gmail', tags: ['email'] })]
    expect(findUnmatchedTags({ interview_tags: ['Email'], capabilities: caps })).toEqual([])
  })

  it('dedupes orphan tags differing only by case', () => {
    const caps = [makeRecord({ id: 'gmail', tags: ['email'] })]
    const out = findUnmatchedTags({
      interview_tags: ['Spotify', 'spotify', 'SPOTIFY'],
      capabilities: caps,
    })
    expect(out).toEqual(['Spotify'])
  })

  it('returns orphans sorted (case-insensitive) for deterministic gap ids', () => {
    const out = findUnmatchedTags({
      interview_tags: ['Charlie', 'alpha', 'Bravo'],
      capabilities: [],
    })
    expect(out).toEqual(['alpha', 'Bravo', 'Charlie'])
  })

  it('preserves the original interview-side casing in the output', () => {
    const out = findUnmatchedTags({
      interview_tags: ['Spotify', 'Feedburner'],
      capabilities: [makeRecord({ id: 'gmail', tags: ['email'] })],
    })
    expect(out).toEqual(['Feedburner', 'Spotify'])
  })
})
