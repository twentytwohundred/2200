/**
 * Custodial keystore for SCUT identities (Epic 4 Phase A PR B).
 *
 * Each Agent's signing (Ed25519) and encryption (X25519) private keys
 * are persisted on disk encrypted-at-rest. The encryption uses a
 * per-Agent wrapping key derived from the per-instance master key
 * via HKDF-SHA256 with a per-Agent salt and the agent_name as
 * KDF info. AES-256-GCM provides authenticated encryption.
 *
 * Layout (per Agent):
 *
 *   <home>/state/identities/<agent_name>/keys/
 *   ├── signing.ed25519       JSON: { iv: hex, ciphertext: hex, tag: hex }
 *   ├── encryption.x25519     same shape
 *   └── salt                  32 raw bytes
 *
 * The master key (`<home>/state/master.key`) is generated on first
 * call to `loadOrCreateMasterKey`. v1 keeps it plaintext on disk
 * with mode 0600... TPM / OS-keychain integration is a post-launch
 * hardening item per the Phase A spec.
 *
 * The keystore is process-agnostic. The supervisor uses it to write
 * keys at provisioning time; the Agent process uses it to read keys
 * at start-of-day. Future hardening can route reads through the
 * supervisor↔Agent control plane so the master key never leaves
 * the supervisor process.
 */
import { randomBytes, hkdfSync, createCipheriv, createDecipheriv } from 'node:crypto'
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { dirname } from 'node:path'
import { atomicWriteFile } from '../util/atomic-write.js'
import { agentIdentityPaths, masterKeyPath } from '../storage/layout.js'

const MASTER_KEY_BYTES = 32
const SALT_BYTES = 32
const AES_KEY_BYTES = 32
const GCM_IV_BYTES = 12
const GCM_TAG_BYTES = 16
const HKDF_INFO_PREFIX = '2200-agent-keys-v1:'

const KEY_FILE_MODE = 0o600
const KEY_DIR_MODE = 0o700

/** Public-key form returned to callers. Base64-encoded for Identity-file use. */
export interface PublicKeysB64 {
  ed25519: string
  x25519: string
}

/**
 * Raw keypair material. Private keys are 32-byte raw seeds (not DER /
 * PEM encoded); the SII document carries the matching public keys
 * base64-encoded. Callers receive plaintext private keys only when
 * loading via `readAgentPrivateKeys`; the on-disk form is wrapped.
 */
export interface AgentKeypairs {
  ed25519: { publicKeyRaw: Buffer; privateKeyRaw: Buffer }
  x25519: { publicKeyRaw: Buffer; privateKeyRaw: Buffer }
}

/**
 * Read or create the per-instance master key. First call on a fresh
 * `<home>/state/` writes a 32-byte random key to `master.key` with
 * mode 0600 and returns it. Subsequent calls read it back.
 *
 * Throws if the file exists but is not the expected length, rather
 * than silently regenerating; a corrupted master key would orphan
 * every wrapped Agent key, and the operator should know.
 */
