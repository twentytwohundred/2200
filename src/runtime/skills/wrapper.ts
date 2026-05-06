/**
 * Skill → Extension synthesis (Epic 11 Phase B).
 *
 * Skills are pure-data (markdown body + frontmatter) and the broader
 * SKILL.md ecosystem does not declare permissions or hooks. To unify
 * install / uninstall / inspection across Skills and full Extensions,
 * we synthesize a minimal ExtensionManifest from a ParsedSkill on
 * demand. The synthesized manifest is in-memory only ... it never
 * writes to `<home>/extensions/`.
 *
 * Where the synthesis is consumed:
 *   - `2200 skill show <name>` (future): print the same shape as
 *     `2200 extension show` for parity.
 *   - AgentLoop selection (the next Phase B sub-PR): when the model
 *     picks `invoke_skill <name>`, the runtime resolves the synthetic
 *     manifest's `tools` against the Agent's permitted tools and
 *     surfaces a "you need to connect X first" error if a declared
 *     tool dependency is missing.
 *   - Conflict detection (also next sub-PR): if a SKILL.md and a real
 *     Extension share a slug, the synthesizer's normalized shape lets
 *     us compare them and raise a clear "rename one" message.
 *
 * The version field is `0.0.0` ... Skill ecosystems do not version
 * SKILL.md files (the format itself is the contract). Future
 * sub-phases that want a real Skill version can lift it from a
 * frontmatter `version` field via `extras`.
 */
import type { ParsedSkill } from './types.js'
import type { ExtensionManifest, ExtensionTool } from '../extensions/types.js'
import { EXTENSION_SCHEMA_VERSION } from '../extensions/types.js'

/** Default semver-shaped placeholder version for synthesized Skill manifests. */
export const SKILL_SYNTHETIC_VERSION = '0.0.0'

export interface SynthesizeOptions {
  /** Override the placeholder version. */
  version?: string
  /** Override the author when the SKILL.md does not carry one. */
  defaultAuthor?: string
}

/**
 * Build an ExtensionManifest-shaped view over a ParsedSkill. Pure
 * function. The result is structurally valid (passes the Zod
 * ExtensionManifestSchema) so downstream callers can hand it to
 * existing Extension-aware code without special-casing.
 */
export function synthesizeSkillManifest(
  skill: ParsedSkill,
  options: SynthesizeOptions = {},
): ExtensionManifest {
  const version = options.version ?? SKILL_SYNTHETIC_VERSION
  const tools: ExtensionTool[] = skill.frontmatter.tools.map((name) => ({
    name,
    description: `Tool dependency declared by Skill ${skill.name}.`,
  }))
  const authorFromExtras = readExtra(skill, 'author')
  const author = authorFromExtras ?? options.defaultAuthor ?? 'unknown'
  const homepage = readExtra(skill, 'homepage')
  return {
    schema_version: EXTENSION_SCHEMA_VERSION,
    name: skill.name,
    version,
    display_name: deriveDisplayName(skill),
    description: skill.frontmatter.description,
    author,
    ...(homepage !== null ? { homepage } : {}),
    permissions: [],
    schedules: [],
    tools,
    hooks: {},
  }
}

function deriveDisplayName(skill: ParsedSkill): string {
  const fromExtras = readExtra(skill, 'display_name')
  if (fromExtras) return fromExtras
  return skill.name
    .split('-')
    .map((part) => (part.length === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ')
}

/**
 * Pull a string-valued extra field from the Skill's pass-through
 * frontmatter. Returns null when missing or not a non-empty string.
 */
function readExtra(skill: ParsedSkill, key: string): string | null {
  const v = skill.extras[key]
  if (typeof v === 'string' && v.length > 0) return v
  return null
}
