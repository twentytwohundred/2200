import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FilesystemSkillProvider } from '../../../src/runtime/skills/provider.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-skill-provider-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

async function dropSkill(name: string, body: string, frontmatter: string): Promise<void> {
  const dir = join(home, 'skills', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\n${frontmatter}---\n${body}`, 'utf8')
}

async function dropExtension(name: string): Promise<void> {
  const dir = join(home, 'extensions', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      schema_version: 1,
      name,
      version: '0.1.0',
      display_name: name,
      description: 'Test extension',
      author: 'T',
    }),
    'utf8',
  )
}

describe('FilesystemSkillProvider.list', () => {
  it('returns ok-status skills only', async () => {
    await dropSkill('alpha', 'Body', `name: alpha\ndescription: Alpha skill\n`)
    await dropSkill('beta', 'Body', `name: beta\ndescription: Beta skill\n`)
    // Drop a malformed third skill (frontmatter name mismatch) — should
    // be filtered out.
    await dropSkill('gamma', 'Body', `name: not-gamma\ndescription: Bad\n`)

    const provider = new FilesystemSkillProvider(home)
    const list = await provider.list()
    expect(list.map((s) => s.name).sort()).toEqual(['alpha', 'beta'])
    expect(list.find((s) => s.name === 'alpha')?.description).toBe('Alpha skill')
  })

  it('returns [] when no skills are installed', async () => {
    const provider = new FilesystemSkillProvider(home)
    expect(await provider.list()).toEqual([])
  })
})

describe('FilesystemSkillProvider.resolve', () => {
  it('returns the parsed body + tool dependencies', async () => {
    await dropSkill(
      'finance',
      'Track Mercury + Chase nightly.\nWalk through the steps.\n',
      `name: finance\ndescription: nightly finance check\ntools: [fs_read, web_fetch]\n`,
    )
    const provider = new FilesystemSkillProvider(home)
    const r = await provider.resolve('finance')
    expect(r).not.toBeNull()
    expect(r?.body).toContain('Track Mercury + Chase nightly')
    expect(r?.toolDependencies).toEqual(['fs_read', 'web_fetch'])
  })

  it('returns null for missing skill', async () => {
    const provider = new FilesystemSkillProvider(home)
    expect(await provider.resolve('nope')).toBeNull()
  })

  it('returns null for malformed skill (does not throw)', async () => {
    await dropSkill('broken', 'Body', `name: not-broken\ndescription: bad\n`)
    const provider = new FilesystemSkillProvider(home)
    expect(await provider.resolve('broken')).toBeNull()
  })
})

describe('FilesystemSkillProvider.conflicts', () => {
  it('returns slugs that exist as both Skill and Extension', async () => {
    await dropSkill('shared', 'Body', `name: shared\ndescription: skill side\n`)
    await dropExtension('shared')
    await dropSkill('only-skill', 'Body', `name: only-skill\ndescription: alone\n`)
    await dropExtension('only-ext')
    const provider = new FilesystemSkillProvider(home)
    expect(await provider.conflicts()).toEqual(['shared'])
  })

  it('returns [] when no conflicts', async () => {
    await dropSkill('only', 'Body', `name: only\ndescription: alone\n`)
    const provider = new FilesystemSkillProvider(home)
    expect(await provider.conflicts()).toEqual([])
  })
})
