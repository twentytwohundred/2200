/**
 * PKCE (RFC 7636) S256 verification.
 *
 * The OAuth AS Phase 2 PR-A ships requires PKCE on every authorize
 * request; client_secret is optional (the grok.com/connectors UI
 * defaults to "none (PKCE only)" for Token Auth Method).
 *
 * The client sends a `code_challenge` (base64url-encoded SHA-256 of
 * a random `code_verifier`) at `/authorize`. We persist the challenge
 * with the authorization code. On `/token` exchange the client sends
 * the original `code_verifier`; we re-hash and constant-time-compare
 * against the stored challenge. Mismatch = reject.
 *
 * Per spec, `plain` is forbidden in our AS — S256 only.
 */
import { createHash, timingSafeEqual } from 'node:crypto'

/** RFC 7636: code_verifier length must be 43–128 chars. */
const VERIFIER_MIN_LEN = 43
const VERIFIER_MAX_LEN = 128

/** Allowed verifier alphabet per RFC 7636 §4.1: [A-Z] [a-z] [0-9] '-' '.' '_' '~'. */
const VERIFIER_RULE = /^[A-Za-z0-9\-._~]+$/

/** Allowed challenge alphabet (base64url without padding). */
const CHALLENGE_RULE = /^[A-Za-z0-9_-]{43}$/

/**
 * Verify a code_verifier against a stored S256 challenge.
 *
 * Returns true iff the verifier hashes to the same value as the
 * challenge. Constant-time compare on equal-length inputs; length
 * mismatch short-circuits to false.
 */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (verifier.length < VERIFIER_MIN_LEN || verifier.length > VERIFIER_MAX_LEN) return false
  if (!VERIFIER_RULE.test(verifier)) return false
  if (!CHALLENGE_RULE.test(challenge)) return false
  const computed = createHash('sha256').update(verifier).digest('base64url')
  const a = Buffer.from(computed, 'utf-8')
  const b = Buffer.from(challenge, 'utf-8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Compute the S256 challenge for a given verifier. Useful in tests. */
export function computePkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/** Validate that a value is a well-formed S256 challenge string. */
export function isWellFormedChallenge(s: string): boolean {
  return CHALLENGE_RULE.test(s)
}
