/**
 * Identity migrator: schema_version 2 -> 3.
 *
 * v3 (Epic 4 Phase A) introduced the optional `scut` block. The
 * migrator just stamps the version; the Zod schema's `scut` field
 * is `.optional()` so a v2 file with no `scut` block validates
 * cleanly as v3 (the supervisor's provisioning pipeline fills it
 * in later when the Agent is provisioned for SCUT).
 *
 * Defaulting `scut` to undefined rather than synthesizing a fake
 * block matches the discipline established by the `pub` block in
 * Epic 3: identity-dependent code paths check for the block's
 * presence and skip when absent.
 */

export function migrate2To3(prev: unknown): unknown {
  if (typeof prev !== 'object' || prev === null) {
    return prev
  }
  const obj = prev as Record<string, unknown>
  return { ...obj, schema_version: 3 }
}
