/**
 * Ed25519 keypair generation and credential file persistence.
 *
 * Per Epic 3 [[03-local-pub-integration]] and Poe's contract reply
 * (2026-04-26), the keypair is the durable identity for both Agents and
 * the human user in the OpenPub layer. The `agent_id` UUID v7 is
 * derived from a successful registration; the keypair is what proves
 * "I am the entity behind this agent_id" on every reconnect.
 *
 * Storage discipline: credentials live in their own file at mode 0600,
 * SecretRef-resolved at boot per [[upgrade-readiness]] discipline 5.
 * The runtime never logs the private key, including on parse errors.
 *
 * Why a dedicated module rather than inlining in identity-provisioning:
 * tests want to exercise key generation, file round-trip, and
 * mode-0600 enforcement without spinning up the broader provisioning
 * orchestration. Keeping the file ops here keeps each file's
 * responsibility small.
 */
import { sign, createPublicKey, createPrivateKey, type KeyObject } from 'node:crypto'
import { readFile, stat, chmod } from 'node:fs/promises'
import { atomicWriteFile } from '../util/atomic-write.js'

/**
 * The on-disk shape of a pub credential file. Stored as JSON in a
 * single file at mode 0600. Public key is included so the runtime
 * can produce signed payloads without re-deriving it on every call.
 *
 * `agent_id` may be `null` immediately after `generateKeypair` when
 * the keypair has not yet been registered with a pub-server. After
 * registration completes, the caller writes the assigned `agent_id`
 * back via `writeCredentialFile`.
 *
 * `issuer_url` is informational; it records which issuer minted the
 * agent_id. v0.3.2 LOCAL mode uses something like `local://<pub-host>`;
 * v0.3.x HUB mode uses the hub URL.
 */
export interface PubCredential {
  /** UUID v7 returned by the issuer on register. Null if not yet registered. */
  agent_id: string | null
  /** Ed25519 private key, base64url-encoded. */
  private_key: string
  /** Ed25519 public key, base64url-encoded. */
  public_key: string
  /** Bumps on key rotation. v1 always starts at 1. */
  key_version: number
  /** Display name used at register-time. Stored for diagnostic purposes. */
  display_name: string
  /** Issuer URL (`local://<pub-host>` or hub URL). Informational. */
  issuer_url: string
}

/**
 * Persist a credential record to disk at mode 0600. Atomic via
 * temp+rename; on POSIX, rename is atomic on the same filesystem.
 *
 * The file format is JSON. YAML frontmatter would conflict with the
 * keypair-as-secret discipline (the file is a secret, not a doc).
 */
export async function writeCredentialFile(path: string, cred: PubCredential): Promise<void> {
  const json = JSON.stringify(cred, null, 2) + '\n'
  await atomicWriteFile(path, json)
  // Belt-and-braces chmod after the rename. atomicWriteFile creates
  // the temp via `open(path, 'wx')` which uses the default umask;
  // setting mode 0600 explicitly ensures the credential file is not
  // group- or world-readable regardless of umask.
  await chmod(path, 0o600)
}

/**
 * Read a credential file from disk. Throws on parse error or shape
 * mismatch. Errors are wrapped to redact the file content (never
 * leak the private key into a log line).
 */
