/**
 * Tests for the Identity loader.
 *
 * Cover:
 *  - happy path round-trip (write then load)
 *  - body extraction (markdown after the second `---`)
 *  - missing file
 *  - missing frontmatter (no leading `---`)
 *  - unterminated frontmatter
 *  - malformed YAML
 *  - schema mismatches (each constrained field)
 *  - integer schema_version enforcement (string `"0.1"` rejected)
 *  - baseline-implicit tools (default empty)
 *  - migrator chain on a v0 stub document
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  IdentityParseError,
  loadIdentity,
  validateIdentity,
  validateFrontmatter,
} from '../../../src/runtime/identity/loader.js'
import { composeModelId } from '../../../src/runtime/identity/types.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), '2200-identity-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const VALID = `---
schema_version: 1
agent_name: hobby
agent_role: "primary build agent for 2200"
model:
  tier: frontier
  provider: anthropic
  model_id: claude-opus-4-7
tools: []
project_dir: /var/lib/2200/agents/hobby/project
brain_dir: /var/lib/2200/agents/hobby/brain
created: 2026-04-26
---

# Identity

Body of the Identity, free-form markdown.
`

async function writeAt(name: string, content: string): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, content, 'utf8')
  return path
}

describe('loadIdentity (happy path)', () => {
  it('parses a valid Identity into the typed record', async () => {
    const path = await writeAt('hobby.md', VALID)
    const id = await loadIdentity(path)
    expect(id.frontmatter.agent_name).toBe('hobby')
    expect(id.frontmatter.schema_version).toBe(1)
    expect(id.frontmatter.model.provider).toBe('anthropic')
    expect(id.frontmatter.model.model_id).toBe('claude-opus-4-7')
    expect(id.frontmatter.tools).toEqual([])
    expect(id.source_path).toBe(path)
  })

  it('extracts the markdown body after the closing `---`', async () => {
    const path = await writeAt('hobby.md', VALID)
    const id = await loadIdentity(path)
    expect(id.body.trimStart()).toMatch(/^# Identity/)
    expect(id.body).toContain('Body of the Identity')
  })

  it('composes model id as <provider>/<model_id>', async () => {
    const path = await writeAt('hobby.md', VALID)
    const id = await loadIdentity(path)
    expect(composeModelId(id.frontmatter.model)).toBe('anthropic/claude-opus-4-7')
  })

  it('treats tools: [pub.send] as additive (still no validation against a baseline)', async () => {
    const path = await writeAt(
      'hobby.md',
      VALID.replace('tools: []', 'tools:\n  - pub.send\n  - pub.read'),
    )
    const id = await loadIdentity(path)
    expect(id.frontmatter.tools).toEqual(['pub.send', 'pub.read'])
  })

  it('omitting tools entirely defaults to empty (baseline-only)', async () => {
    const path = await writeAt('hobby.md', VALID.replace('tools: []\n', ''))
    const id = await loadIdentity(path)
    expect(id.frontmatter.tools).toEqual([])
  })
})

describe('loadIdentity (error paths)', () => {
  it('throws on missing file', async () => {
    await expect(loadIdentity(join(dir, 'nope.md'))).rejects.toThrow(IdentityParseError)
  })

  it('throws when frontmatter is absent (no leading `---`)', async () => {
    const path = await writeAt('no-fm.md', '# Just markdown\n\nNo frontmatter.\n')
    await expect(loadIdentity(path)).rejects.toThrow(/no YAML frontmatter/)
  })

  it('throws when frontmatter is unterminated', async () => {
    const path = await writeAt('unterminated.md', '---\nagent_name: hobby\n# never closes\n')
    await expect(loadIdentity(path)).rejects.toThrow(/no YAML frontmatter/)
  })

  it('throws on malformed YAML', async () => {
    const path = await writeAt(
      'bad-yaml.md',
      '---\nagent_name: hobby\n: invalid: : :\n---\n\n# body\n',
    )
    await expect(loadIdentity(path)).rejects.toThrow(/malformed YAML frontmatter/)
  })

  it('rejects string schema_version (locked to integer)', async () => {
    const path = await writeAt(
      'string-version.md',
      VALID.replace('schema_version: 1', "schema_version: '1'"),
    )
    await expect(loadIdentity(path)).rejects.toThrow(/schema validation/)
  })

  it('rejects an agent_name with invalid characters', async () => {
    const path = await writeAt(
      'bad-name.md',
      VALID.replace('agent_name: hobby', "agent_name: '@hobby'"),
    )
    await expect(loadIdentity(path)).rejects.toThrow(/agent_name/)
  })

  it('rejects an unknown model.tier', async () => {
    const path = await writeAt('bad-tier.md', VALID.replace('tier: frontier', 'tier: ultra'))
    await expect(loadIdentity(path)).rejects.toThrow(/tier/)
  })

  it('rejects a model.provider with separators', async () => {
    const path = await writeAt(
      'bad-provider.md',
      VALID.replace('provider: anthropic', 'provider: anthropic-co'),
    )
    await expect(loadIdentity(path)).rejects.toThrow(/provider/)
  })

  it('rejects a non-ISO created date', async () => {
    const path = await writeAt(
      'bad-date.md',
      VALID.replace('created: 2026-04-26', 'created: yesterday'),
    )
    await expect(loadIdentity(path)).rejects.toThrow(/created/)
  })

  it('rejects a tool name without a namespace.verb shape', async () => {
    const path = await writeAt('bad-tool.md', VALID.replace('tools: []', 'tools:\n  - just_a_word'))
    await expect(loadIdentity(path)).rejects.toThrow(/tool name/)
  })
})

describe('validateIdentity', () => {
  it('returns null on valid Identity', async () => {
    const path = await writeAt('ok.md', VALID)
    expect(await validateIdentity(path)).toBeNull()
  })

  it('returns an error message on bad Identity', async () => {
    const path = await writeAt('bad.md', VALID.replace('schema_version: 1', "schema_version: '1'"))
    const err = await validateIdentity(path)
    expect(err).not.toBeNull()
    expect(err).toMatch(/schema validation/)
  })
})

describe('validateFrontmatter', () => {
  it('parses an in-memory object', () => {
    const fm = validateFrontmatter({
      schema_version: 1,
      agent_name: 'hobby',
      agent_role: 'test',
      model: { tier: 'frontier', provider: 'anthropic', model_id: 'claude-opus-4-7' },
      tools: [],
      project_dir: '/p',
      brain_dir: '/b',
      created: '2026-04-26',
    })
    expect(fm.agent_name).toBe('hobby')
  })

  it('rejects missing required fields', () => {
    expect(() => validateFrontmatter({ schema_version: 1 })).toThrow()
  })
})

describe('migrator chain', () => {
  it('a v0 document (missing schema_version) is upgraded to v1 on read', async () => {
    const path = await writeAt('v0.md', VALID.replace('schema_version: 1\n', ''))
    const id = await loadIdentity(path)
    expect(id.frontmatter.schema_version).toBe(1)
  })

  it('a future schema_version (newer than the loader) is rejected', async () => {
    const path = await writeAt(
      'future.md',
      VALID.replace('schema_version: 1', 'schema_version: 99'),
    )
    await expect(loadIdentity(path)).rejects.toThrow(/newer than this loader supports/)
  })
})
