/**
 * Per-pub secret material: admin secret + signing keypair.
 *
 * `@openpub-ai/pub-server@0.3.3` requires three secrets at startup
 * when running in LOCAL_TRUST mode:
 *   - `OPENPUB_ADMIN_SECRET` — gates POST /admin/register-agent. The
 *     supervisor passes this to pub-server at spawn AND uses it on
 *     register-agent calls (via the X-OpenPub-Admin-Secret header).
 *   - `PUB_SIGNING_PRIVATE_KEY` — Ed25519 private key the pub itself
 *     uses to sign relay messages.
 *   - `PUB_SIGNING_PUBLIC_KEY` — matching public key.
 *
 * The supervisor generates these at `cli.pub.create` time and
 * persists them under the per-pub state dir at mode 0600. They are
 * loaded into env on every `cli.pub.start` (since pub-server is
 * stateless on these — it reads the env vars and trusts them).
 *
 * This module owns generation, persistence, and read; it does NOT
 * own admin-secret transmission (that's identity-client.ts).
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdir, readFile, chmod } from 'node:fs/promises'
import { dirname } from 'node:path'
import { atomicWriteFile } from '../util/atomic-write.js'

export interface PubSecrets {
  /** Random 32-byte secret, base64url-encoded. */
  adminSecret: string
  /** Ed25519 signing keypair, base64url scalars. */
  signingPrivateKey: string
  signingPublicKey: string
}

interface SigningKeyFile {
  schema_version: 1
  private_key: string
  public_key: string
}

/**
 * Generate a fresh PubSecrets bundle. Caller persists via
 * `writePubSecrets`.
 */
export function generatePubSecrets(): PubSecrets {
  const adminSecret = randomBytes(32).toString('base64url')
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privJwk = privateKey.export({ format: 'jwk' })
  const pubJwk = publicKey.export({ format: 'jwk' })
  if (privJwk.kty !== 'OKP' || privJwk.crv !== 'Ed25519' || typeof privJwk.d !== 'string') {
    throw new Error('unexpected JWK shape for Ed25519 pub signing private key')
  }
  if (pubJwk.kty !== 'OKP' || pubJwk.crv !== 'Ed25519' || typeof pubJwk.x !== 'string') {
    throw new Error('unexpected JWK shape for Ed25519 pub signing public key')
  }
  return {
    adminSecret,
    signingPrivateKey: privJwk.d,
    signingPublicKey: pubJwk.x,
  }
}

/**
 * Persist a PubSecrets bundle to disk. Each file is written atomically
 * and chmod'd to 0600 after the rename.
 */
export async function writePubSecrets(
  paths: { adminSecret: string; signingKey: string },
  secrets: PubSecrets,
): Promise<void> {
  await mkdir(dirname(paths.adminSecret), { recursive: true })
  await atomicWriteFile(paths.adminSecret, secrets.adminSecret + '\n')
  await chmod(paths.adminSecret, 0o600)
  const signingFile: SigningKeyFile = {
    schema_version: 1,
    private_key: secrets.signingPrivateKey,
    public_key: secrets.signingPublicKey,
  }
  await atomicWriteFile(paths.signingKey, JSON.stringify(signingFile, null, 2) + '\n')
  await chmod(paths.signingKey, 0o600)
}

/**
 * Read a previously-persisted PubSecrets bundle from disk.
 */
export async function readPubSecrets(paths: {
  adminSecret: string
  signingKey: string
}): Promise<PubSecrets> {
  const adminSecret = (await readFile(paths.adminSecret, 'utf8')).trim()
  const signingRaw = await readFile(paths.signingKey, 'utf8')
  let signing: unknown
  try {
    signing = JSON.parse(signingRaw)
  } catch (err) {
    throw new Error(
      `pub signing key at ${paths.signingKey} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const s = (signing as Record<string, unknown> | null) ?? {}
  if (s['schema_version'] !== 1 || typeof s['private_key'] !== 'string' || typeof s['public_key'] !== 'string') {
    throw new Error(`pub signing key at ${paths.signingKey} has wrong shape`)
  }
  return {
    adminSecret,
    signingPrivateKey: s['private_key'],
    signingPublicKey: s['public_key'],
  }
}
