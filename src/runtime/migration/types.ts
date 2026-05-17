/**
 * Migration handoff document types and schema (Epic 5 Phase A PR A).
 *
 * A migration handoff document is a markdown file with YAML frontmatter
 * that describes how to bring an Agent into 2200. The frontmatter is
 * machine-readable; the body is preserved verbatim as a brain note
 * titled `continuity-from-migration` so the Agent's first context inside
 * the runtime is a written explanation of where it came from.
 *
 * This is distinct from the daily session-handoff format documented in
 * the wiki at `conventions/handoff-format.md`. They share the word
 * "handoff" by design ... both span a transition ... but the schemas are
 * different. The frontmatter `handoff_schema_version: 1` field locks
 * which kind this is.
 *
 * See [[05-migration]] for the full epic spec and field-by-field
 * documentation. The shape here is the locked v1 schema; future
 * versions migrate via the same migrator-chain pattern Identity uses
 * (see [[2026-04-26-schema-version-format]]).
 */
import { z } from 'zod'
import { McpServerSpecSchema } from '../identity/types.js'

export const HANDOFF_SCHEMA_VERSION = 1

/**
 * Allowed agent_name shape: starts with a lowercase letter, then
 * lowercase alphanumeric / underscore / dash. Matches the Identity
 * file's regex (see runtime/identity/types.ts) so a handoff
 * agent_name can flow directly into Identity.agent_name.
 */
const AGENT_NAME_RE = /^[a-z][a-z0-9_-]*$/

/**
 * Notification tier (mirrored from runtime/identity/types.ts so the
 * migration module does not pull in Identity's Zod object as a side
 * effect of importing one type). Kept in sync with NotificationTierSchema.
 */
const HandoffNotificationTierSchema = z.enum(['passive', 'normal', 'important', 'critical'])

/**
 * Identity intent: the bits the migration orchestrator uses to
 * generate an Identity markdown file for the new Agent.
 *
 * `display_name` flows into the OpenSCUT register call when the
 * orchestrator is invoked with `--provision-identity`. The OpenSCUT
 * service enforces a per-displayName-per-day rate limit (see the
 * SCUT identity epic in the wiki); the operator chooses the migration
 * window with that constraint in mind.
 *
 * `notification_policy.tiers_allowed` defaults to passive/normal/important
 * (matching the Identity loader default). Critical is admitted only
 * if the operator explicitly opts in by adding it; per the [[04-seed-team]]
 * lane, the runtime still gates critical-tier emission to supervisor-
 * driven action types.
 *
 * `carryover_keys` is Phase B (instance-to-instance migration) and is
 * not exercised by the Phase A orchestrator. The schema field is
 * present so handoff documents written by a future `2200 agent export`
 * step can declare it without violating the v1 schema.
 */
export const HandoffIdentitySchema = z.object({
  display_name: z.string().min(1),
  notification_policy: z
    .object({
      tiers_allowed: z
        .array(HandoffNotificationTierSchema)
        .default(['passive', 'normal', 'important']),
    })
    .default({ tiers_allowed: ['passive', 'normal', 'important'] }),
  carryover_keys: z
    .object({
      signing_path: z.string().min(1),
      encryption_path: z.string().min(1),
    })
    .optional(),
})
export type HandoffIdentity = z.infer<typeof HandoffIdentitySchema>

/**
 * Brain source: where the Agent's prior knowledge lives. Either a
 * directory path (bulk-imported via the existing Epic 8 importFromDir)
 * or an inline list of notes carried in the handoff itself.
 *
 * Both paths and inline notes can be present, in which case the
 * orchestrator imports the directory first, then writes the inline
 * notes (later writes overwrite by slug). Neither is required ... an
 * Agent can migrate in with an empty brain.
 *
 * `source_dir` may use a leading `~/` for the operator's home
 * directory; the parser leaves the path string untouched so the
 * orchestrator handles expansion at the right moment (when it knows
 * which user's home it is).
 */
export const HandoffBrainSchema = z.object({
  source_dir: z.string().min(1).optional(),
  inline_notes: z
    .array(
      z.object({
        title: z.string().min(1),
        body: z.string(),
        type: z.string().min(1).optional(),
        tags: z.array(z.string().min(1)).optional(),
        slug: z.string().min(1).optional(),
      }),
    )
    .optional(),
})
export type HandoffBrain = z.infer<typeof HandoffBrainSchema>

/**
 * Budget config. Per-Agent daily ceiling that the orchestrator writes
 * into the new Identity's `cost_caps.daily_usd` field. Keeping the
 * other cost_caps knobs (warn_at_pct, reset_at, on_breach) at their
 * Identity-default is intentional ... the migration handoff is the
 * minimum viable shape; adjustments happen post-migration via a normal
 * Identity edit.
 */
export const HandoffBudgetSchema = z.object({
  daily_cap_usd: z.number().positive(),
})
export type HandoffBudget = z.infer<typeof HandoffBudgetSchema>

