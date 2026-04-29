/**
 * Tests for suggestTools (Epic 14 Phase A PR C).
 *
 * Pure function over a transcript; covers:
 *   - email branch transcript → gmail server suggestion
 *   - project branch transcript → github server suggestion
 *   - ops branch with slack mention → slack server suggestion
 *   - ops branch without slack → no automatic suggestion
 *   - freeform branch → no automatic suggestions
 *   - env-var names compose with the agent name
 *   - duplicate server suggestions deduplicate
 */
import { describe, expect, it } from 'vitest'
import { suggestTools } from '../../../src/runtime/onboarding/tool-suggestions.js'
import type { InterviewTranscript } from '../../../src/runtime/onboarding/types.js'

function makeTranscript(
  entries: { id: string; tag?: string; answer: string }[],
): InterviewTranscript {
  return {
    interview_schema_version: 1,
    script_name: 'test',
    chosen_branch: 'test_branch',
    entries: entries.map((e) => ({
      question_id: e.id,
      question_text: `q for ${e.id}`,
      answer: e.answer,
      ...(e.tag !== undefined ? { intent_tag: e.tag } : {}),
      asked_at: '2026-04-29T12:00:00.000Z',
    })),
    summary: 'summary',
    started_at: '2026-04-29T12:00:00.000Z',
    finished_at: '2026-04-29T12:05:00.000Z',
  }
}

describe('suggestTools', () => {
  it('suggests Gmail for tool_email_account intent', () => {
    const t = makeTranscript([
      { id: 'opening', tag: 'opening_purpose', answer: 'email assistant' },
      { id: 'agent_name', tag: 'agent_name', answer: 'emma' },
      { id: 'email_account', tag: 'tool_email_account', answer: 'doug@example.com' },
    ])
    const suggestions = suggestTools(t, 'emma')
    expect(suggestions).toHaveLength(1)
    const s0 = suggestions[0]!
    const server = s0.server
    expect(server.name).toBe('gmail')
    if (server.transport !== 'stdio') throw new Error('expected stdio')
    expect(server.command).toBe('npx')
    expect(server.args).toContain('@modelcontextprotocol/server-gmail')
    expect(server.env['GMAIL_OAUTH_TOKEN']).toEqual({
      source: 'env',
      id: 'GMAIL_OAUTH_TOKEN_EMMA',
    })
    expect(s0.env_hint).toContain('GMAIL_OAUTH_TOKEN_EMMA')
    expect(s0.source_tag).toBe('tool_email_account')
  })

  it('suggests GitHub for tool_project_path intent', () => {
    const t = makeTranscript([
      { id: 'opening', tag: 'opening_purpose', answer: 'project agent' },
      { id: 'agent_name', tag: 'agent_name', answer: 'devy' },
      { id: 'project_path', tag: 'tool_project_path', answer: 'github.com/twentytwohundred/2200' },
    ])
    const suggestions = suggestTools(t, 'devy')
    expect(suggestions).toHaveLength(1)
    const server = suggestions[0]!.server
    expect(server.name).toBe('github')
    if (server.transport !== 'stdio') throw new Error('expected stdio')
    expect(server.env['GITHUB_TOKEN']).toEqual({
      source: 'env',
      id: 'GITHUB_TOKEN_DEVY',
    })
  })

  it('suggests Slack when ops_target answer mentions slack', () => {
    const t = makeTranscript([
      { id: 'opening', tag: 'opening_purpose', answer: 'ops' },
      { id: 'agent_name', tag: 'agent_name', answer: 'opsy' },
      { id: 'dashboards', tag: 'tool_ops_target', answer: 'slack #incidents and Datadog' },
    ])
    const suggestions = suggestTools(t, 'opsy')
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]?.server.name).toBe('slack')
  })

  it('returns no suggestion when ops answer does not mention slack', () => {
    const t = makeTranscript([
      { id: 'opening', tag: 'opening_purpose', answer: 'ops' },
      { id: 'agent_name', tag: 'agent_name', answer: 'opsy' },
      { id: 'dashboards', tag: 'tool_ops_target', answer: 'just metrics dashboards' },
    ])
    const suggestions = suggestTools(t, 'opsy')
    expect(suggestions).toEqual([])
  })

  it('returns no suggestions for a freeform-only transcript with no tagged tool questions', () => {
    const t = makeTranscript([
      { id: 'opening', tag: 'opening_purpose', answer: 'a creative writing assistant' },
      { id: 'agent_name', tag: 'agent_name', answer: 'muse' },
      { id: 'tools', tag: 'tools_freeform', answer: 'maybe a web browser?' },
    ])
    const suggestions = suggestTools(t, 'muse')
    expect(suggestions).toEqual([]) // no curated mapping for tools_freeform
  })

  it('composes uppercase env var name with the agent name', () => {
    const t = makeTranscript([
      { id: 'opening', tag: 'opening_purpose', answer: 'email' },
      { id: 'agent_name', tag: 'agent_name', answer: 'my-agent' },
      { id: 'email_account', tag: 'tool_email_account', answer: 'a@b.com' },
    ])
    const suggestions = suggestTools(t, 'my-agent')
    const server = suggestions[0]!.server
    if (server.transport !== 'stdio') throw new Error('expected stdio')
    expect(server.env['GMAIL_OAUTH_TOKEN']?.id).toBe('GMAIL_OAUTH_TOKEN_MY_AGENT')
  })

  it('skips tagged entries that have no curated mapping', () => {
    const t = makeTranscript([
      { id: 'opening', tag: 'unknown_tag', answer: 'some text' },
      { id: 'agent_name', tag: 'agent_name', answer: 'x' },
    ])
    const suggestions = suggestTools(t, 'x')
    expect(suggestions).toEqual([])
  })

  it('deduplicates when two entries map to the same server name', () => {
    const t = makeTranscript([
      { id: 'opening', tag: 'opening_purpose', answer: 'email' },
      { id: 'agent_name', tag: 'agent_name', answer: 'x' },
      { id: 'first_account', tag: 'tool_email_account', answer: 'first@example.com' },
      { id: 'second_account', tag: 'tool_email_account', answer: 'second@example.com' },
    ])
    const suggestions = suggestTools(t, 'x')
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]?.server.name).toBe('gmail')
  })
})
