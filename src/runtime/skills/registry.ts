/**
 * Skill registry (Epic 11 Phase A).
 *
 * Read-only scan over <home>/skills/<name>/SKILL.md. Tolerates
 * missing root, dot-prefixed entries, name-vs-dir mismatch, and
 * malformed individual files (one bad SKILL.md does not break the
 * listing).
 *
 * Phase A has no "install" verb. Drop a SKILL.md at the canonical
 * location to register the Skill. Phase B wraps each Skill as a
 * minimal Extension via the Epic 12 framework so install /
 * uninstall / hooks unify.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSkillContent, SkillParseError, type ParsedSkill } from './types.js'

export interface SkillListEntry {
  name: string
  description: string
  tags: string[]
  status: 'ok' | 'invalid'
  /** Free-form error string when status === 'invalid'. */
  reason?: string
}

function skillsRoot(home: string): string {
  return join(home, 'skills')
}

function skillPath(home: string, name: string): string {
  return join(skillsRoot(home), name, 'SKILL.md')
}

/** Read and validate one Skill. Throws on missing file or schema failure. */
export async function readSkill(home: string, name: string): Promise<ParsedSkill> {
  const path = skillPath(home, name)
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SkillParseError(path, 'SKILL.md does not exist')
    }
    throw err
  }
  const parsed = parseSkillContent(content, path)
  if (parsed.name !== name) {
    throw new SkillParseError(
      path,
      `frontmatter name "${parsed.name}" does not match directory "${name}"`,
    )
  }
  return parsed
}

/**
 * List all installed Skills. Tolerates missing root dir + malformed
 * individual files. A bad SKILL.md becomes an `invalid` entry rather
 * than breaking the whole listing.
 */
export async function listSkills(home: string): Promise<SkillListEntry[]> {
  const root = skillsRoot(home)
  let names: string[]
  try {
    names = await readdir(root)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const entries: SkillListEntry[] = []
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue
    const dir = join(root, name)
    let isDir = false
    try {
      isDir = (await stat(dir)).isDirectory()
    } catch {
      continue
    }
    if (!isDir) continue
    try {
      const skill = await readSkill(home, name)
      entries.push({
        name: skill.name,
        description: skill.frontmatter.description,
        tags: skill.frontmatter.tags,
        status: 'ok',
      })
    } catch (err) {
      entries.push({
        name,
        description: '(invalid SKILL.md)',
        tags: [],
        status: 'invalid',
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return entries
}

/** Surface the install root for tests + CLI docstring. */
export function skillsHome(home: string): string {
  return skillsRoot(home)
}
