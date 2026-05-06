/**
 * Skill provider for the AgentLoop (Epic 11 Phase B-2).
 *
 * The provider is the seam between the AgentLoop and the on-disk
 * Skill registry. The loop asks the provider:
 *
 *   - `list()` ... what skills exist (name + description)? The loop
 *     surfaces them in the system prompt so the model knows what
 *     it can `skill.invoke`.
 *   - `resolve(name)` ... when the model picks a skill, return its
 *     body + declared tool dependencies. The loop validates the
 *     dependencies against `availableToolNames` BEFORE returning the
 *     body to the model, so a Skill that needs a tool the Agent does
 *     not have surfaces a clear error rather than silently failing
 *     mid-execution.
 *   - `conflicts()` ... slugs that exist as both a Skill AND an
 *     Extension. The loop surfaces these in the system prompt so the
 *     model knows the name is ambiguous and can route around it.
 *
 * The default implementation reads from `<home>/skills/<name>/SKILL.md`
 * and `<home>/extensions/<name>/manifest.json`. Tests inject an
 * in-memory provider via the same shape.
 */
import { listSkills, readSkill } from './registry.js'
import { findSkillExtensionConflicts } from './install.js'

export interface SkillSummary {
  name: string
  description: string
}

export interface SkillInvocation {
  name: string
  body: string
  toolDependencies: readonly string[]
}

export interface SkillProvider {
  /** Skills that should appear in the system prompt as invocable. */
  list(): Promise<SkillSummary[]>
  /**
   * Resolve a skill by name. Returns null when the skill is not
   * installed (or has an invalid SKILL.md). The AgentLoop converts a
   * null into a clear error message back to the model.
   */
  resolve(name: string): Promise<SkillInvocation | null>
  /**
   * Slugs that exist as both a Skill and an Extension. The AgentLoop
   * notes these in the system prompt; resolve() does not branch on
   * them ... the model sees the ambiguity and decides what to do.
   */
  conflicts(): Promise<readonly string[]>
}

/**
 * Default provider: reads from `<home>/skills/` and
 * `<home>/extensions/`. Each call is a disk read; the AgentLoop calls
 * `list()` + `conflicts()` once at startup (system prompt build) and
 * `resolve()` only when the model invokes a skill. Re-reads on every
 * resolve so a freshly-installed skill is invocable without an Agent
 * restart.
 */
export class FilesystemSkillProvider implements SkillProvider {
  constructor(private readonly home: string) {}

  async list(): Promise<SkillSummary[]> {
    const items = await listSkills(this.home)
    return items
      .filter((e) => e.status === 'ok')
      .map((e) => ({ name: e.name, description: e.description }))
  }

  async resolve(name: string): Promise<SkillInvocation | null> {
    try {
      const skill = await readSkill(this.home, name)
      return {
        name: skill.name,
        body: skill.body,
        toolDependencies: skill.frontmatter.tools,
      }
    } catch {
      return null
    }
  }

  async conflicts(): Promise<readonly string[]> {
    return await findSkillExtensionConflicts(this.home)
  }
}
