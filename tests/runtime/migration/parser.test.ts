/**
 * Tests for the migration handoff document parser (Epic 5 Phase A PR A).
 *
 * Covers:
 *   - happy path: full handoff (Hobby-shape) parses and produces the
 *     expected HandoffDocument
 *   - happy path: minimum-viable handoff (only required fields) gets
 *     defaults filled in
 *   - error paths: missing frontmatter, malformed YAML, schema_version
 *     mismatch, agent_name regex violation, schedules-not-empty
 *     constraint
 *   - file vs string entry points produce the same result
 *   - the body is preserved verbatim, including leading newlines and
 *     trailing whitespace
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HandoffParseError,
  parseHandoffFile,
  parseHandoffString,
} from '../../../src/runtime/migration/parser.js'

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
schedules: []
provenance:
  source_system: claude_code
  source_host: doug-macbook-pro
  exported_at: 2026-04-29T08:00:00Z
---

# Hobby's migration into 2200

## Who I am

The primary build Agent on the 2200 project.
`

const MINIMAL_HANDOFF = `---
handoff_schema_version: 1
agent_name: minimal
identity:
  display_name: minimal
budget:
  daily_cap_usd: 5
---

(body)
`

describe('parseHandoffString', () => {
  it('parses a full handoff document', () => {
    const doc = parseHandoffString(HOBBY_HANDOFF, '/tmp/hobby.handoff.md')
    expect(doc.frontmatter.handoff_schema_version).toBe(1)
    expect(doc.frontmatter.agent_name).toBe('hobby')
    expect(doc.frontmatter.agent_type).toBe('build_agent')
    expect(doc.frontmatter.identity.display_name).toBe('hobby')
    expect(doc.frontmatter.identity.notification_policy.tiers_allowed).toEqual([
      'passive',
      'normal',
      'important',
    ])
    expect(doc.frontmatter.brain.source_dir).toBe('~/some/source/memory/')
    expect(doc.frontmatter.budget.daily_cap_usd).toBe(50)
    expect(doc.frontmatter.schedules).toEqual([])
    expect(doc.frontmatter.provenance.source_system).toBe('claude_code')
    expect(doc.body).toContain("Hobby's migration into 2200")
    expect(doc.source_path).toBe('/tmp/hobby.handoff.md')
  })

  it('fills defaults on a minimum-viable handoff', () => {
    const doc = parseHandoffString(MINIMAL_HANDOFF, null)
    expect(doc.frontmatter.agent_type).toBe('agent')
    expect(doc.frontmatter.identity.notification_policy.tiers_allowed).toEqual([
      'passive',
      'normal',
      'important',
    ])
    expect(doc.frontmatter.brain).toEqual({})
    expect(doc.frontmatter.schedules).toEqual([])
    expect(doc.frontmatter.provenance).toEqual({})
    expect(doc.source_path).toBeNull()
  })

  it('preserves the body verbatim', () => {
    const text = `---
handoff_schema_version: 1
agent_name: x
identity:
  display_name: x
budget:
  daily_cap_usd: 1
---


Trailing-newline-then-content.

  Indented line.
`
    const doc = parseHandoffString(text, null)
    // The two blank lines after the closing `---` are both preserved
    // in the body (the parser consumes only the single newline that
    // terminates the closing `---` line itself).
    expect(doc.body).toBe(`\n\nTrailing-newline-then-content.\n\n  Indented line.\n`)
  })

  it('throws on missing frontmatter', () => {
    expect(() => parseHandoffString('# Just a body, no frontmatter\n', null)).toThrow(
      HandoffParseError,
    )
  })

  it('throws on a wrong schema_version', () => {
    const text = `---
handoff_schema_version: 2
agent_name: x
identity:
  display_name: x
budget:
  daily_cap_usd: 1
---
body
`
    expect(() => parseHandoffString(text, null)).toThrow(/handoff_schema_version/)
  })

  it('throws on a malformed agent_name', () => {
    const text = `---
handoff_schema_version: 1
agent_name: "Has Spaces"
identity:
  display_name: x
budget:
  daily_cap_usd: 1
---
body
`
    expect(() => parseHandoffString(text, null)).toThrow(/agent_name/)
  })

  it('throws when schedules is non-empty (Phase A constraint)', () => {
    const text = `---
handoff_schema_version: 1
agent_name: x
identity:
  display_name: x
budget:
  daily_cap_usd: 1
schedules:
  - expr: "0 8 * * *"
    task: "morning briefing"
---
body
`
    expect(() => parseHandoffString(text, null)).toThrow(/Phase A requires schedules/)
  })

  it('throws on a non-positive daily cap', () => {
    const text = `---
handoff_schema_version: 1
agent_name: x
identity:
  display_name: x
budget:
  daily_cap_usd: 0
---
body
`
    expect(() => parseHandoffString(text, null)).toThrow(/daily_cap_usd/)
  })

  it('throws on malformed YAML', () => {
    const text = `---
handoff_schema_version: 1
agent_name: x
identity:
  display_name: x  : extra-colon
---
body
`
    expect(() => parseHandoffString(text, null)).toThrow(HandoffParseError)
  })

  it('records the source_path on the error so the operator can fix it', () => {
    try {
      parseHandoffString('not a handoff', '/tmp/broken.handoff.md')
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(HandoffParseError)
      expect((err as HandoffParseError).source_path).toBe('/tmp/broken.handoff.md')
    }
  })

  it('admits inline_notes', () => {
    const text = `---
handoff_schema_version: 1
agent_name: x
identity:
  display_name: x
brain:
  inline_notes:
    - title: "First note"
      body: "Body of first note."
      type: "freeform"
      tags: ["greeting"]
budget:
  daily_cap_usd: 1
---
body
`
    const doc = parseHandoffString(text, null)
    expect(doc.frontmatter.brain.inline_notes).toEqual([
      {
        title: 'First note',
        body: 'Body of first note.',
        type: 'freeform',
        tags: ['greeting'],
      },
    ])
  })

  it('admits an optional mcp_servers list (Phase A friction-fix)', () => {
    const text = `---
handoff_schema_version: 1
agent_name: x
identity:
  display_name: x
budget:
  daily_cap_usd: 1
mcp_servers:
  - name: github
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_TOKEN:
        source: env
        id: GITHUB_TOKEN_X
---
body
`
    const doc = parseHandoffString(text, null)
    expect(doc.frontmatter.mcp_servers).toHaveLength(1)
    expect(doc.frontmatter.mcp_servers[0]?.name).toBe('github')
  })

  it('defaults mcp_servers to empty when the field is absent', () => {
    const doc = parseHandoffString(MINIMAL_HANDOFF, null)
    expect(doc.frontmatter.mcp_servers).toEqual([])
  })

  it('admits Phase B carryover_keys without breaking (Phase A ignores them)', () => {
    const text = `---
handoff_schema_version: 1
agent_name: x
identity:
  display_name: x
  carryover_keys:
    signing_path: /opt/keys/signing.ed25519
    encryption_path: /opt/keys/encryption.x25519
budget:
  daily_cap_usd: 1
---
body
`
    const doc = parseHandoffString(text, null)
    expect(doc.frontmatter.identity.carryover_keys).toEqual({
      signing_path: '/opt/keys/signing.ed25519',
      encryption_path: '/opt/keys/encryption.x25519',
    })
  })
})

describe('parseHandoffFile', () => {
  it('reads and parses a file from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), '2200-handoff-parser-'))
    try {
      const path = join(dir, 'hobby.handoff.md')
      await writeFile(path, HOBBY_HANDOFF)
      const doc = await parseHandoffFile(path)
      expect(doc.frontmatter.agent_name).toBe('hobby')
      expect(doc.source_path).toBe(path)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('throws HandoffParseError on a missing file', async () => {
    await expect(parseHandoffFile('/nonexistent/path/hobby.handoff.md')).rejects.toBeInstanceOf(
      HandoffParseError,
    )
  })
})