export async function loadOrCreateMasterKey(home: string): Promise<Buffer> {
  const path = masterKeyPath(home)
  try {
    const buf = await readFile(path)
    if (buf.length !== MASTER_KEY_BYTES) {
      throw new Error(
        `master key at ${path} is ${String(buf.length)} bytes, expected ${String(MASTER_KEY_BYTES)}`,
      )
    }
    return buf
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const fresh = randomBytes(MASTER_KEY_BYTES)
  await mkdir(dirname(path), { recursive: true })
  // Use writeFile + chmod rather than atomicWriteFile so we can apply
  // mode 0600 atomically with the file's first appearance on disk.
  await writeFile(path, fresh, { mode: KEY_FILE_MODE })
  await chmod(path, KEY_FILE_MODE)
  return fresh
}

interface SealedBlob {
  iv: string
  ciphertext: string
  tag: string
}

/**
 * Encrypt and persist an Agent's keypairs. Generates a fresh
 * per-Agent salt, derives the wrapping key via HKDF, then seals
 * both private keys with AES-256-GCM. Public keys are returned
 * base64-encoded for the caller to put into the Identity file's
 * `scut.public_keys` block.
 *
 * Idempotent: if called twice with the same agent_name + master key
 * + freshly generated keypairs, the second call overwrites... use
 * with care; the older keypair is unrecoverable after this returns.
 */
export async function writeAgentKeys(args: {
  home: string
  agentName: string
  keypairs: AgentKeypairs
  masterKey: Buffer
}): Promise<PublicKeysB64> {
  const paths = agentIdentityPaths(args.home, args.agentName)
  await mkdir(paths.keysDir, { recursive: true, mode: KEY_DIR_MODE })

  const salt = randomBytes(SALT_BYTES)
  await writeFile(paths.salt, salt, { mode: KEY_FILE_MODE })
  await chmod(paths.salt, KEY_FILE_MODE)

  const wrappingKey = deriveWrappingKey(args.masterKey, salt, args.agentName)

  const signingBlob = sealBytes(args.keypairs.ed25519.privateKeyRaw, wrappingKey)
  const encryptionBlob = sealBytes(args.keypairs.x25519.privateKeyRaw, wrappingKey)

  await atomicWriteFile(paths.signingKey, JSON.stringify(signingBlob))
  await chmod(paths.signingKey, KEY_FILE_MODE)
  await atomicWriteFile(paths.encryptionKey, JSON.stringify(encryptionBlob))
  await chmod(paths.encryptionKey, KEY_FILE_MODE)

  return {
    ed25519: args.keypairs.ed25519.publicKeyRaw.toString('base64'),
    x25519: args.keypairs.x25519.publicKeyRaw.toString('base64'),
  }
}

/**
 * Read and unseal an Agent's private keys. Returns the raw 32-byte
 * Ed25519 + X25519 private keys; callers must not log or persist
 * these.
 *
 * Throws on:
 *   - missing key dir (Agent not provisioned)
 *   - missing salt or key file (corruption)
 *   - GCM tag mismatch (wrong master key, or tampering)
 */
export async function readAgentPrivateKeys(args: {
  home: string
  agentName: string
  masterKey: Buffer
}): Promise<{ ed25519PrivateKeyRaw: Buffer; x25519PrivateKeyRaw: Buffer }> {
  const paths = agentIdentityPaths(args.home, args.agentName)
  const salt = await readFile(paths.salt)
  if (salt.length !== SALT_BYTES) {
    throw new Error(`per-Agent salt at ${paths.salt} is wrong length`)
  }
  const wrappingKey = deriveWrappingKey(args.masterKey, salt, args.agentName)

  const signingBlob = JSON.parse(await readFile(paths.signingKey, 'utf8')) as SealedBlob
  const encryptionBlob = JSON.parse(await readFile(paths.encryptionKey, 'utf8')) as SealedBlob

  return {
    ed25519PrivateKeyRaw: openBytes(signingBlob, wrappingKey),
    x25519PrivateKeyRaw: openBytes(encryptionBlob, wrappingKey),
  }
}

/**
 * Returns true if the Agent has provisioned key material on disk.
 * The supervisor uses this to decide whether to skip provisioning
 * (already done) or run it (first time).
 */
export async function hasAgentKeys(home: string, agentName: string): Promise<boolean> {
  const paths = agentIdentityPaths(home, agentName)
  try {
    await readFile(paths.signingKey)
    await readFile(paths.encryptionKey)
    await readFile(paths.salt)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

// --- internals -----------------------------------------------------------

function deriveWrappingKey(masterKey: Buffer, salt: Buffer, agentName: string): Buffer {
  const info = Buffer.from(`${HKDF_INFO_PREFIX}${agentName}`, 'utf8')
  const ikm = Uint8Array.from(masterKey)
  const saltU8 = Uint8Array.from(salt)
  const infoU8 = Uint8Array.from(info)
  const out = hkdfSync('sha256', ikm, saltU8, infoU8, AES_KEY_BYTES)
  return Buffer.from(out)
}

function sealBytes(plaintext: Buffer, wrappingKey: Buffer): SealedBlob {
  const iv = randomBytes(GCM_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', wrappingKey, iv)
  const ct1 = cipher.update(plaintext)
  const ct2 = cipher.final()
  const ciphertext = Buffer.concat([ct1, ct2])
  const tag = cipher.getAuthTag()
  if (tag.length !== GCM_TAG_BYTES) {
    throw new Error(`unexpected GCM tag length ${String(tag.length)}`)
  }
  return {
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    tag: tag.toString('hex'),
  }
}

function openBytes(blob: SealedBlob, wrappingKey: Buffer): Buffer {
  const iv = Buffer.from(blob.iv, 'hex')
  const ciphertext = Buffer.from(blob.ciphertext, 'hex')
  const tag = Buffer.from(blob.tag, 'hex')
  if (iv.length !== GCM_IV_BYTES) throw new Error('sealed blob has wrong-length iv')
  if (tag.length !== GCM_TAG_BYTES) throw new Error('sealed blob has wrong-length tag')
  const decipher = createDecipheriv('aes-256-gcm', wrappingKey, iv)
  decipher.setAuthTag(tag)
  const pt1 = decipher.update(ciphertext)
  const pt2 = decipher.final()
  return Buffer.concat([pt1, pt2])
}
