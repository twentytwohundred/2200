/**
 * Resolve the tunnel-broker install secret (Epic 19).
 *
 * The broker's v1 auth is a shared HMAC install-token. The runtime resolves it
 * sealed-store-first, env-fallback:
 *   1. the sealed instance-secret store (`2200 secret set broker-install-secret`),
 *   2. else `TWENTYTWOHUNDRED_BROKER_INSTALL_SECRET` (interim env injection).
 *
 * Returns null when neither is set ... the caller (the provision flow) surfaces
 * "cloud mode isn't provisioned yet" rather than throwing. At the public cutover
 * this shared secret is replaced by per-box SCUT Ed25519 signing.
 */
import { readInstanceSecret } from './secret-store.js'

export const BROKER_SECRET_KEY = 'broker-install-secret'
const BROKER_SECRET_ENV = 'TWENTYTWOHUNDRED_BROKER_INSTALL_SECRET'

export async function resolveBrokerSecret(home: string): Promise<string | null> {
  const sealed = await readInstanceSecret(home, BROKER_SECRET_KEY)
  if (sealed !== null && sealed.length > 0) return sealed
  const env = process.env[BROKER_SECRET_ENV]
  return env !== undefined && env.length > 0 ? env : null
}
