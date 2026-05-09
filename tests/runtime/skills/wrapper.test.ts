import { describe, expect, it } from 'vitest'
import {
  synthesizeSkillManifest,
  SKILL_SYNTHETIC_VERSION,
} from '../../../src/runtime/skills/wrapper.js'
import type { ParsedSkill } from '../../../src/runtime/skills/types.js'
import { ExtensionManifestSchema } from '../../../src/runtime/extensions/types.js'

function makeSkill(overrides: Partial<ParsedSkill> = {}): ParsedSkill {
  const fm = {
    name: 'demo',
    description: 'A demo Skill for tests.',
    tags: [],
    tools: [],
    ...(overrides.frontmatter ?? {}),
  }
  return {
    name: overrides.name ?? fm.name,
    path: overrides.path ?? '/x/skills/demo/SKILL.md',
    frontmatter: fm,
    extras: overrides.extras ?? {},
    body: overrides.body ?? 'Body of the demo skill.',
  }
}

describe('synthesizeSkillManifest', () => {
  it('produces a manifest that passes ExtensionManifestSchema', () => {
    const skill = makeSkill({
      frontmatter: {
        name: 'demo',
        description: 'd',
        tags: [],
        tools: ['fs_read', 'web_fetch'],
      },
    })
    const m = synthesizeSkillManifest(skill)
    expect(() => ExtensionManifestSchema.parse(m)).not.toThrow()
    expect(m.name).toBe('demo')
    expect(m.permissions).toEqual([])
    expect(m.tools.map((t) => t.name)).toEqual(['fs_read', 'web_fetch'])
    expect(m.version).toBe(SKILL_SYNTHETIC_VERSION)
  })

  it('derives a Title-cased display_name from a kebab-case slug', () => {
    const skill = makeSkill({
      name: 'finance-tracker',
      frontmatter: {
        name: 'finance-tracker',
        description: 'd',
        tags: [],
        tools: [],
      },
    })
    expect(synthesizeSkillManifest(skill).display_name).toBe('Finance Tracker')
  })

  it('uses an extras-supplied display_name when present', () => {
    const skill = makeSkill({
      extras: { display_name: 'Custom Display' },
    })
    expect(synthesizeSkillManifest(skill).display_name).toBe('Custom Display')
  })

  it('uses an extras-supplied author / homepage when present', () => {
    const skill = makeSkill({
      extras: {
        author: 'Doug',
        homepage: 'https://example.com/skill',
      },
    })
    const m = synthesizeSkillManifest(skill)
    expect(m.author).toBe('Doug')
    expect(m.homepage).toBe('https://example.com/skill')
  })

  it('falls back to the supplied default author', () => {
    const skill = makeSkill()
    expect(synthesizeSkillManifest(skill, { defaultAuthor: 'Tester' }).author).toBe('Tester')
  })

  it('falls back to "unknown" author when no author is anywhere', () => {
    const skill = makeSkill()
    expect(synthesizeSkillManifest(skill).author).toBe('unknown')
  })

  it('honors a version override', () => {
    const skill = makeSkill()
    const m = synthesizeSkillManifest(skill, { version: '1.2.3' })
    expect(m.version).toBe('1.2.3')
  })
})