/**
 * Schedule entries. Phase A enforces this list to be empty at parse
 * time (`schedules: []`). Phase A2 (small follow-on) wires schedule
 * entries into the existing ScheduleStore and lifts this constraint.
 *
 * The schema admits an array shape now so the orchestrator code path
 * that asks "do we have schedules to import?" can be written today
 * and flipped on later without a schema bump.
 */
export const HandoffScheduleSchema = z.object({
  /** Free-form schedule id; the ScheduleStore generates one if omitted. */
  id: z.string().min(1).optional(),
  /** Cron expression (5 fields) or interval string per the scheduler convention. */
  expr: z.string().min(1),
  /** Timezone for cron expressions; ignored for intervals. Defaults UTC. */
  tz: z.string().min(1).optional(),
  /** Task body to enqueue on fire. */
  task: z.string().min(1),
})
export type HandoffSchedule = z.infer<typeof HandoffScheduleSchema>

/**
 * Provenance metadata. All informational; no field changes runtime
 * behavior. The orchestrator writes the entire `provenance` block as
 * frontmatter on the continuity brain note, so the Agent (and any
 * later operator) can see where this Agent came from without re-reading
 * the original handoff.
 */
export const HandoffProvenanceSchema = z.object({
  source_system: z.string().min(1).optional(),
  source_host: z.string().min(1).optional(),
  exported_at: z.string().min(1).optional(),
})
export type HandoffProvenance = z.infer<typeof HandoffProvenanceSchema>

/**
 * The full handoff frontmatter shape. v1 of the schema.
 *
 * The v1 invariants the parser enforces:
 *
 *   - schema_version is exactly `1` (z.literal). Future versions get
 *     their own schema; the migrator chain promotes older docs.
 *   - agent_name matches the Identity-file regex.
 *   - identity.display_name is set (used by SCUT register).
 *   - budget.daily_cap_usd is positive.
 *   - schedules is empty (Phase A constraint; relaxed in A2).
 *
 * Everything else has a default or is optional.
 */
export const HandoffFrontmatterSchema = z.object({
  handoff_schema_version: z.literal(1),
  agent_name: z.string().min(1).regex(AGENT_NAME_RE, {
    message:
      'agent_name must start with a lowercase letter; lowercase letters, digits, underscores, and dashes only',
  }),
  /** Informational tag (e.g. `build_agent`, `email_agent`). Not enforced. */
  agent_type: z.string().min(1).default('agent'),
  identity: HandoffIdentitySchema,
  brain: HandoffBrainSchema.default({}),
  budget: HandoffBudgetSchema,
  schedules: z
    .array(HandoffScheduleSchema)
    .max(0, {
      message:
        'Phase A requires schedules: []. Wire schedules post-migration via `2200 schedule add`.',
    })
    .default([]),
  /**
   * External MCP servers to declare on the new Agent's Identity. Optional;
   * when present, the orchestrator pipes the entries through to the
   * resulting Identity's `mcp_servers[]` block so the Agent has access to
   * the declared tools the moment it starts. The shape mirrors
   * `Identity.mcp_servers[]` exactly.
   *
   * Both the migration flow (Epic 5) and the conversational onboarding
   * flow (Epic 14) populate this field: migration handoffs from a future
   * 2200-to-2200 export carry the source Agent's mcp_servers verbatim;
   * `2200 agent build` populates it from the suggested-tools curated
   * mapping (Epic 14 PR C). v1 in handoff documents on disk: optional
   * (defaults to empty); the loader silently accepts a v1 document
   * without the field.
   */
  mcp_servers: z.array(McpServerSpecSchema).default([]),
  /**
   * Preferred LLM model for the new Agent's day-to-day work. The
   * onboarding flow populates this from the picker on the intro card
   * (the same provider+model that ran the interview). Identity-from-
   * handoff uses this when present and falls back to a hardcoded
   * default when absent (keeps `agent migrate` from older handoffs
   * working without a schema break).
   */
  model: z
    .object({
      tier: z.enum(['frontier', 'fast', 'local']),
      provider: z.string().min(1),
      model_id: z.string().min(1),
    })
    .optional(),
  provenance: HandoffProvenanceSchema.default({}),
})
export type HandoffFrontmatter = z.infer<typeof HandoffFrontmatterSchema>

/**
 * The fully-parsed handoff document. Frontmatter (validated) plus the
 * markdown body verbatim ... including its leading/trailing whitespace
 * because the body becomes a brain note where the user's formatting
 * matters.
 */
export interface HandoffDocument {
  readonly frontmatter: HandoffFrontmatter
  /** Body of the markdown file (everything after the closing `---`). */
  readonly body: string
  /**
   * Source path the document was read from. Used in error messages
   * and recorded on the continuity brain note for traceability.
   * `null` when the document was parsed from an in-memory string.
   */
  readonly source_path: string | null
}

/**
 * Slug used by the orchestrator when writing the handoff body as a
 * brain note. Locked here so the value is identical across
 * orchestrator and tests, and so resume after a partial migration
 * can find the existing note.
 */
export const CONTINUITY_NOTE_SLUG = 'continuity-from-migration'
