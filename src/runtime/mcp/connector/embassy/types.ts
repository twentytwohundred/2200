/**
 * Embassy + conduit data model (Phase 2 / PR-B1).
 *
 * An "embassy" is the local Agent that owns the relationship with
 * an external MCP-speaking model. A "conduit" is the registry entry
 * that binds a registered OAuth client to the embassy Agent serving
 * its inbound traffic.
 *
 * Locked 2026-05-26: the conduits registry is keyed by the OAuth
 * client_id. The access token at /mcp already carries client_id so
 * the listener can resolve which embassy to route into without an
 * extra lookup.
 */
import { z } from 'zod'

/** External model identifier. Free-form lowercase string; canonical values: `grok`, `claude`, `chatgpt`. */
export const ExternalModelSchema = z.string().min(1).max(64)
export type ExternalModel = z.infer<typeof ExternalModelSchema>

/**
 * Conduit record. One per registered embassy/external-model
 * binding. On disk at
 *   `<home>/state/connector/conduits/<client_id>.json`
 *
 * The shared-brain `<shared>/brain/conduits.md` is an operator-
 * visible regenerated index, NOT the source of truth.
 */
export const ConduitRecordSchema = z.object({
  schema_version: z.literal(1),
  /** OAuth client_id from the oauth-clients store. Primary key. */
  client_id: z.string().min(1),
  external_model: ExternalModelSchema,
  /** Agent name that owns this conduit (the embassy). */
  embassy_agent: z.string().min(1),
  /** `dedicated`: agent created for this embassy. `attached`: existing agent took on the role. */
  mode: z.enum(['dedicated', 'attached']),
  /** Free-form display name shown in operator UIs (e.g., "Grok (Doug's subscription)"). */
  display_name: z.string().min(1),
  registered_at: z.string().min(1),
  registered_by: z.string().min(1),
  /** ISO 8601 of the last /mcp call routed through this conduit. Null until first call. */
  last_seen_at: z.string().nullable(),
  /** When non-null, the conduit is retired and no longer routes traffic. */
  retired_at: z.string().nullable(),
})
export type ConduitRecord = z.infer<typeof ConduitRecordSchema>

/** Embassy identity-frontmatter block (also in IdentityFrontmatterSchema). Exported for re-use. */
export const EmbassyIdentityBlockSchema = z.object({
  external_model: ExternalModelSchema,
  client_id: z.string().min(1),
  mode: z.enum(['dedicated', 'attached']),
  registered_at: z.string().min(1),
})
export type EmbassyIdentityBlock = z.infer<typeof EmbassyIdentityBlockSchema>
