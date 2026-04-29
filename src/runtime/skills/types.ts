/**
 * Skill manifest types (Epic 11 Phase A).
 *
 * A Skill is a markdown file with optional YAML frontmatter that an
 * Agent invokes when its task matches the Skill's `description`. The
 * format is the broad-ecosystem SKILL.md shape:
 *
 *   ---
 *   name: my-skill
 *   description: When to invoke this skill, in plain prose.
 *   tags: [optional, list, of, tags]
 *   tools: [optional, list, of, tool, names, the, skill, expects]
 *   ---
 *
 *   The body of the markdown file is the instructions the Agent
 *   follows when the Skill is selected.
 *
 * The runtime indexes Skills under <home>/skills/<name>/SKILL.md.
 *
 * Phase A scope: parse + validate the SKILL.md format, list Skills
 * via the CLI, surface them through the existing tool/brain registry
 * conceptually (the actual "select a Skill" routing inside the
 * AgentLoop lands in Phase B once tool calls can dispatch to a Skill
 * by name).
 *
 * Phase B (deferred): wrap each parsed Skill as a minimal Extension
 * in the Epic 12 framework so install / uninstall / lifecycle hooks
 * apply uniformly.
 */
import { z } from 'zod'
import * as YAML from 'yaml'

export const SKILL_SCHEMA_VERSION = 1 as const

/**
 * Frontmatter shape. The broader ecosystem uses a loose convention
 * (some files have just `name` + `description`, others have richer
 * fields). Phase A admits a permissive subset and preserves
 * unknown fields in `extras` for round-trip.
 */
export const SkillFrontmatterSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, {
    message:
      'name must be a slug starting with a lowercase letter; lowercase + digits + dashes only',
  }),
  description: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]),
  tools: z.array(z.string().min(1)).default([]),
})
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>

export interface ParsedSkill {
  /** Slug from the frontmatter (matches the dir name). */
  name: string
  /** Absolute path to the SKILL.md file. */
  path: string
  /** Parsed frontmatter. */
  frontmatter: SkillFrontmatter
  /** Pass-through frontmatter fields beyond the canonical schema. */
  extras: Record<string, unknown>
  /** The instructions body (markdown after the frontmatter). */
  body: string
}

export class SkillParseError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`Skill at ${path}: ${message}`)
    this.name = 'SkillParseError'
  }
}

const FRONTMATTER_RE = /^---\n([\s\S]+?)\n---\n?([\s\S]*)$/

/**
 * Parse a SKILL.md file's contents. Throws SkillParseError on
 * missing/invalid frontmatter or schema failure.
 */
export function parseSkillContent(content: string, path: string): ParsedSkill {
  const m = FRONTMATTER_RE.exec(content)
  if (!m?.[1]) {
    throw new SkillParseError(path, 'no YAML frontmatter; expected --- block at the top')
  }
  const yamlText = m[1]
  const body = m[2] ?? ''
  let raw: unknown
  try {
    raw = (YAML.parse(yamlText) as unknown) ?? {}
  } catch (err) {
    throw new SkillParseError(
      path,
      `invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!raw || typeof raw !== 'object') {
    throw new SkillParseError(path, 'frontmatter must parse to an object')
  }
  const result = SkillFrontmatterSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new SkillParseError(path, `\n${issues}`)
  }
  const fm = result.data
  const extras: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(k in fm)) extras[k] = v
  }
  return {
    name: fm.name,
    path,
    frontmatter: fm,
    extras,
    body: body.trim(),
  }
}
