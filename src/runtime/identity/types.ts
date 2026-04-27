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
/**
 * Agent's pub identity block. Mirrors the user's pub block shape
 * with two Agent-specific fields: `domains` (for the directed_to
 * resolver's domain-match rule) and `member_of` (which pubs this
 * Agent connects to on boot; defaults to "the single pub on the
 * instance" when empty/absent at v1).
 *
 * Defined as a function returning the schema so the schema literal
 * is constructed lazily; this dodges a TDZ issue when both this
 * file and the user types file are loaded together.
 */
function AgentPubBlockSchemaForIdentity() {
  return z.object({
    /** UUID v7 from OpenPub. Empty string before first registration. */
    identity: z.string(),
    display_name: z.string().min(1),
    handle: z.string().min(1),
    credentials: z.object({
      source: z.literal('file'),
      id: z.string().min(1),
    }),
    key_version: z.number().int().positive().default(1),
    /**
     * `local://<host>:<port>` for LOCAL_TRUST or the hub URL for
     * HUB mode. Empty string is allowed and means "not yet
     * provisioned" — the supervisor's `createAgent` extension fills
     * this in when the Identity is first registered with a pub.
     */
    issuer_url: z.string(),
    /**
     * Optional domain rules for the directed_to resolver's rule 5
     * per Epic 3 [[03-local-pub-integration]]. Free-form strings;
     * the resolver matches against message content.
     */
    domains: z.array(z.string()).default([]),
    /**
     * Pubs this Agent connects to on boot. Empty/absent means "the
     * single pub on this instance" (v1 typical install). Multi-pub
     * connections list each pub by name.
     */
    member_of: z.array(z.string()).default([]),
  })
}

/** Re-export the resolved Agent pub block type so consumers (loader, supervisor) can import it directly. */
export type AgentPubBlock = z.infer<ReturnType<typeof AgentPubBlockSchemaForIdentity>>

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
  /**
   * Pub identity block (Epic 3 PR B). Optional: Identity files
   * created before Epic 3 land without it. The runtime treats an
   * Agent without a `pub:` block as "not pub-aware" and skips
   * the pub auto-connect. `2200 agent create` will write this
   * block when minting a new Agent on an Epic-3-aware install.
   */
  pub: AgentPubBlockSchemaForIdentity().optional(),
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
