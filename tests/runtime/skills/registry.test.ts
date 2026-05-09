import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listSkills, readSkill, skillsHome } from '../../../src/runtime/skills/registry.js'
import { parseSkillContent } from '../../../src/runtime/skills/types.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-skills-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

interface MakeArgs {
  name: string
  description?: string
  tags?: string[]
  tools?: string[]
  body?: string
  invalid?: 'no-frontmatter' | 'bad-name' | 'malformed-yaml' | undefined
}

async function makeSkill(args: MakeArgs): Promise<void> {
  const dir = join(home, 'skills', args.name)
  await mkdir(dir, { recursive: true })
  let content: string
  if (args.invalid === 'no-frontmatter') {
    content = '# Just a body, no frontmatter\n'
  } else if (args.invalid === 'malformed-yaml') {
    content = '---\nname: x\n  not_yaml: [\n---\n\nbody\n'
  } else if (args.invalid === 'bad-name') {
    content = '---\nname: BadName\ndescription: x\n---\n\nbody\n'
  } else {
    const tagsLine = args.tags ? `tags: [${args.tags.map((t) => `"${t}"`).join(', ')}]\n` : ''
    const toolsLine = args.tools ? `tools: [${args.tools.map((t) => `"${t}"`).join(', ')}]\n` : ''
    content = `---\nname: ${args.name}\ndescription: ${args.description ?? `A skill named ${args.name}.`}\n${tagsLine}${toolsLine}---\n\n${args.body ?? 'Skill body.'}\n`
  }
  await writeFile(join(dir, 'SKILL.md'), content, 'utf-8')
}

describe('listSkills', () => {
  it('returns [] when the skills root does not exist', async () => {
    expect(await listSkills(home)).toEqual([])
  })

  it('returns entries for valid SKILL.md files', async () => {
    await makeSkill({ name: 'alpha', description: 'Alpha skill', tags: ['build', 'release'] })
    await makeSkill({ name: 'beta', description: 'Beta skill' })
    const items = await listSkills(home)
    expect(items.map((e) => e.name).sort()).toEqual(['alpha', 'beta'])
    expect(items.find((e) => e.name === 'alpha')?.tags).toEqual(['build', 'release'])
    expect(items.every((e) => e.status === 'ok')).toBe(true)
  })

  it('marks malformed entries as invalid without breaking others', async () => {
    await makeSkill({ name: 'good', description: 'Fine' })
    await makeSkill({ name: 'no-fm', invalid: 'no-frontmatter' })
    await makeSkill({ name: 'badname', invalid: 'bad-name' })
    const items = await listSkills(home)
    expect(items.find((e) => e.name === 'good')?.status).toBe('ok')
    expect(items.find((e) => e.name === 'no-fm')?.status).toBe('invalid')
    expect(items.find((e) => e.name === 'badname')?.status).toBe('invalid')
  })
})

describe('readSkill', () => {
  it('returns the parsed Skill', async () => {
    await makeSkill({
      name: 'release-notes',
      description: 'Compose human-readable release notes from a git diff.',
      tags: ['release'],
      tools: ['git.*', 'fs_read'],
      body: 'When asked for release notes, walk the diff and produce a bulleted list.',
    })
    const s = await readSkill(home, 'release-notes')
    expect(s.frontmatter.description).toMatch(/release notes/)
    expect(s.frontmatter.tools).toEqual(['git.*', 'fs_read'])
    expect(s.body).toMatch(/walk the diff/)
  })

  it('throws when the SKILL.md is missing', async () => {
    await expect(readSkill(home, 'nope')).rejects.toThrow(/does not exist/)
  })

  it('throws when the frontmatter name does not match the dir', async () => {
    const dir = join(home, 'skills', 'wrongdir')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'SKILL.md'),
      '---\nname: differentname\ndescription: ok\n---\n\nbody\n',
      'utf-8',
    )
    await expect(readSkill(home, 'wrongdir')).rejects.toThrow(/does not match directory/)
  })
})

describe('parseSkillContent', () => {
  it('preserves unknown frontmatter fields in extras', () => {
    const text = '---\nname: x\ndescription: y\nauthor: doug\n---\n\nbody\n'
    const s = parseSkillContent(text, 'inline')
    expect(s.extras['author']).toBe('doug')
    expect(s.body).toBe('body')
  })

  it('rejects no-frontmatter content', () => {
    expect(() => parseSkillContent('# just a heading\n', 'inline')).toThrow(/no YAML frontmatter/)
  })
})

describe('skillsHome', () => {
  it('returns <home>/skills', () => {
    expect(skillsHome(home)).toBe(join(home, 'skills'))
  })
})
