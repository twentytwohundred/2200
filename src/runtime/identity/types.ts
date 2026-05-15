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
import { SecretRefSchema } from '../secrets/types.js'

export const ModelTierSchema = z.enum(['frontier', 'fast', 'economy', 'specialist'])
export type ModelTier = z.infer<typeof ModelTierSchema>

/**
 * Provider portion of the model identifier. Lowercase alphanumeric, no
 * hyphens or other separators; matches the regex used by `ModelIdSchema`
 * in `src/runtime/control-plane/protocol.ts`.
 */
/**
 * Built-in providers are lowercase alphanumeric (`anthropic`,
 * `deepseek`, `xai`). Custom endpoints registered by the operator use
 * the `endpoint:<slug>` form (`endpoint:dgx-spark`, `endpoint:lab-vm`)
 * so the LLM registry can dispatch to the matching `<home>/config/
 * endpoints.json` entry. The slug after the colon follows the
 * `EndpointIdSchema` rule: lowercase alphanumeric + dashes, starting
 * with a letter or digit.
 */
export const ModelProviderSchema = z.string().regex(/^[a-z0-9]+(:[a-z0-9][a-z0-9-]{0,49})?$/, {
  message:
    'model.provider must be lowercase alphanumeric (e.g. "anthropic") or "endpoint:<slug>" for a custom endpoint',
})

/**
 * model_id portion of the model identifier. Lowercase alphanumeric,
 * dashes, or dots; whatever the provider calls the model. Dots are
 * permitted because real-world model ids contain them
 * (`gemini-2.5-pro`, `grok-4.3`); the runtime passes this string
 * verbatim to the provider's chat-completions endpoint.
 */
