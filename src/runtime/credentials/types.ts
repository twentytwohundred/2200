/**
 * Credential vault types (Epic 9 Phase B).
 *
 * Each vault entry holds a string secret (bearer token, API key,
 * OAuth refresh token, etc) plus structured metadata describing
 * provenance and expiry. The on-disk form is an AES-256-GCM sealed
 * envelope; the helpers in vault.ts handle sealing / unsealing.
 *
 * Naming:
 *   - credential names match `^[a-z][a-z0-9-]*$`. Used as filenames
 *     and SecretRef ids; the slug rule keeps both safe.
 *   - The vault is per-Agent. A SecretRef of `{ source: 'vault',
 *     id: '<credential>' }` resolves against the calling Agent's
 *     vault. SecretRef ids of the form `<agent>:<credential>` resolve
 *     against a different Agent's vault (used by supervisor-mediated
 *     resolution at MCP server launch time).
 */
import { z } from 'zod'

export const CREDENTIAL_NAME_RE = /^[a-z][a-z0-9-]*$/

export const CredentialNameSchema = z.string().regex(CREDENTIAL_NAME_RE, {
  message:
    'credential name must be a slug starting with a lowercase letter; lowercase + digits + dashes only',
})

export const CredentialMetadataSchema = z.object({
  /** ISO-8601 UTC. Required. */
  created_at: z.string(),
  /** ISO-8601 UTC. Optional ... when set, callers can refresh proactively. */
  expires_at: z.string().optional(),
  /** Provider tag (e.g., "google", "github"). Free-form at v1. */
  provider: z.string().optional(),
  /** OAuth scopes if applicable. */
  scopes: z.array(z.string()).optional(),
  /** Free-form notes (visible in `2200 credential list / show`). */
  notes: z.string().optional(),
})
export type CredentialMetadata = z.infer<typeof CredentialMetadataSchema>

/**
 * Sealed envelope as written to disk. iv / ciphertext / tag are hex.
 * Metadata is plaintext so `2200 credential list` can render it
 * without unsealing every entry. The credential VALUE is sealed.
 */
export const SealedCredentialSchema = z.object({
  schema_version: z.literal(1),
  iv: z.string(),
  ciphertext: z.string(),
  tag: z.string(),
  metadata: CredentialMetadataSchema,
})
export type SealedCredential = z.infer<typeof SealedCredentialSchema>

/** Plaintext form returned to authorized callers. */
export interface PlaintextCredential {
  value: string
  metadata: CredentialMetadata
}

export class CredentialVaultError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'NOT_FOUND'
      | 'CORRUPT'
      | 'INVALID_NAME'
      | 'TAMPERED'
      | 'IO_ERROR'
      | 'INVALID_SECRETREF',
  ) {
    super(message)
    this.name = 'CredentialVaultError'
  }
}
