/**
 * Credential-request types (decision:
 * 2026-05-14-request-credential-substrate).
 *
 * A `CredentialRequest` is a runtime record describing an Agent's
 * request that the operator paste a credential value through a 1:1
 * chat surface. The VALUE itself is never part of the record: it
 * lands directly in the per-Agent vault on fulfill, and the record's
 * `state` flips to terminal. The record exists so the operator UI can
 * render an inline card, the audit pipeline can verify "I asked the
 * operator for X" claims, and a supervisor restart can reload pending
 * requests.
 *
 * The record file lives at
 *   <home>/state/credential-requests/<request-id>.json
 *
 * Schema is locked at v1; new fields must go through a `v2` migration
 * so older records load cleanly.
 */
import { z } from 'zod'
import { CredentialNameSchema } from './types.js'

/** Widget hint for the operator UI. Matches the `mcp:` extension `kind`. */
export const CredentialKindSchema = z.enum(['value', 'secret', 'file'])
export type CredentialKind = z.infer<typeof CredentialKindSchema>

/**
 * State machine. All four non-pending states are terminal; re-issuing
 * the same credential_name after expiration creates a NEW request
 * (subject to the rate cap).
 */
export const CredentialRequestStateSchema = z.enum(['pending', 'fulfilled', 'declined', 'expired'])
export type CredentialRequestState = z.infer<typeof CredentialRequestStateSchema>

/**
 * Reason an `expired` record reached that state. `timeout` is the
 * default (the 5-minute window elapsed). `agent_crashed` and
 * `agent_archived` are set by the supervisor when it sweeps a
 * non-recoverable Agent's pending requests. These reasons surface in
 * the operator UI; only `timeout` ever reaches the Agent's tool
 * result (the Agent isn't around to receive the others).
 */
export const ExpiredReasonSchema = z.enum(['timeout', 'agent_crashed', 'agent_archived'])
export type ExpiredReason = z.infer<typeof ExpiredReasonSchema>

/**
 * Persisted record. The VALUE field is intentionally absent at every
 * state. When the operator fulfills, the value goes straight to vault
 * and this record just flips state to 'fulfilled'.
 */
export const CredentialRequestSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().regex(/^credreq_[a-f0-9]{32}$/, {
    message: 'credential request id must be `credreq_<32 hex>`',
  }),
  agent: z.string().min(1),
  /** Chat thread the request was issued in. Required: requests only spawn from chat. */
  chat_id: z.string().min(1),
  credential_name: CredentialNameSchema,
  label: z.string().min(1),
  help: z.string(),
  kind: CredentialKindSchema,
  reason: z.string(),
  /** ISO 8601 UTC. */
  created_at: z.string(),
  /** ISO 8601 UTC. created_at + timeout. */
  expires_at: z.string(),
  state: CredentialRequestStateSchema,
  fulfilled_at: z.string().nullable().default(null),
  declined_at: z.string().nullable().default(null),
  /**
   * Operator's text on a human-declined record OR a structured slug
   * for runtime-generated declines ('rate_capped', 'surface_invalid',
   * 'invalid_credential_name'). Free-form to support both shapes.
   */
  decline_reason: z.string().nullable().default(null),
  expired_at: z.string().nullable().default(null),
  expired_reason: ExpiredReasonSchema.nullable().default(null),
})
export type CredentialRequest = z.infer<typeof CredentialRequestSchema>

/** Rolling 1-hour rate-cap state. One file per Agent. */
export const RateCapStateSchema = z.object({
  schema_version: z.literal(1),
  agent: z.string().min(1),
  /** ISO 8601 UTC of the current window's start. */
  window_start: z.string(),
  count: z.number().int().nonnegative(),
})
export type RateCapState = z.infer<typeof RateCapStateSchema>

/** Default per-Agent rate cap. Configurable via settings + identity overrides. */
export const DEFAULT_RATE_PER_HOUR = 15

/** Default per-request timeout. */
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Structured decline reasons emitted by the runtime on inline
 * validation rejection. Operator-typed reasons are free text and
 * never use these slugs.
 */
export const RUNTIME_DECLINE_REASONS = [
  'rate_capped',
  'surface_invalid',
  'invalid_credential_name',
] as const
export type RuntimeDeclineReason = (typeof RUNTIME_DECLINE_REASONS)[number]

export class CredentialRequestError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'NOT_FOUND'
      | 'CORRUPT'
      | 'INVALID_TRANSITION'
      | 'IO_ERROR'
      | 'WRONG_AGENT',
  ) {
    super(message)
    this.name = 'CredentialRequestError'
  }
}

/**
 * Frozen wire envelope inserted as a system-role message in the chat
 * thread (decision §"Frozen wire shape"). The web's
 * CredentialRequestCard reads this directly. Adding fields requires
 * a `v2` envelope; readers must not silently drop unknown fields.
 */
export const CredentialRequestEnvelopeV1Schema = z.object({
  envelope: z.literal('credential_request_v1'),
  request_id: z.string(),
  label: z.string(),
  help: z.string(),
  kind: CredentialKindSchema,
  reason: z.string(),
  destination_credential_name: CredentialNameSchema,
  expires_at: z.string(),
  state: CredentialRequestStateSchema,
})
export type CredentialRequestEnvelopeV1 = z.infer<typeof CredentialRequestEnvelopeV1Schema>

export function toEnvelopeV1(rec: CredentialRequest): CredentialRequestEnvelopeV1 {
  return {
    envelope: 'credential_request_v1',
    request_id: rec.id,
    label: rec.label,
    help: rec.help,
    kind: rec.kind,
    reason: rec.reason,
    destination_credential_name: rec.credential_name,
    expires_at: rec.expires_at,
    state: rec.state,
  }
}
