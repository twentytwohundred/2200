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
schema_version: 2
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
    expect(id.frontmatter.schema_version).toBe(2)
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

  it('tolerates string schema_version on read (parsed to int and migrated forward)', async () => {
    // schema_version='1' as YAML string is the historical-document case;
    // the migrator chain parses it as 1, migrates 1->2, and the loader returns
    // a typed record with schema_version: 2.
    const path = await writeAt(
      'string-version.md',
      VALID.replace('schema_version: 2', "schema_version: '1'"),
    )
    const id = await loadIdentity(path)
    expect(id.frontmatter.schema_version).toBe(2)
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
    const path = await writeAt('bad.md', VALID.replace('agent_name: hobby', "agent_name: '@bad'"))
    const err = await validateIdentity(path)
    expect(err).not.toBeNull()
    expect(err).toMatch(/schema validation/)
  })
})

describe('validateFrontmatter', () => {
  it('parses an in-memory object', () => {
    const fm = validateFrontmatter({
      schema_version: 2,
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
    expect(() => validateFrontmatter({ schema_version: 2 })).toThrow()
  })
})

describe('migrator chain', () => {
  it('a v0 document (missing schema_version) is upgraded all the way to current on read', async () => {
    const path = await writeAt('v0.md', VALID.replace('schema_version: 2\n', ''))
    const id = await loadIdentity(path)
    expect(id.frontmatter.schema_version).toBe(2)
  })

  it('a v1 document (Epic 4.5 predecessor) is upgraded to v2 with the default cost_caps applied', async () => {
    const path = await writeAt('v1.md', VALID.replace('schema_version: 2', 'schema_version: 1'))
    const id = await loadIdentity(path)
    expect(id.frontmatter.schema_version).toBe(2)
    expect(id.frontmatter.cost_caps.daily_usd).toBe(10)
    expect(id.frontmatter.cost_caps.warn_at_pct).toBe(80)
    expect(id.frontmatter.cost_caps.reset_at).toBe('00:00 UTC')
    expect(id.frontmatter.cost_caps.on_breach).toBe('block_new_tasks')
  })

  it('a future schema_version (newer than the loader) is rejected', async () => {
    const path = await writeAt(
      'future.md',
      VALID.replace('schema_version: 2', 'schema_version: 99'),
    )
    await expect(loadIdentity(path)).rejects.toThrow(/newer than this loader supports/)
  })
})

describe('cost_caps', () => {
  it('absent cost_caps block defaults to $10/day with warn at 80%, UTC reset, block-new-tasks behavior', async () => {
    const path = await writeAt('default-caps.md', VALID)
    const id = await loadIdentity(path)
    expect(id.frontmatter.cost_caps).toEqual({
      daily_usd: 10,
      warn_at_pct: 80,
      reset_at: '00:00 UTC',
      on_breach: 'block_new_tasks',
    })
  })

  it('explicit cost_caps with only daily_usd fills other fields with defaults', async () => {
    const path = await writeAt(
      'partial-caps.md',
      VALID.replace('created: 2026-04-26', 'created: 2026-04-26\ncost_caps:\n  daily_usd: 50.00'),
    )
    const id = await loadIdentity(path)
    expect(id.frontmatter.cost_caps).toEqual({
      daily_usd: 50,
      warn_at_pct: 80,
      reset_at: '00:00 UTC',
      on_breach: 'block_new_tasks',
    })
  })

  it('explicit cost_caps with all fields set preserves them', async () => {
    const path = await writeAt(
      'full-caps.md',
      VALID.replace(
        'created: 2026-04-26',
        'created: 2026-04-26\ncost_caps:\n  daily_usd: 100\n  warn_at_pct: 50\n  reset_at: "00:00 America/New_York"\n  on_breach: block_new_tasks',
      ),
    )
    const id = await loadIdentity(path)
    expect(id.frontmatter.cost_caps).toEqual({
      daily_usd: 100,
      warn_at_pct: 50,
      reset_at: '00:00 America/New_York',
      on_breach: 'block_new_tasks',
    })
  })

  it('rejects a non-positive daily_usd', async () => {
    const path = await writeAt(
      'zero-usd.md',
      VALID.replace('created: 2026-04-26', 'created: 2026-04-26\ncost_caps:\n  daily_usd: 0'),
    )
    await expect(loadIdentity(path)).rejects.toThrow(/daily_usd/)
  })

  it('rejects a warn_at_pct outside [1, 99]', async () => {
    const tooHigh = await writeAt(
      'pct-too-high.md',
      VALID.replace(
        'created: 2026-04-26',
        'created: 2026-04-26\ncost_caps:\n  daily_usd: 10\n  warn_at_pct: 100',
      ),
    )
    await expect(loadIdentity(tooHigh)).rejects.toThrow(/warn_at_pct/)

    const tooLow = await writeAt(
      'pct-too-low.md',
      VALID.replace(
        'created: 2026-04-26',
        'created: 2026-04-26\ncost_caps:\n  daily_usd: 10\n  warn_at_pct: 0',
      ),
    )
    await expect(loadIdentity(tooLow)).rejects.toThrow(/warn_at_pct/)
  })

  it('rejects an unknown on_breach value', async () => {
    const path = await writeAt(
      'bad-breach.md',
      VALID.replace(
        'created: 2026-04-26',
        'created: 2026-04-26\ncost_caps:\n  daily_usd: 10\n  on_breach: throttle',
      ),
    )
    await expect(loadIdentity(path)).rejects.toThrow(/on_breach/)
  })
})
