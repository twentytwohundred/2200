/**
 * Tests for the onboarding script loader (Epic 14 Phase A PR A).
 *
 * Cover:
 *   - the canonical default-v1.yaml loads cleanly
 *   - schema version enforced
 *   - referential integrity: default_branch + routing[].next_branch must
 *     name a known branch
 *   - duplicate branch ids rejected
 *   - malformed YAML produces ScriptLoadError with the source path
 */
import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  loadScriptFile,
  parseScriptString,
  ScriptLoadError,
} from '../../../src/runtime/onboarding/script-loader.js'

const DEFAULT_V1_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'src',
  'runtime',
  'onboarding',
  'scripts',
  'default-v1.yaml',
)

const MINIMAL_YAML = `
script_schema_version: 1
name: test-minimal
opening:
  id: opening
  text: "What do you want?"
  intent_tag: opening_purpose
routing: []
default_branch: only_branch
branches:
  - id: only_branch
    questions:
      - id: q1
        text: "Tell me more."
        intent_tag: more
`

describe('loadScriptFile', () => {
  it('loads the canonical default-v1.yaml', async () => {
    const script = await loadScriptFile(DEFAULT_V1_PATH)
    expect(script.name).toBe('default-v1')
    expect(script.script_schema_version).toBe(1)
    expect(script.branches.length).toBeGreaterThanOrEqual(4)
    const branchIds = script.branches.map((b) => b.id).sort()
    expect(branchIds).toContain('email_agent_branch')
    expect(branchIds).toContain('project_agent_branch')
    expect(branchIds).toContain('ops_agent_branch')
    expect(branchIds).toContain('freeform_branch')
    expect(script.default_branch).toBe('freeform_branch')
  })

  it('throws ScriptLoadError on a missing file', async () => {
    await expect(loadScriptFile('/nonexistent/path/script.yaml')).rejects.toBeInstanceOf(
      ScriptLoadError,
    )
  })
})

describe('parseScriptString', () => {
  it('parses a minimum viable script', () => {
    const script = parseScriptString(MINIMAL_YAML, null)
    expect(script.name).toBe('test-minimal')
    expect(script.opening.id).toBe('opening')
    expect(script.branches[0]?.questions[0]?.id).toBe('q1')
  })

  it('rejects a wrong schema_version', () => {
    const text = MINIMAL_YAML.replace('script_schema_version: 1', 'script_schema_version: 2')
    expect(() => parseScriptString(text, null)).toThrow(/script_schema_version/)
  })

  it('rejects a default_branch that does not match any branch id', () => {
    const text = MINIMAL_YAML.replace('default_branch: only_branch', 'default_branch: ghost')
    expect(() => parseScriptString(text, null)).toThrow(/default_branch.*ghost.*does not match/)
  })

  it('rejects a routing rule whose next_branch does not match any branch id', () => {
    const text = `
script_schema_version: 1
name: bad-routing
opening:
  id: opening
  text: "x"
routing:
  - if_keywords: [foo]
    next_branch: ghost_branch
default_branch: real
branches:
  - id: real
    questions:
      - id: q1
        text: "real q"
`
    expect(() => parseScriptString(text, null)).toThrow(/routing\[0\]\.next_branch.*ghost_branch/)
  })

  it('rejects duplicate branch ids', () => {
    const text = `
script_schema_version: 1
name: dup
opening:
  id: opening
  text: "x"
routing: []
default_branch: dup_branch
branches:
  - id: dup_branch
    questions:
      - id: q1
        text: "first"
  - id: dup_branch
    questions:
      - id: q2
        text: "second"
`
    expect(() => parseScriptString(text, null)).toThrow(/duplicate branch id/)
  })

  it('rejects an invalid agent_name regex on a question id', () => {
    const text = MINIMAL_YAML.replace('id: q1', 'id: "Q1-Bad"')
    expect(() => parseScriptString(text, null)).toThrow(/question id/)
  })

  it('throws ScriptLoadError on malformed YAML', () => {
    expect(() => parseScriptString(': : : invalid', null)).toThrow(ScriptLoadError)
  })

  it('records source_path on error so the operator can fix the file', () => {
    try {
      parseScriptString('not a script', '/tmp/bad-script.yaml')
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ScriptLoadError)
      expect((err as ScriptLoadError).source_path).toBe('/tmp/bad-script.yaml')
    }
  })

  it('admits the routing list being empty (everything goes to default_branch)', () => {
    const script = parseScriptString(MINIMAL_YAML, null)
    expect(script.routing).toEqual([])
  })
})
