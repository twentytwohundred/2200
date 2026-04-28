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
  /**
   * Optional secondary model. When set, the AgentLoop uses
   * `model_id` for iteration 1 of a task (cheap initial assessment)
   * and switches to `followup_model_id` for iterations 2 and beyond
   * (deeper reasoning, tool-call follow-ups). Same provider; the
   * provider client is reused. Set to a reasoner-class model when
   * the primary is a chat-class model... e.g.
   *   model_id: deepseek-chat
   *   followup_model_id: deepseek-reasoner
   * If unset, all iterations use `model_id`.
   */
  followup_model_id: ModelIdComponentSchema.optional(),
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
 * Default cost cap applied to Identity files that lack a `cost_caps`
 * block. Conservative by design... at current Hobby cadence
 * (single-digit dollars per working day) this gives a real ceiling
 * without being trivially blown through. Users adjust per-Agent.
 */
export const DEFAULT_DAILY_USD_CAP = 10

/**
 * Default for every cost_caps field. Single source of truth so the
 * field-level Zod defaults and the outer object-level Zod default
 * stay in sync.
 */
const COST_CAPS_DEFAULT = {
  daily_usd: DEFAULT_DAILY_USD_CAP,
  warn_at_pct: 80,
  reset_at: '00:00 UTC',
  on_breach: 'block_new_tasks',
} as const

/**
 * Per-Agent cost-cap configuration. Read by the supervisor's BudgetTracker
 * (Epic 4.5). `daily_usd` is the only field a user must set; everything
 * else has a sensible default.
 *
 * Identity files written before Epic 4.5 land without a `cost_caps`
 * block; the loader injects this default via the Zod schema. The
 * `1-to-2` migrator handles the `schema_version` bump.
 */
export const CostCapsSchema = z.object({
  /** Hard ceiling, USD per day. New tasks blocked once cumulative spend reaches this. */
  daily_usd: z.number().positive(),
  /** Soft warning threshold, integer percent in [1, 99]. Tier-2 notification fires at first crossing. */
  warn_at_pct: z.number().int().min(1).max(99).default(COST_CAPS_DEFAULT.warn_at_pct),
  /**
   * Daily reset time. Free-form string at v1; the BudgetTracker accepts
   * "HH:MM TZ" forms ("00:00 UTC", "00:00 America/New_York"). UTC default
   * because the supervisor's clock is UTC and the test rig is timezone-
   * agnostic.
   */
  reset_at: z.string().default(COST_CAPS_DEFAULT.reset_at),
  /**
   * Behavior when the daily cap is reached. v1 supports only
   * `block_new_tasks`; the enum is reserved for `throttle` and
   * `downgrade-tier` modes that may land in future epics.
   */
  on_breach: z.enum(['block_new_tasks']).default(COST_CAPS_DEFAULT.on_breach),
})
export type CostCaps = z.infer<typeof CostCapsSchema>

/**
 * The Identity frontmatter schema.
 *
 * - `schema_version: 3` per the locked integer convention.
 *   v2 (Epic 4.5) added `cost_caps`. v3 (Epic 4 Phase A) added the
 *   optional `scut` block. The migrator chain bumps older files.
 * - `tools: []` is the default; entries are ADDITIONS to the baseline
 *   tool set (NOT the full set). The runtime composes baseline + this
 *   array at boot.
 * - `cost_caps.daily_usd` is the per-Agent daily spend ceiling; missing
 *   blocks default to $10/day per `DEFAULT_DAILY_USD_CAP`.
 * - `scut` is optional; filled in by the identity-provisioning pipeline.
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

/**
 * Agent's SCUT identity block (Epic 4 Phase A). Filled in by the
 * supervisor's identity-provisioning pipeline after the on-chain
 * mint+update completes. Identity files written before Phase A land
 * without this block; the runtime treats an Agent without a `scut`
 * block as "not yet SCUT-provisioned" and skips identity-dependent
 * code paths (resolver lookups, future cross-instance messaging).
 *
 * Private keys are NOT in this block. They live encrypted at
 * `<home>/state/identities/<agent_name>/keys/` and are loaded by
 * the supervisor on Agent start, never persisted to the Identity
 * file in plaintext.
 *
 * `chain_id: 8453` and `contract: 0x199b48...` are the locked Base
 * mainnet values per the Phase A spec (v0.3). v1 supports a single
 * canonical contract per instance.
 */
export const ScutIdentityBlockSchema = z.object({
  /**
   * Full SCUT URI: `scut://<chainId>/<contract>/<tokenId>`. Canonical
   * agent address. Used as the `from` field on outbound SCUT messages
   * and as the lookup key into the resolver cache.
   */
  uri: z.string().regex(/^scut:\/\/\d+\/0x[a-fA-F0-9]{40}\/\d+$/, {
    message: 'scut.uri must match scut://<chainId>/<contract>/<tokenId>',
  }),
  /** Numeric chain id (8453 for Base mainnet at v1). */
  chain_id: z.number().int().positive(),
  /** SII contract address, 0x-prefixed hex. */
  contract: z.string().regex(/^0x[a-fA-F0-9]{40}$/, {
    message: 'scut.contract must be a 0x-prefixed 40-hex-char address',
  }),
  /** Minted tokenId. Stored as a string to dodge JS number-precision issues. */
  token_id: z.string().regex(/^\d+$/, {
    message: 'scut.token_id must be a non-negative decimal integer string',
  }),
  /**
   * On-chain identity URI. v1 always a `data:application/json;base64,...`
   * URI carrying the full SII document inline. The runtime accepts
   * other schemes (`ipfs://`, `https://`) for future flexibility.
   */
  identity_doc_uri: z.string().min(1),
  /** Public keys derived from the private keys persisted under state/. */
  public_keys: z.object({
    /** Base64-encoded 32-byte Ed25519 public key (signing). */
    ed25519: z.string().min(1),
    /** Base64-encoded 32-byte X25519 public key (encryption). */
    x25519: z.string().min(1),
  }),
  /** ISO timestamp when provisioning completed (TX2 confirmed). */
  registered_at: z.string().min(1),
  /** Mint transaction hash (TX1). */
  mint_tx: z.string().regex(/^0x[a-fA-F0-9]{64}$/, {
    message: 'scut.mint_tx must be a 0x-prefixed 64-hex-char tx hash',
  }),
  /** updateIdentityURI transaction hash (TX2). */
  update_tx: z.string().regex(/^0x[a-fA-F0-9]{64}$/, {
    message: 'scut.update_tx must be a 0x-prefixed 64-hex-char tx hash',
  }),
})
export type ScutIdentityBlock = z.infer<typeof ScutIdentityBlockSchema>

export const IdentityFrontmatterSchema = z.object({
  schema_version: z.literal(3),
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
  cost_caps: CostCapsSchema.default(COST_CAPS_DEFAULT),
  /**
   * SCUT identity block (Epic 4 Phase A). Optional: filled in after
   * the supervisor's provisioning pipeline mints + updates the
   * on-chain tokenId. Identity files created before Phase A land
   * without it; the runtime treats them as "not yet SCUT-provisioned."
   */
  scut: ScutIdentityBlockSchema.optional(),
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
