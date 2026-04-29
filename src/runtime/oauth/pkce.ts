/**
 * PKCE helpers per RFC 7636.
 *
 * `code_verifier` is a 43-128 char URL-safe random string. We
 * generate 96 bytes -> 128 base64url chars, stripping padding.
 *
 * `code_challenge` is base64url(sha256(verifier)).
 */
import { createHash, randomBytes } from 'node:crypto'
import type { PkcePair } from './types.js'

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function generatePkce(): PkcePair {
  const verifier = base64url(randomBytes(96))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge, method: 'S256' }
}

export function generateState(): string {
  return base64url(randomBytes(24))
}
