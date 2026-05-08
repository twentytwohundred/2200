/**
 * Tests for the onboarding script loader (v2: LLM-driven).
 *
 * Cover:
 *   - the canonical default-v2.yaml loads cleanly
 *   - schema version enforced (must be 2)
 *   - duplicate goal ids rejected
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

const DEFAULT_SCRIPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'src',
  'runtime',
  'onboarding',
  'scripts',
  'default-v2.yaml',
)

const MINIMAL_YAML = `
script_schema_version: 2
name: test-minimal
opening:
  id: opening
  text: "What do you want?"
  intent_tag: purpose
goals:
  - id: purpose
    description: "what the agent does"
    required: true
  - id: agent_name
    description: "what to call the agent"
    required: true
`

describe('loadScriptFile', () => {
  it('loads the canonical default-v2.yaml', async () => {
    const script = await loadScriptFile(DEFAULT_SCRIPT_PATH)
    expect(script.name).toBe('default-v2')
    expect(script.script_schema_version).toBe(2)
    expect(script.goals.length).toBeGreaterThanOrEqual(4)
    const goalIds = script.goals.map((g) => g.id).sort()
    expect(goalIds).toContain('purpose')
    expect(goalIds).toContain('agent_name')
    expect(goalIds).toContain('trigger')
    expect(goalIds).toContain('tools')
  })

  it('throws ScriptLoadError on a missing file', async () => {
    await expect(loadScriptFile('/nonexistent/path/script.yaml')).rejects.toBeInstanceOf(
      ScriptLoadError,
    )
  })
})

describe('parseScriptString', () => {
  it('parses a minimum viable v2 script', () => {
    const script = parseScriptString(MINIMAL_YAML, null)
    expect(script.name).toBe('test-minimal')
    expect(script.opening.id).toBe('opening')
    expect(script.goals[0]?.id).toBe('purpose')
    expect(script.goals[0]?.required).toBe(true)
  })

  it('rejects a wrong schema_version', () => {
    const text = MINIMAL_YAML.replace('script_schema_version: 2', 'script_schema_version: 1')
    expect(() => parseScriptString(text, null)).toThrow(/script_schema_version/)
  })

  it('rejects duplicate goal ids', () => {
    const text = `
script_schema_version: 2
name: dup
opening:
  id: opening
  text: "x"
goals:
  - id: same_id
    description: "first"
  - id: same_id
    description: "second"
`
    expect(() => parseScriptString(text, null)).toThrow(/duplicate goal id/)
  })

  it('rejects an invalid id regex on a question id', () => {
    const text = MINIMAL_YAML.replace('id: opening', 'id: "Opening-Bad"')
    expect(() => parseScriptString(text, null)).toThrow(/question id/)
  })

  it('rejects an invalid id regex on a goal id', () => {
    const text = MINIMAL_YAML.replace('id: purpose', 'id: "Purpose-Bad"')
    expect(() => parseScriptString(text, null)).toThrow(/goal id/)
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

  it('defaults target_turns and max_turns when unspecified', () => {
    const script = parseScriptString(MINIMAL_YAML, null)
    expect(script.target_turns).toBeGreaterThan(0)
    expect(script.max_turns).toBeGreaterThan(0)
  })
})
