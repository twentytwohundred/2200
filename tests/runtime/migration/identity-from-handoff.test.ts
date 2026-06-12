/**
 * Tests for buildIdentityFromHandoff (Epic 5 Phase A PR B).
 *
 * Pure-function tests: no IO, no tmpdirs. Asserts the produced
 * IdentityFrontmatter + body shape against the inputs.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildIdentityFromHandoff } from '../../../src/runtime/migration/identity-from-handoff.js'
import { parseHandoffString } from '../../../src/runtime/migration/parser.js'
import { writeIdentity, loadIdentity } from '../../../src/runtime/identity/loader.js'

const FIXED_DATE = new Date('2026-04-29T12:00:00Z')
const HOME = '/var/2200/test-home'

const HOBBY_HANDOFF = `---
handoff_schema_version: 1
agent_name: hobby
agent_type: build_agent
identity:
  display_name: hobby
  notification_policy:
    tiers_allowed: [passive, normal, important]
brain:
  source_dir: ~/some/source/memory/
budget:
  daily_cap_usd: 50
provenance:
  source_system: claude_code
---

# Hobby's migration

I am Hobby, the primary build Agent.
`

describe('buildIdentityFromHandoff', () => {
  it('builds a valid Identity frontmatter + body from a Hobby-shape handoff', () => {
    const handoff = parseHandoffString(HOBBY_HANDOFF, '/tmp/hobby.handoff.md')
    const built = buildIdentityFromHandoff({
      handoff,
      home: HOME,
      today: FIXED_DATE,
    })

    expect(built.frontmatter.schema_version).toBe(5)
    expect(built.frontmatter.agent_name).toBe('hobby')
    expect(built.frontmatter.agent_role).toBe('build agent')
    expect(built.frontmatter.model.tier).toBe('frontier')
    expect(built.frontmatter.model.provider).toBe('anthropic')
    expect(built.frontmatter.model.model_id).toBe('claude-opus-4-7')
    expect(built.frontmatter.tools).toEqual([])
    expect(built.frontmatter.project_dir).toBe('/var/2200/test-home/agents/hobby/project')
    expect(built.frontmatter.brain_dir).toBe('/var/2200/test-home/agents/hobby/brain')
    expect(built.frontmatter.created).toBe('2026-04-29')
    expect(built.frontmatter.cost_caps.daily_usd).toBe(50)
    expect(built.frontmatter.notification_policy.tiers_allowed).toEqual([
      'passive',
      'normal',
      'important',
    ])
    expect(built.frontmatter.scut).toBeUndefined()
    expect(built.frontmatter.pub).toBeUndefined()

    expect(built.source_path).toBe('/var/2200/test-home/hobby.identity.md')
    expect(built.body).toContain('# Hobby')
    expect(built.body).toContain('continuity-from-migration')
    expect(built.body).toContain('/tmp/hobby.handoff.md')
  })

  it('uses the budget daily_cap from the handoff', () => {
    const handoff = parseHandoffString(
      HOBBY_HANDOFF.replace('daily_cap_usd: 50', 'daily_cap_usd: 7'),
      null,
    )
    const built = buildIdentityFromHandoff({
      handoff,
      home: HOME,
      today: FIXED_DATE,
    })
    expect(built.frontmatter.cost_caps.daily_usd).toBe(7)
  })

  it('preserves the operator-set notification_policy.tiers_allowed (including critical)', () => {
    const text = `---
handoff_schema_version: 1
agent_name: critical_agent
identity:
  display_name: critical_agent
  notification_policy:
    tiers_allowed: [passive, normal, important, critical]
budget:
  daily_cap_usd: 5
---
body
`
    const handoff = parseHandoffString(text, null)
    const built = buildIdentityFromHandoff({
      handoff,
      home: HOME,
      today: FIXED_DATE,
    })
    expect(built.frontmatter.notification_policy.tiers_allowed).toEqual([
      'passive',
      'normal',
      'important',
      'critical',
    ])
  })

  it('passes mcp_servers from handoff into the Identity (Phase A friction-fix)', () => {
    const text = `---
handoff_schema_version: 1
agent_name: emma
agent_type: email_agent
identity:
  display_name: emma
budget:
  daily_cap_usd: 25
mcp_servers:
  - name: gmail
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-gmail']
    env:
      GMAIL_OAUTH_TOKEN:
        source: env
        id: GMAIL_OAUTH_TOKEN_EMMA
---
body
`
    const handoff = parseHandoffString(text, null)
    const built = buildIdentityFromHandoff({
      handoff,
      home: HOME,
      today: FIXED_DATE,
    })
    expect(built.frontmatter.mcp_servers).toHaveLength(1)
    expect(built.frontmatter.mcp_servers[0]?.name).toBe('gmail')
    // Wildcard tool grant seeded so the Agent has access to the
    // declared server's tools the moment it starts.
    expect(built.frontmatter.tools).toEqual(['gmail.*'])
  })

  it('passes capabilities from handoff into the Identity (Phase F §8)', () => {
    const text = `---
handoff_schema_version: 1
agent_name: pilot
agent_type: email_agent
identity:
  display_name: pilot
budget:
  daily_cap_usd: 25
capabilities:
  - google-workspace
  - slack
---
body
`
    const handoff = parseHandoffString(text, null)
    const built = buildIdentityFromHandoff({
      handoff,
      home: HOME,
      today: FIXED_DATE,
    })
    expect(built.frontmatter.capabilities).toEqual(['google-workspace', 'slack'])
  })

  it('defaults Identity capabilities to [] when handoff omits the field', () => {
    const text = `---
handoff_schema_version: 1
agent_name: blank
identity:
  display_name: blank
budget:
  daily_cap_usd: 25
---
body
`
    const handoff = parseHandoffString(text, null)
    const built = buildIdentityFromHandoff({
      handoff,
      home: HOME,
      today: FIXED_DATE,
    })
    expect(built.frontmatter.capabilities).toEqual([])
  })

  it('seeds tools with one wildcard per declared mcp_server', () => {
    const text = `---
handoff_schema_version: 1
agent_name: multi
identity:
  display_name: multi
budget:
  daily_cap_usd: 10
mcp_servers:
  - name: github
    transport: stdio
    command: npx
    args: []
    env: {}
  - name: slack
    transport: stdio
    command: npx
    args: []
    env: {}
---
body
`
    const handoff = parseHandoffString(text, null)
    const built = buildIdentityFromHandoff({
      handoff,
      home: HOME,
      today: FIXED_DATE,
    })
    expect(built.frontmatter.tools.sort()).toEqual(['github.*', 'slack.*'])
  })

  it('humanizes underscores in agent_type for agent_role', () => {
    const text = `---
handoff_schema_version: 1
agent_name: x
agent_type: research_assistant_agent
identity:
  display_name: x
budget:
  daily_cap_usd: 5
---
body
`
    const handoff = parseHandoffString(text, null)
    const built = buildIdentityFromHandoff({
      handoff,
      home: HOME,
      today: FIXED_DATE,
    })
    expect(built.frontmatter.agent_role).toBe('research assistant agent')
  })

  it('omits the original-handoff-path footer when source_path is null', () => {
    const handoff = parseHandoffString(HOBBY_HANDOFF, null)
    const built = buildIdentityFromHandoff({
      handoff,
      home: HOME,
      today: FIXED_DATE,
    })
    expect(built.body).not.toContain('Original handoff document:')
  })

  it('formats today consistently across timezones (UTC)', () => {
    const handoff = parseHandoffString(HOBBY_HANDOFF, null)
    // Different time-of-day, same UTC date
    const morning = buildIdentityFromHandoff({
      handoff,
      home: HOME,
      today: new Date('2026-04-29T01:00:00Z'),
    })
    const evening = buildIdentityFromHandoff({
      handoff,
      home: HOME,
      today: new Date('2026-04-29T23:30:00Z'),
    })
    expect(morning.frontmatter.created).toBe('2026-04-29')
    expect(evening.frontmatter.created).toBe('2026-04-29')
  })

  it('produces an Identity that round-trips through writeIdentity / loadIdentity', async () => {
    const home = await mkdtemp(join(tmpdir(), '2200-id-from-handoff-'))
    try {
      const handoff = parseHandoffString(HOBBY_HANDOFF, '/tmp/hobby.handoff.md')
      const built = buildIdentityFromHandoff({
        handoff,
        home,
        today: FIXED_DATE,
      })
      await writeIdentity(built.source_path, built.frontmatter, built.body)
      const reloaded = await loadIdentity(built.source_path)
      expect(reloaded.frontmatter.agent_name).toBe('hobby')
      expect(reloaded.frontmatter.agent_role).toBe('build agent')
      expect(reloaded.frontmatter.cost_caps.daily_usd).toBe(50)
      expect(reloaded.body).toContain('continuity-from-migration')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('uses persona_body as the Identity body verbatim (the Agent keeps its voice)', () => {
    const text = `---
handoff_schema_version: 1
agent_name: skippy
identity:
  display_name: Skippy
budget:
  daily_cap_usd: 20
persona_body: |
  # SOUL.md — Skippy

  Snarky, brilliant, never lets anyone forget it.
---
continuity narrative goes to the brain note, not the Identity
`
    const handoff = parseHandoffString(text, null)
    const built = buildIdentityFromHandoff({
      handoff,
      home: HOME,
      today: FIXED_DATE,
    })
    expect(built.body).toContain('Snarky, brilliant')
    // The generated stub must NOT replace the persona.
    expect(built.body).not.toContain('starting stub')
  })
})
