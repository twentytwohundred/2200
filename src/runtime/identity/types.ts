/**
 * Identity types and schema.
 *
 * An Identity is a markdown file with YAML frontmatter that defines an
 * Agent. The frontmatter shape is locked here (Zod) per the Epic 2 spec
 * and the conventions:
 *
 *  - schema_version is integer per [[2026-04-26-schema-version-format]]
 *  - tools is additive over the baseline (empty -> baseline only)
 *  - model.provider + model.model_id are separate fields; the runtime
 *    composes <provider>/<model_id> when emitting plan records per
 *    [[2026-04-26-model-field-format]]
 *
 * The body of the file (after the closing `---`) is the Agent's persona,
 * lane, and rules of engagement. Free-form markdown. Carried as `body`
 * so the runtime can pass it to the LLM as the system prompt.
 */
import { z } from 'zod'

export const ModelTierSchema = z.enum(['frontier', 'fast', 'economy', 'specialist'])
export type ModelTier = z.infer<typeof ModelTierSchema>

/**
 * Provider portion of the model identifier. Lowercase alphanumeric, no
 * hyphens or other separators; matches the regex used by `ModelIdSchema`
 * in `src/runtime/control-plane/protocol.ts`.
 */
export const ModelProviderSchema = z.string().regex(/^[a-z0-9]+$/, {
  message: 'model.provider must be lowercase alphanumeric (no separators)',
})

/**
 * model_id portion of the model identifier. Lowercase alphanumeric or
 * dashes; whatever the provider calls the model, normalized.
 */
export const ModelIdComponentSchema = z.string().regex(/^[a-z0-9-]+$/, {
  message: 'model.model_id must be lowercase alphanumeric or dashes',
})

export const ModelBindingSchema = z.object({
  tier: ModelTierSchema,
  provider: ModelProviderSchema,
  model_id: ModelIdComponentSchema,
})
export type ModelBinding = z.infer<typeof ModelBindingSchema>

/**
 * Tool name in an Identity's `tools:` array. The runtime resolves each
 * to either a baseline tool (per [[2026-04-25-tool-baseline]]) or an
 * MCP server registered separately. v1 enforces only that the name has
 * a `<namespace>.<verb>` shape; whether the name resolves is a runtime
 * concern.
 */
export const ToolNameSchema = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, {
  message: 'tool name must be <namespace>.<verb>, lowercase with underscores',
})

/**
 * The Identity frontmatter schema.
 *
 * - `schema_version: 1` per the locked integer convention.
 * - `tools: []` is the default; entries are ADDITIONS to the baseline
 *   tool set (NOT the full set). The runtime composes baseline + this
 *   array at boot.
 * - `provider_secret` is an optional SecretRef pointer for the LLM
 *   provider's credential. v1 supports `env` (read from process env)
 *   and `file` (read from file). Future: `exec` (shell out to a helper).
 */
export const IdentityFrontmatterSchema = z.object({
  schema_version: z.literal(1),
  agent_name: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9_-]*$/, {
      message:
        'agent_name must start with a lowercase letter; lowercase letters, digits, underscores, and dashes only',
    }),
  agent_role: z.string().min(1),
  model: ModelBindingSchema,
  tools: z.array(ToolNameSchema).default([]),
  project_dir: z.string().min(1),
  brain_dir: z.string().min(1),
  created: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'created must be a date in YYYY-MM-DD form',
  }),
  provider_secret: z
    .object({
      source: z.enum(['env', 'file']),
      id: z.string().min(1),
    })
    .optional(),
})
export type IdentityFrontmatter = z.infer<typeof IdentityFrontmatterSchema>

/**
 * The fully-loaded Identity record. Frontmatter plus the markdown body
 * (the Agent's persona text). The body is preserved verbatim so the
 * runtime can pass it to the LLM as a system prompt or persona block.
 */
export interface IdentityRecord {
  readonly frontmatter: IdentityFrontmatter
  readonly body: string
  /** Absolute path the Identity was loaded from. Useful for error messages. */
  readonly source_path: string
}

/**
 * Compose the model identifier from a binding's provider + model_id per
 * [[2026-04-26-model-field-format]]. The `<provider>/<model_id>` form is
 * what plan records carry.
 */
export function composeModelId(binding: ModelBinding): string {
  return `${binding.provider}/${binding.model_id}`
}
