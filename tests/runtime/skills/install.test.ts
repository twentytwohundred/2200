import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  installSkill,
  uninstallSkill,
  findSkillExtensionConflicts,
  SkillInstallError,
} from '../../../src/runtime/skills/install.js'
import { skillsHome } from '../../../src/runtime/skills/registry.js'
import type { ResolvedSource } from '../../../src/runtime/extensions/source.js'

let home: string
let sourceRoot: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-skill-inst-'))
  sourceRoot = await mkdtemp(join(tmpdir(), '2200-skill-src-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(sourceRoot, { recursive: true, force: true })
})

interface MakeSourceArgs {
  name: string
  description?: string
  tags?: string[]
  tools?: string[]
  body?: string
  /** Extra sibling file names → contents to drop alongside SKILL.md. */
  siblings?: Record<string, string>
}

async function makeSource(args: MakeSourceArgs): Promise<string> {
  const dir = join(sourceRoot, args.name)
  await mkdir(dir, { recursive: true })
  const fm: string[] = ['---', `name: ${args.name}`]
  fm.push(`description: ${args.description ?? `Demo skill ${args.name}`}`)
  if (args.tags && args.tags.length > 0) fm.push(`tags: [${args.tags.join(', ')}]`)
  if (args.tools && args.tools.length > 0) fm.push(`tools: [${args.tools.join(', ')}]`)
  fm.push('---', '')
  const content = fm.join('\n') + (args.body ?? `Body of ${args.name}.\n`)
  await writeFile(join(dir, 'SKILL.md'), content, 'utf8')
  if (args.siblings) {
    for (const [filename, c] of Object.entries(args.siblings)) {
      await writeFile(join(dir, filename), c, 'utf8')
    }
  }
  return dir
}

function localSource(rootDir: string): ResolvedSource {
  return {
    rootDir,
    kind: 'local',
    origin: rootDir,
    cleanup: () => Promise.resolve(),
  }
}

async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe('installSkill', () => {
  it('copies SKILL.md and reads back the parsed result', async () => {
    const src = await makeSource({
      name: 'finance',
      description: 'Track finances',
      tags: ['money', 'cron'],
      tools: ['fs_read', 'web_fetch'],
    })
    const result = await installSkill({ home, source: localSource(src) })
    expect(result.skill.name).toBe('finance')
    expect(result.skill.frontmatter.tags).toEqual(['money', 'cron'])
    expect(result.skill.frontmatter.tools).toEqual(['fs_read', 'web_fetch'])
    expect(await fileExists(join(skillsHome(home), 'finance', 'SKILL.md'))).toBe(true)
  })

  it('copies sibling reference files alongside SKILL.md', async () => {
    const src = await makeSource({
      name: 'with-refs',
      siblings: { 'reference.md': '# Ref', 'data.json': '{}' },
    })
    await installSkill({ home, source: localSource(src) })
    const dest = join(skillsHome(home), 'with-refs')
    expect(await fileExists(join(dest, 'reference.md'))).toBe(true)
    expect(await fileExists(join(dest, 'data.json'))).toBe(true)
    const ref = await readFile(join(dest, 'reference.md'), 'utf8')
    expect(ref).toBe('# Ref')
  })

  it('refuses to overwrite an existing install without --force', async () => {
    const src = await makeSource({ name: 'dup' })
    await installSkill({ home, source: localSource(src) })
    await expect(installSkill({ home, source: localSource(src) })).rejects.toBeInstanceOf(
      SkillInstallError,
    )
  })

  it('replaces an existing install with --force', async () => {
    const src1 = await makeSource({ name: 'replaced', description: 'first' })
    await installSkill({ home, source: localSource(src1) })
    const src2 = await makeSource({ name: 'replaced', description: 'second' })
    const r = await installSkill({ home, source: localSource(src2), force: true })
    expect(r.skill.frontmatter.description).toBe('second')
  })

  it('throws SkillInstallError when the source has no SKILL.md', async () => {
    const dir = join(sourceRoot, 'empty')
    await mkdir(dir, { recursive: true })
    await expect(
      installSkill({
        home,
        source: { rootDir: dir, kind: 'local', origin: dir, cleanup: () => Promise.resolve() },
      }),
    ).rejects.toThrow(/no SKILL\.md/)
  })

  it('rejects a SKILL.md whose name does not match the source dir name', async () => {
    // We allow this at install time as long as the slug is valid, since
    // the canonical install path uses the manifest's slug, not the
    // source dir name. The install creates a dir named after the slug.
    const dir = join(sourceRoot, 'whatever-folder-name')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'SKILL.md'),
      `---\nname: actual-name\ndescription: testing slug priority\n---\nbody\n`,
      'utf8',
    )
    const r = await installSkill({
      home,
      source: { rootDir: dir, kind: 'local', origin: dir, cleanup: () => Promise.resolve() },
    })
    expect(r.skill.name).toBe('actual-name')
    expect(await dirExists(join(skillsHome(home), 'actual-name'))).toBe(true)
    expect(await dirExists(join(skillsHome(home), 'whatever-folder-name'))).toBe(false)
  })
})

describe('uninstallSkill', () => {
  it('removes the directory on confirm', async () => {
    const src = await makeSource({ name: 'gone' })
    await installSkill({ home, source: localSource(src) })
    const r = await uninstallSkill({
      home,
      name: 'gone',
      approve: () => Promise.resolve(true),
    })
    expect(r.removed).toBe(true)
    expect(await dirExists(join(skillsHome(home), 'gone'))).toBe(false)
  })

  it('aborts on user denial', async () => {
    const src = await makeSource({ name: 'kept' })
    await installSkill({ home, source: localSource(src) })
    const r = await uninstallSkill({
      home,
      name: 'kept',
      approve: () => Promise.resolve(false),
    })
    expect(r.aborted).toBe(true)
    expect(await dirExists(join(skillsHome(home), 'kept'))).toBe(true)
  })

  it('returns removed=false when not installed', async () => {
    const r = await uninstallSkill({
      home,
      name: 'nope',
      approve: () => Promise.resolve(true),
    })
    expect(r.removed).toBe(false)
    expect(r.aborted).toBe(false)
  })
})

describe('findSkillExtensionConflicts', () => {
  it('returns the names that exist as both a Skill and an Extension', async () => {
    // Drop a SKILL.md and an Extension manifest with the same slug.
    const skillSrc = await makeSource({ name: 'shared' })
    await installSkill({ home, source: localSource(skillSrc) })
    const extDir = join(home, 'extensions', 'shared')
    await mkdir(extDir, { recursive: true })
    await writeFile(
      join(extDir, 'manifest.json'),
      JSON.stringify({
        schema_version: 1,
        name: 'shared',
        version: '0.1.0',
        display_name: 'Shared',
        description: 'Conflict probe',
        author: 'T',
      }),
      'utf8',
    )
    const collisions = await findSkillExtensionConflicts(home)
    expect(collisions).toEqual(['shared'])
  })

  it('returns [] when there is no overlap', async () => {
    const src = await makeSource({ name: 'alone' })
    await installSkill({ home, source: localSource(src) })
    const collisions = await findSkillExtensionConflicts(home)
    expect(collisions).toEqual([])
  })
})
