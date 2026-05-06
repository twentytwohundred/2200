/**
 * Skill install / uninstall (Epic 11 Phase B).
 *
 * Skills are pure-data: a SKILL.md and any sibling reference files an
 * Agent might consult when the Skill is selected. There are no
 * lifecycle hooks, no permission prompts, and no per-skill state
 * directory at v1. Install is essentially a validating copy; uninstall
 * is a directory remove.
 *
 * The shape mirrors `installExtension` / `uninstallExtension` so the
 * CLI surfaces (`2200 skill install`, `2200 skill uninstall`) feel
 * uniform with the Extension verbs. Future sub-phases will share
 * grants persistence and tool-dependency resolution with full
 * Extensions via the synthesizer in `wrapper.ts`.
 */
import { cp, mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { skillsHome, readSkill } from './registry.js'
import { parseSkillContent, type ParsedSkill } from './types.js'
import type { ResolvedSource } from '../extensions/source.js'
import { readFile } from 'node:fs/promises'

export class SkillInstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillInstallError'
  }
}

export interface SkillInstallArgs {
  home: string
  source: ResolvedSource
  /** Replace an existing install of the same Skill. */
  force?: boolean
}

export interface SkillInstallResult {
  skill: ParsedSkill
  /** Where the SKILL.md was copied to. */
  destRoot: string
}

export interface SkillUninstallArgs {
  home: string
  name: string
  /** Confirm prompt callback. */
  approve: () => Promise<boolean>
  /** Skip the prompt (for forced replace, scripted teardown, tests). */
  skipApprove?: boolean
}

export interface SkillUninstallResult {
  removed: boolean
  aborted: boolean
}

/**
 * Validate the Skill's SKILL.md at the source dir. Throws with a
 * Skill-specific error class so the CLI can render a clean message.
 */
async function validateSourceSkill(source: ResolvedSource): Promise<ParsedSkill> {
  const skillPath = join(source.rootDir, 'SKILL.md')
  let content: string
  try {
    content = await readFile(skillPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SkillInstallError(
        `source has no SKILL.md at ${skillPath}. Skills must declare a SKILL.md at the source root.`,
      )
    }
    throw err
  }
  return parseSkillContent(content, skillPath)
}

async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/**
 * Install a Skill from a resolved source. Validates the SKILL.md,
 * copies the directory contents (including the SKILL.md and any
 * sibling reference files) into `<home>/skills/<name>/`. Throws
 * SkillInstallError or SkillParseError on validation / copy failures
 * with no partial state left behind.
 */
export async function installSkill(args: SkillInstallArgs): Promise<SkillInstallResult> {
  const skill = await validateSourceSkill(args.source)
  const destRoot = join(skillsHome(args.home), skill.name)

  if (await dirExists(destRoot)) {
    if (!args.force) {
      throw new SkillInstallError(
        `Skill "${skill.name}" is already installed at ${destRoot}. ` +
          `Run \`2200 skill uninstall ${skill.name}\` first, or pass --force to replace it.`,
      )
    }
    await rm(destRoot, { recursive: true, force: true })
  }

  await mkdir(skillsHome(args.home), { recursive: true })
  try {
    await cp(args.source.rootDir, destRoot, {
      recursive: true,
      errorOnExist: false,
      dereference: false,
      preserveTimestamps: true,
      filter: (src) => !src.endsWith('/.git'),
    })
  } catch (err) {
    await rm(destRoot, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }

  // Re-read from the canonical location so the result reflects the
  // live install (the source path has been left behind by now).
  const live = await readSkill(args.home, skill.name)
  return { skill: live, destRoot }
}

/**
 * Uninstall a Skill by removing its directory. No hooks, no
 * grants, no scratch ... Skills are pure-data at v1.
 */
export async function uninstallSkill(args: SkillUninstallArgs): Promise<SkillUninstallResult> {
  const destRoot = join(skillsHome(args.home), args.name)
  if (!(await dirExists(destRoot))) {
    return { removed: false, aborted: false }
  }
  if (!args.skipApprove) {
    const ok = await args.approve()
    if (!ok) return { removed: false, aborted: true }
  }
  await rm(destRoot, { recursive: true, force: true })
  return { removed: true, aborted: false }
}

/**
 * Conflict detection helper used by the AgentLoop wiring (next
 * sub-phase) and by `2200 skill list` / `2200 extension list` if we
 * ever want to surface duplicate slugs proactively.
 *
 * Returns the names that are simultaneously a Skill and an Extension.
 * The caller decides how to react ... v1 surfaces a "rename one" hint.
 */
export async function findSkillExtensionConflicts(home: string): Promise<string[]> {
  const { listSkills } = await import('./registry.js')
  const { listExtensions } = await import('../extensions/registry.js')
  const skills = await listSkills(home)
  const extensions = await listExtensions(home)
  const skillNames = new Set(skills.map((s) => s.name))
  const collisions: string[] = []
  for (const e of extensions) {
    if (skillNames.has(e.name)) collisions.push(e.name)
  }
  collisions.sort()
  return collisions
}