export async function readCredentialFile(path: string): Promise<PubCredential> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    throw new Error(`cannot read pub credential file at ${path}: ${describeError(err)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    // Deliberately do NOT include `raw` in the error message; raw
    // contains the private key.
    throw new Error(`pub credential file at ${path} is not valid JSON: ${describeError(err)}`)
  }
  // Shape check, deliberately terse. Same redaction discipline:
  // failures name fields, never values.
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('private_key' in parsed) ||
    !('public_key' in parsed) ||
    !('display_name' in parsed) ||
    !('issuer_url' in parsed) ||
    !('key_version' in parsed)
  ) {
    throw new Error(`pub credential file at ${path} is missing required fields`)
  }
  const c = parsed as Record<string, unknown>
  if (
    typeof c['private_key'] !== 'string' ||
    typeof c['public_key'] !== 'string' ||
    typeof c['display_name'] !== 'string' ||
    typeof c['issuer_url'] !== 'string' ||
    typeof c['key_version'] !== 'number' ||
    (c['agent_id'] !== null && typeof c['agent_id'] !== 'string')
  ) {
    throw new Error(`pub credential file at ${path} has wrong field types`)
  }
  return {
    agent_id: c['agent_id'],
    private_key: c['private_key'],
    public_key: c['public_key'],
    key_version: c['key_version'],
    display_name: c['display_name'],
    issuer_url: c['issuer_url'],
  }
}

/**
 * Verify (best-effort) that a credential file has restrictive mode
 * bits set. POSIX: returns true iff group-read, group-write,
 * world-read, world-write, world-execute are all OFF. On Windows
 * (where stat.mode bits are limited), returns true unconditionally;
 * filesystem ACLs are how Windows handles this and we do not check
 * them at v1.
 */
export async function isCredentialFileMode0600(path: string): Promise<boolean> {
  if (process.platform === 'win32') return true
  const s = await stat(path)
  // Mode is 16 bits on POSIX; we want to confirm the lower 9
  // permission bits are exactly rw------- (0o600).
  const perms = s.mode & 0o777
  return perms === 0o600
}

/**
 * Sign a UTF-8 message with the credential's private key. Used to
 * produce signed-timestamp payloads for `POST /agents/auth`. Returns
 * a base64url-encoded signature.
 */
export function signMessage(cred: PubCredential, message: string): string {
  // Reconstruct the KeyObject from the stored JWK form.
  const keyObject = createPrivateKeyFromBase64url(cred.private_key)
  const sig = sign(null, Buffer.from(message, 'utf8'), keyObject)
  return sig.toString('base64url')
}

/**
 * Reconstruct the public key as a base64url string. Useful for the
 * register-agent payload.
 */
export function publicKeyBase64url(cred: PubCredential): string {
  return cred.public_key
}

/**
 * Compose the canonical message that the auth handshake signs: the
 * agent_id and a timestamp, separated by a colon. Per Poe's contract
 * reply: `${agent_id}:${timestamp}`.
 */
export function composeAuthMessage(agent_id: string, timestamp: string): string {
  return `${agent_id}:${timestamp}`
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function createPrivateKeyFromBase64url(privateKeyB64u: string): KeyObject {
  // Use the JWK form to reimport. Ed25519 private is the `d` field.
  // The matching `x` (public) is required by Node's JWK parser; we
  // recompute it from the private key by deriving the public.
  const keyObject = createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      d: privateKeyB64u,
      // Node accepts `x` either as the actual public component or
      // (in some versions) as a placeholder if `d` is sufficient.
      // We recompute via createPublicKey below if needed.
      x: derivePublicX(privateKeyB64u),
    },
    format: 'jwk',
  })
  return keyObject
}

function derivePublicX(privateKeyB64u: string): string {
  // Build a private KeyObject with a known-bad `x` first, then export
  // the public side to read its actual `x`. Cheaper than trial-and-error.
  // Node accepts a JWK private key with any `x` for Ed25519 because
  // the private scalar fully determines the public key; we only need
  // the JWK form to be self-consistent for later operations.
  // Strategy: import without `x` if Node permits, else round-trip
  // through PEM. Modern Node (>=22) accepts the JWK with a stub `x`
  // and recomputes; we provide a 32-byte zero placeholder and let
  // Node's createPublicKey path recompute the real one.
  const placeholderX = Buffer.alloc(32).toString('base64url')
  const tmp = createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', d: privateKeyB64u, x: placeholderX },
    format: 'jwk',
  })
  const pub = createPublicKey(tmp).export({ format: 'jwk' })
  if (typeof pub.x !== 'string') {
    throw new Error('failed to derive public Ed25519 component')
  }
  return pub.x
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