export const ModelIdComponentSchema = z.string().regex(/^[a-z0-9.-]+$/, {
  message: 'model.model_id must be lowercase alphanumeric, dashes, or dots',
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
 * MCP server registered via the `mcp_servers` block. Two shapes:
 *
 *   - **Exact name**: `<namespace>.<verb>` ... lowercase, underscores
 *     allowed in either part (`shell_run`, `github.list_issues`). The
 *     registry resolves to the named tool.
 *   - **Namespace wildcard**: `<namespace>.*` ... grants every tool in
 *     the namespace. Per the Epic 9 Phase A locked decision (2026-04-29),
 *     wildcards exist for ergonomics: external MCP servers like the
 *     GitHub server expose dozens of tools; listing each by name is
 *     verbose. Both shapes coexist in a single `tools:` array; an
 *     Identity can mix `github.*` with explicit `slack.send`.
 *
 * v5 schema (Epic 9 Phase A) accepts both shapes. v4 files that used
 * only exact names continue to validate cleanly under v5 since the
 * wildcard form is purely additive.
 */
// Tool names use a single separator between namespace and verb. As of
// session 13 (2026-05-08) the canonical form is underscored
// (`shell_run`, `github_search`); the dotted legacy form (`shell.run`,
// `github.search`) is still accepted for older Identity files that
// haven't been migrated. Either separator parses; the dispatcher's
// tolerant resolver translates between them at lookup time.
export const ToolNameSchema = z.string().regex(/^[a-z][a-z0-9_]*[._]([a-z][a-z0-9_]*|\*)$/, {
  message:
    'tool name must be <namespace>_<verb> (e.g., shell_run) or <namespace>_* (e.g., github_*); lowercase with underscores. Legacy dotted form still accepted.',
})

/**
 * Default cost cap applied to Identity files that lack a `cost_caps`
 * block. Sized for the 2026-05-12 "production Agents always run on
 * frontier models" rule: a normal working day on grok-4.3 or
 * deepseek-reasoner stays well under this, but a runaway loop (model
 * spinning on a broken tool, ambient-router cascade, etc.) gets caught
 * before it does real damage. Operators adjust per-Agent as needed.
 *
 * History: was $10 when defaults assumed cheap-tier; bumped to $50
 * after the frontier-model directive landed.
 */
export const DEFAULT_DAILY_USD_CAP = 50

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
 * - `schema_version: 5` per the locked integer convention.
 *   v2 (Epic 4.5) added `cost_caps`. v3 (Epic 4 Phase A) added the
 *   optional `scut` block. v4 (Epic 7) added `notification_policy`.
 *   v5 (Epic 9 Phase A) added `mcp_servers`. The migrator chain
 *   bumps older files.
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

/**
 * Notification tier (Epic 7). Controls which surfaces an outbound
 * notification can interrupt:
 *
 *   - `passive`:   badge / digest only. The dot pulse turns yellow.
 *                  Default home for cost-velocity warnings, low-stakes
 *                  status updates, model-availability nudges.
 *   - `normal`:    standard push. "I finished a task," "I have a
 *                  draft for you to look at." User expected to
 *                  respond within hours.
 *   - `important`: breaks through silencing but not Do-Not-Disturb.
 *                  "I'm blocked and need an answer to proceed,"
 *                  "approaching daily cost cap."
 *   - `critical`:  breaks through DND, rings like a phone call.
 *                  Reserved for 2FA handoff, irreversible-action
 *                  confirmation, explicit emergencies. Triggered
 *                  ONLY by named action types in the supervisor's
 *                  policy code, never by an Agent's own judgment.
 */
export const NotificationTierSchema = z.enum(['passive', 'normal', 'important', 'critical'])
export type NotificationTier = z.infer<typeof NotificationTierSchema>

/**
 * Per-Agent notification policy (Epic 7). The `tiers_allowed` list
 * defines which tiers an Agent's notifications can use; tiers
 * outside this list are clamped down or dropped at the write layer.
 *
 * The default omits `critical` deliberately. Per CLAUDE.md "Notification
 * tier gating": Agents cannot escalate their own priority. The tier
 * comes from the action type, not the Agent's judgment. To allow
 * critical-tier from a specific Agent, the user explicitly opts in
 * by adding `critical` to that Agent's tiers_allowed.
 */
export const NotificationPolicySchema = z.object({
  /** Tiers this Agent's notifications are allowed to use. */
  tiers_allowed: z.array(NotificationTierSchema).default(['passive', 'normal', 'important']),
})
export type NotificationPolicy = z.infer<typeof NotificationPolicySchema>

const NOTIFICATION_POLICY_DEFAULT: NotificationPolicy = {
  tiers_allowed: ['passive', 'normal', 'important'],
}

/**
 * MCP server spec (Epic 9 Phase A; HTTP variant added in Phase C).
 * Declares an external MCP server the supervisor wires up alongside
 * the Agent process. The server's tools become available to the
 * Agent if the Agent's `tools:` array grants access (by exact name
 * or `<namespace>.*` wildcard).
 *
 * Two transports:
 *
 * **stdio** ... the supervisor spawns the named `command` with `args`
 * and the resolved `env`, then talks MCP JSON-RPC over the child's
 * stdin/stdout. Best for community npx-based servers (`@modelcontextprotocol/server-github`)
 * and locally-installed binaries.
 *
 * **http** ... the supervisor opens a Streamable HTTP MCP connection
 * to `url`. Best for hosted commercial MCP services. Optional bearer
 * auth via `auth.token` (SecretRef). Static headers via `headers`.
 *
 * `name` is the registry namespace for both transports ... if `name:
 * github`, the server's tools dispatch as `github.<verb>`. Names must
 * be unique within an Identity; the loader rejects duplicates.
 *
 * SecretRefs (in stdio `env` and HTTP `auth.token`) are resolved at
 * spawn time by the supervisor. Resolved values never appear in
 * logs.
 */
const McpServerSpecBaseSchema = z.object({
  /** Registry namespace; tools dispatch as `<name>.<verb>`. Lowercase, alphanumeric + underscores. */
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, {
    message:
      'mcp_servers[].name must start with a lowercase letter; lowercase letters, digits, and underscores only',
  }),
})

const McpServerSpecStdioSchema = McpServerSpecBaseSchema.extend({
  transport: z.literal('stdio'),
  /** Executable to spawn (e.g. `npx`, `node`, an absolute path to a binary). */
  command: z.string().min(1),
  /** Arguments passed to the command. Empty array allowed. */
  args: z.array(z.string()).default([]),
  /**
   * Environment variables to set on the spawned child. Map of
   * env-var-name → SecretRef. The supervisor resolves SecretRefs at
   * spawn time. The resolved values are passed to the child and never
   * logged.
   */
  env: z.record(z.string().min(1), SecretRefSchema).default({}),
})

const McpHttpAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({
    type: z.literal('bearer'),
    /** SecretRef resolving to a bearer token (typically a vault entry from `2200 oauth login`). */
    token: SecretRefSchema,
  }),
])

