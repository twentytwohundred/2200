/**
 * Agent keypair generation (split out from `keystore.ts`).
 *
 * This is the supervisor-side primitive: at Agent provisioning time,
 * generate Ed25519 + X25519 keypairs that the supervisor then seals
 * with `writeAgentKeys`. Lives in its own file so the agent-side
 * runtime bundle (which only consumes `loadOrCreateMasterKey` via the
 * credential vault) does not pull `generateKeyPairSync` into its
 * bundled output.
 */
import { generateKeyPairSync } from 'node:crypto'
import type { AgentKeypairs } from './keystore.js'

/**
 * Generate a fresh Ed25519 + X25519 keypair pair for an Agent.
 * Returns the raw 32-byte private and public keys for both. The
 * caller is responsible for sealing them via `writeAgentKeys`.
 */
export function generateAgentKeypairs(): AgentKeypairs {
  const ed = generateKeyPairSync('ed25519')
  const x = generateKeyPairSync('x25519')
  return {
    ed25519: {
      publicKeyRaw: extractRaw32(
        ed.publicKey.export({ type: 'spki', format: 'der' }),
        'ed25519-pub',
      ),
      privateKeyRaw: extractRaw32(
        ed.privateKey.export({ type: 'pkcs8', format: 'der' }),
        'ed25519-priv',
      ),
    },
    x25519: {
      publicKeyRaw: extractRaw32(x.publicKey.export({ type: 'spki', format: 'der' }), 'x25519-pub'),
      privateKeyRaw: extractRaw32(
        x.privateKey.export({ type: 'pkcs8', format: 'der' }),
        'x25519-priv',
      ),
    },
  }
}

/**
 * Extract the 32 raw bytes of an Ed25519/X25519 key from a Node-
 * generated DER-encoded form. Both algorithms encode their 32-byte
 * key as the trailing 32 bytes of the DER payload.
 */
function extractRaw32(der: Buffer, label: string): Buffer {
  if (der.length < 32) {
    throw new Error(`${label} DER is too short (${String(der.length)} bytes)`)
  }
  return der.subarray(der.length - 32)
}
