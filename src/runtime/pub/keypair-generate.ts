/**
 * Pub keypair generation (split from `keypair.ts`).
 *
 * The supervisor calls `generateKeypair` at agent-create time. The
 * agent-side runtime (which signs messages) imports the rest of
 * `keypair.ts` but never the generation primitive ... separating the
 * file means the agent bundle does not pull `generateKeyPairSync`
 * into its bundled output unused.
 */
import { generateKeyPairSync } from 'node:crypto'
import type { PubCredential } from './keypair.js'

/**
 * Generate a fresh Ed25519 keypair and return a credential record
 * with `agent_id: null`. The caller decides where to persist it
 * (see `writeCredentialFile`) and when to register the keypair
 * with a pub-server.
 */
export function generateKeypair(opts: { display_name: string; issuer_url: string }): PubCredential {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privJwk = privateKey.export({ format: 'jwk' })
  const pubJwk = publicKey.export({ format: 'jwk' })
  if (privJwk.kty !== 'OKP' || privJwk.crv !== 'Ed25519' || typeof privJwk.d !== 'string') {
    throw new Error('unexpected JWK shape for Ed25519 private key')
  }
  if (pubJwk.kty !== 'OKP' || pubJwk.crv !== 'Ed25519' || typeof pubJwk.x !== 'string') {
    throw new Error('unexpected JWK shape for Ed25519 public key')
  }
  return {
    agent_id: null,
    private_key: privJwk.d,
    public_key: pubJwk.x,
    key_version: 1,
    display_name: opts.display_name,
    issuer_url: opts.issuer_url,
  }
}
