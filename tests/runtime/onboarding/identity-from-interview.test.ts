/**
 * Tests for buildHandoffFromTranscript (Epic 14 Phase A PR C).
 *
 * Pure (modulo os.hostname()). Tests inject sourceHost so they are
 * deterministic.
 */
import { describe, expect, it } from 'vitest'
import { buildHandoffFromTranscript } from '../../../src/runtime/onboarding/identity-from-interview.js'
import {
  ONBOARDING_NOTE_SLUG,
  type InterviewTranscript,
} from '../../../src/runtime/onboarding/types.js'

function transcript(opts: {
  agentName?: string
  branch?: string
  summary?: string
  entries?: { id: string; tag?: string; answer: string }[]
}): InterviewTranscript {
  const entries = opts.entries ?? [
    { id: 'opening', tag: 'opening_purpose', answer: 'I want an email assistant' },
    { id: 'agent_name', tag: 'agent_name', answer: opts.agentName ?? 'emma' },
    { id: 'email_account', tag: 'tool_email_account', answer: 'doug@example.com' },
  ]
  return {
    interview_schema_version: 2,
    script_name: 'test-script',
    chosen_branch: opts.branch ?? 'email_agent_branch',
    entries: entries.map((e) => ({
      question_id: e.id,
      question_text: `q for ${e.id}`,
      answer: e.answer,
      ...(e.tag !== undefined ? { intent_tag: e.tag } : {}),
      asked_at: '2026-04-29T12:00:00.000Z',
    })),
    summary: opts.summary ?? 'I am Emma, an email Agent. I will watch doug@example.com.',
    started_at: '2026-04-29T12:00:00.000Z',
    finished_at: '2026-04-29T12:05:00.000Z',
  }
}

describe('buildHandoffFromTranscript', () => {
  it('produces a HandoffDocument with the expected shape', () => {
    const handoff = buildHandoffFromTranscript({
      transcript: transcript({}),
      sourceHost: 'test-host',
    })

    expect(handoff.frontmatter.handoff_schema_version).toBe(1)
    expect(handoff.frontmatter.agent_name).toBe('emma')
    expect(handoff.frontmatter.agent_type).toBe('email_agent')
    expect(handoff.frontmatter.identity.display_name).toBe('emma')
    expect(handoff.frontmatter.identity.notification_policy.tiers_allowed).toEqual([
      'passive',
      'normal',
      'important',
    ])
    expect(handoff.frontmatter.budget.daily_cap_usd).toBe(25)
    expect(handoff.frontmatter.schedules).toEqual([])
    expect(handoff.frontmatter.provenance.source_system).toBe('2200_onboarding')
    expect(handoff.frontmatter.provenance.source_host).toBe('test-host')
    expect(handoff.frontmatter.provenance.exported_at).toBe('2026-04-29T12:05:00.000Z')
  })

  it('puts the LLM summary in the inline note body', () => {
    const handoff = buildHandoffFromTranscript({
      transcript: transcript({ summary: 'Custom summary text.' }),
      sourceHost: 'test-host',
    })
    const note = handoff.frontmatter.brain.inline_notes?.[0]
    expect(note?.slug).toBe(ONBOARDING_NOTE_SLUG)
    expect(note?.title).toBe('Continuity from onboarding')
    expect(note?.type).toBe('continuity')
    expect(note?.body).toBe('Custom summary text.')
    expect(note?.tags).toContain('onboarding')
    expect(note?.tags).toContain('email_agent')
  })

  it('strips the _branch suffix from the chosen_branch for agent_type', () => {
    const handoff = buildHandoffFromTranscript({
      transcript: transcript({ branch: 'project_agent_branch' }),
      sourceHost: 'test-host',
    })
    expect(handoff.frontmatter.agent_type).toBe('project_agent')
  })

  it('keeps a branch id verbatim if it does not end in _branch', () => {
    const handoff = buildHandoffFromTranscript({
      transcript: transcript({ branch: 'custom_id' }),
      sourceHost: 'test-host',
    })
    expect(handoff.frontmatter.agent_type).toBe('custom_id')
  })

  it('synthesizes a name from the opening answer when no agent_name tag is captured', () => {
    const handoff = buildHandoffFromTranscript({
      transcript: transcript({
        entries: [
          { id: 'opening', tag: 'purpose', answer: 'research assistant for genomics' },
          { id: 'q1', answer: 'no tag' },
        ],
      }),
      sourceHost: 'test-host',
    })
    // The synthesizer takes the first 24 chars of the opening answer
    // and normalizes; we accept any name derived from that prefix.
    expect(handoff.frontmatter.agent_name).toMatch(/^[a-z][a-z0-9_-]*$/)
    expect(handoff.frontmatter.agent_name.length).toBeGreaterThan(0)
  })

  it('normalizes a free-form name to a valid agent identifier', () => {
    const handoff = buildHandoffFromTranscript({
      transcript: transcript({ agentName: 'Email-Triage Bot 2.0' }),
      sourceHost: 'test-host',
    })
    expect(handoff.frontmatter.agent_name).toBe('email-triage-bot-2-0')
  })

  it('throws when the normalized name does not start with a letter', () => {
    expect(() =>
      buildHandoffFromTranscript({
        transcript: transcript({ agentName: '!@#' }),
        sourceHost: 'test-host',
      }),
    ).toThrow(/cannot be normalized/)
  })

  it('inherits os.hostname() when sourceHost is omitted', () => {
    const handoff = buildHandoffFromTranscript({ transcript: transcript({}) })
    expect(handoff.frontmatter.provenance.source_host).toBeDefined()
    expect(handoff.frontmatter.provenance.source_host?.length).toBeGreaterThan(0)
  })

  it('defaults mcp_servers to empty when none provided', () => {
    const handoff = buildHandoffFromTranscript({
      transcript: transcript({}),
      sourceHost: 'test-host',
    })
    expect(handoff.frontmatter.mcp_servers).toEqual([])
  })

  it('passes through mcpServers when provided (Phase A friction-fix)', () => {
    const handoff = buildHandoffFromTranscript({
      transcript: transcript({}),
      sourceHost: 'test-host',
      mcpServers: [
        {
          name: 'github',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_TOKEN: { source: 'env', id: 'GITHUB_TOKEN_EMMA' } },
        },
      ],
    })
    expect(handoff.frontmatter.mcp_servers).toHaveLength(1)
    expect(handoff.frontmatter.mcp_servers[0]?.name).toBe('github')
  })
})
