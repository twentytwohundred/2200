/**
 * User identity types.
 *
 * The user's identity file lives at `<home>/config/user.md` per
 * Epic 3 [[03-local-pub-integration]]. v1 schema includes:
 *
 *  - schema_version (integer, per [[2026-04-26-schema-version-format]])
 *  - display_name (the human-readable name)
 *  - pub block (the user's pub identity: agent_id, handle, credentials,
 *    key_version, issuer_url)
 *  - scut block (empty until Epic 4; structural placeholder)
 *  - created date (YYYY-MM-DD)
 *
 * The body of the file (after the closing `---`) is the user's
 * free-form bio. The runtime reads frontmatter only; the body is
 * for the user themselves and any client that wants to surface it.
 */
import { z } from 'zod'

/**
 * SecretRef pointer for the user's pub credentials file. Always
 * `source: 'file'` at v1; the runtime reads the file at boot when
 * it needs the keypair.
 */
export const UserPubCredentialsSchema = z.object({
  source: z.literal('file'),
  id: z.string().min(1),
})
export type UserPubCredentials = z.infer<typeof UserPubCredentialsSchema>

/**
 * The user's pub identity block. Mirrors the per-Agent `pub:` block
 * shape so consumers can treat user and Agents uniformly when the
 * pub layer needs an identity.
 */
export const UserPubBlockSchema = z.object({
  /** UUID v7 from OpenPub. May be empty before `2200 user init` registers. */
  identity: z.string(),
  /** The `@doug` style handle. Display-only; uniqueness enforced by pub-server. */
  handle: z.string().min(1),
  credentials: UserPubCredentialsSchema,
  key_version: z.number().int().positive().default(1),
  /** `local://<pub-host>` for LOCAL_TRUST or the hub URL for HUB mode. */
  issuer_url: z.string().min(1),
})
export type UserPubBlock = z.infer<typeof UserPubBlockSchema>

/**
 * Placeholder for the SCUT block (Epic 4). v1 leaves this empty.
 * Schema permits unknown keys to be forward-compatible with whatever
 * Epic 4 lands.
 */
export const UserScutBlockSchema = z.record(z.string(), z.unknown()).default({})
export type UserScutBlock = z.infer<typeof UserScutBlockSchema>

/**
 * The full user identity frontmatter.
 */
export const UserIdentityFrontmatterSchema = z.object({
  schema_version: z.literal(1),
  display_name: z.string().min(1),
  pub: UserPubBlockSchema,
  scut: UserScutBlockSchema,
  created: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'created must be a date in YYYY-MM-DD form',
  }),
})
export type UserIdentityFrontmatter = z.infer<typeof UserIdentityFrontmatterSchema>

export interface UserIdentityRecord {
  readonly frontmatter: UserIdentityFrontmatter
  readonly body: string
  readonly source_path: string
}
