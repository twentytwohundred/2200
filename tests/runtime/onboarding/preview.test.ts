/**
 * Tests for the preview renderer (Epic 14 Phase A PR D).
 */
import { describe, expect, it } from 'vitest'
import { renderPreview } from '../../../src/runtime/onboarding/preview.js'
import type { HandoffDocument } from '../../../src/runtime/migration/types.js'
import type { ToolSuggestion } from '../../../src/runtime/onboarding/tool-suggestions.js'
import type { ScheduleSuggestion } from '../../../src/runtime/onboarding/schedule-suggestions.js'

const HANDOFF: HandoffDocument = {
  frontmatter: {
    handoff_schema_version: 1,
    agent_name: 'emma',
    agent_type: 'email_agent',
    identity: {
      display_name: 'emma',
      notification_policy: { tiers_allowed: ['passive', 'normal', 'important'] },
    },
    brain: {},
    budget: { daily_cap_usd: 25 },
    schedules: [],
    mcp_servers: [],
    capabilities: [],
    provenance: { source_system: '2200_onboarding' },
  },
  body: 'I am Emma...',
  source_path: null,
}

const GMAIL_TOOL: ToolSuggestion = {
  server: {
    name: 'gmail',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-gmail'],
    env: {
      GMAIL_OAUTH_TOKEN: { source: 'env', id: 'GMAIL_OAUTH_TOKEN_EMMA' },
    },
  },
  env_hint: 'set GMAIL_OAUTH_TOKEN_EMMA in your shell',
  rationale: 'you mentioned watching doug@example.com',
  source_tag: 'tool_email_account',
}

const MORNING_SCHEDULE: ScheduleSuggestion = {
  id: 'morning_email_triage',
  cron: '0 8 * * *',
  tz: 'UTC',
  task: 'morning email triage',
  rationale: 'you said "every weekday morning"',
  source_tag: 'cadence_email',
}

describe('renderPreview', () => {
  it('includes the agent name, type, display name, notification policy, and budget', () => {
    const text = renderPreview({ handoff: HANDOFF, tools: [], schedules: [] })
    expect(text).toContain('Proposed Agent: emma')
    expect(text).toContain('Type:          email_agent')
    expect(text).toContain('Display name:  emma')
    expect(text).toContain('Notification:  passive, normal, important')
    expect(text).toContain('Cost cap:      $25/day')
  })

  it('shows "(none suggested)" when there are no tool suggestions', () => {
    const text = renderPreview({ handoff: HANDOFF, tools: [], schedules: [] })
    expect(text).toContain('Tools:         (none suggested')
  })

  it('renders tool suggestions with env_hint and rationale', () => {
    const text = renderPreview({ handoff: HANDOFF, tools: [GMAIL_TOOL], schedules: [] })
    expect(text).toContain('- gmail (set GMAIL_OAUTH_TOKEN_EMMA in your shell)')
    expect(text).toContain('you mentioned watching doug@example.com')
  })

  it('shows "(none suggested)" when there are no schedule suggestions', () => {
    const text = renderPreview({ handoff: HANDOFF, tools: [], schedules: [] })
    expect(text).toContain('Schedules:     (none suggested')
  })

  it('renders schedule suggestions with cron, tz, task, and rationale', () => {
    const text = renderPreview({ handoff: HANDOFF, tools: [], schedules: [MORNING_SCHEDULE] })
    expect(text).toContain('- morning_email_triage: cron "0 8 * * *" (UTC)')
    expect(text).toContain('task: morning email triage')
    expect(text).toContain('every weekday morning')
  })

  it('mentions the continuity-from-onboarding brain note', () => {
    const text = renderPreview({ handoff: HANDOFF, tools: [], schedules: [] })
    expect(text).toContain('continuity-from-onboarding')
  })
})