const McpServerSpecHttpSchema = McpServerSpecBaseSchema.extend({
  transport: z.literal('http'),
  /** MCP HTTP endpoint (typically https://...). */
  url: z.url(),
  /** Optional auth. Defaults to `{ type: 'none' }`. */
  auth: McpHttpAuthSchema.default({ type: 'none' }),
  /**
   * Optional static headers to set on every request. SecretRefs are
   * NOT resolved here ... use `auth` for tokens. Keys are case-
   * insensitive per HTTP semantics; values are passed verbatim.
   */
  headers: z.record(z.string().min(1), z.string()).default({}),
})

export const McpServerSpecSchema = z.discriminatedUnion('transport', [
  McpServerSpecStdioSchema,
  McpServerSpecHttpSchema,
])
export type McpServerSpec = z.infer<typeof McpServerSpecSchema>
export type McpServerSpecStdio = z.infer<typeof McpServerSpecStdioSchema>
export type McpServerSpecHttp = z.infer<typeof McpServerSpecHttpSchema>

export const IdentityFrontmatterSchema = z.object({
  schema_version: z.literal(5),
  agent_name: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9_-]*$/, {
      message:
        'agent_name must start with a lowercase letter; lowercase letters, digits, underscores, and dashes only',
    }),
  agent_role: z.string().min(1),
  /**
   * Optional avatar glyph rendered inside the AgentMark circle (a short
   * emoji or 1-2 character string). When unset, the AgentMark falls back
   * to the first letter of the agent's display name. Editable via
   * `PUT /api/v1/agents/:name/avatar` from the global Settings page.
   */
  avatar: z.string().max(8).optional(),
  model: ModelBindingSchema,
  tools: z.array(ToolNameSchema).default([]),
  project_dir: z.string().min(1),
  brain_dir: z.string().min(1),
  created: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'created must be a date in YYYY-MM-DD form',
  }),
  cost_caps: CostCapsSchema.default(COST_CAPS_DEFAULT),
  /**
   * Per-Agent notification tier policy (Epic 7). Restricts which
   * notification tiers this Agent can emit. Default forbids
   * `critical` — only the supervisor's policy code (reacting to
   * specific action types) can promote to critical.
   */
  notification_policy: NotificationPolicySchema.default(NOTIFICATION_POLICY_DEFAULT),
  /**
   * Per-Agent override for the `request_credential` rate cap (decision:
   * 2026-05-14-request-credential-substrate). Default is the global
   * 15 / hour cap; an operator can raise or lower it per-Agent here.
   * Clamped to at least 1 by the runtime.
   *
   * Optional: absent / null falls through to the global default.
   */
  request_credential_rate_per_hour: z.number().int().min(1).optional(),
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
  /**
   * External MCP servers the supervisor spawns alongside the Agent
   * process at start (Epic 9 Phase A). Each entry's tools become
   * available to the Agent if granted via the `tools` array (by
   * exact name or `<namespace>.*` wildcard). Defaults to empty,
   * preserving v4 semantics ... an Agent with no entry uses only
   * the baseline tools.
   */
  /**
   * Archive marker (Epic 17). Present when an operator has archived
   * the Agent. The directory has been renamed to `<name>-archived-<date>`
   * and the `agent_name` field updated to match. Listing this block in
   * frontmatter lets the UI render the date + reason without re-parsing
   * the directory name. Absence means a live (non-archived) Agent.
   */
  archived: z
    .object({
      at: z.string().min(1),
      reason: z.string().optional(),
    })
    .optional(),
  mcp_servers: z
    .array(McpServerSpecSchema)
    .default([])
    .superRefine((servers, ctx) => {
      const seen = new Set<string>()
      for (let i = 0; i < servers.length; i++) {
        const name = servers[i]?.name
        if (name === undefined) continue
        if (seen.has(name)) {
          ctx.addIssue({
            code: 'custom',
            path: [i, 'name'],
            message: `duplicate mcp_servers[].name "${name}"; each Identity may declare a given namespace at most once`,
          })
        }
        seen.add(name)
      }
    }),
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
