/**
 * Fleet-scoped sealed bearer-token store for the MCP connector.
 *
 * Parallel to runtime/oauth/token-store.ts in shape and primitives, but
 * with a distinct HKDF namespace so a compromise in one store does not
 * cross over. One file per fleet at <home>/state/connector/bearer.json.
 *
 * Token format: `2200-mcp-<43 base64url chars>` (32 random bytes,
 * base64url-encoded, prefixed for human-recognizable provenance when
 * pasted into a provider's connector config).
 *
 * The token is "long-lived but revocable from our side": once the user
 * pastes it into grok.com/connectors (or equivalent), the provider holds
 * a copy. Regenerate wipes the local record and instantly invalidates
 * the old token at our door; the user re-pastes the new one upstream.
 *
 * Master-key rotation: if/when the fleet master key rotates, the
 * connector token must be re-wrapped or re-minted. TODO when key
 * rotation lands.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { atomicWriteFile } from '../../util/atomic-write.js'
import { loadOrCreateMasterKey } from '../../identity/keystore.js'
import { homePaths } from '../../storage/layout.js'

const SALT_BYTES = 32
const AES_KEY_BYTES = 32
const GCM_IV_BYTES = 12
const TOKEN_RANDOM_BYTES = 32
const TOKEN_PREFIX = '2200-mcp-'
const HKDF_INFO = '2200-connector-bearer-v1:fleet'
const FILE_MODE = 0o600
const DIR_MODE = 0o700

const SealedBearerSchema = z.object({
  schema_version: z.literal(1),
  iv: z.string(),
  ciphertext: z.string(),
  tag: z.string(),
  metadata: z.object({
    created_at: z.string(),
    regenerated_at: z.string().optional(),
  }),
})

export type SealedBearer = z.infer<typeof SealedBearerSchema>

export interface BearerRecord {
  readonly token: string
  readonly createdAt: string
  readonly regeneratedAt?: string
}

/** Mint a fresh token in the canonical `2200-mcp-<base64url>` shape. */
export function mintBearerToken(): string {
  const random = randomBytes(TOKEN_RANDOM_BYTES).toString('base64url')
  return `${TOKEN_PREFIX}${random}`
}

/** Returns true iff `s` matches the canonical token shape. */
export function isWellFormedBearerToken(s: string): boolean {
  if (!s.startsWith(TOKEN_PREFIX)) return false
  const rest = s.slice(TOKEN_PREFIX.length)
  return /^[A-Za-z0-9_-]+$/.test(rest) && rest.length >= 16
}

function bearerFilePath(home: string): string {
  return join(homePaths(home).state, 'connector', 'bearer.json')
}

function bearerSaltPath(home: string): string {
  return join(homePaths(home).state, 'connector', 'salt')
}

/** Persist a token. Overwrites any prior record. */
export async function saveBearer(home: string, record: BearerRecord): Promise<void> {
  const wrappingKey = await getOrCreateWrappingKey(home)
  const payload = JSON.stringify({ token: record.token })
  const iv = randomBytes(GCM_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', wrappingKey, iv)
  const ciphertext = Buffer.concat([cipher.update(payload, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()

  const envelope: SealedBearer = {
    schema_version: 1,
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    tag: tag.toString('hex'),
    metadata: {
      created_at: record.createdAt,
      ...(record.regeneratedAt !== undefined ? { regenerated_at: record.regeneratedAt } : {}),
    },
  }
  const path = bearerFilePath(home)
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE })
  await atomicWriteFile(path, JSON.stringify(envelope, null, 2))
  await chmod(path, FILE_MODE)
}

/** Read + unseal the token. Returns null if no record exists. */
export async function readBearer(home: string): Promise<BearerRecord | null> {
  const path = bearerFilePath(home)
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const parsed = SealedBearerSchema.parse(JSON.parse(raw))
  const wrappingKey = await getOrCreateWrappingKey(home)
  const iv = Buffer.from(parsed.iv, 'hex')
  const ciphertext = Buffer.from(parsed.ciphertext, 'hex')
  const tag = Buffer.from(parsed.tag, 'hex')
  const decipher = createDecipheriv('aes-256-gcm', wrappingKey, iv)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8')
  const payload = JSON.parse(plaintext) as { token: string }
  return {
    token: payload.token,
    createdAt: parsed.metadata.created_at,
    ...(parsed.metadata.regenerated_at !== undefined
      ? { regeneratedAt: parsed.metadata.regenerated_at }
      : {}),
  }
}

/** Returns true iff a token is currently persisted. */
export async function hasBearer(home: string): Promise<boolean> {
  try {
    await stat(bearerFilePath(home))
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/** Delete the token. Returns true if a file was removed. */
export async function deleteBearer(home: string): Promise<boolean> {
  try {
    await unlink(bearerFilePath(home))
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

async function getOrCreateSalt(home: string): Promise<Buffer> {
  const path = bearerSaltPath(home)
  try {
    const buf = await readFile(path)
    if (buf.length !== SALT_BYTES) {
      throw new Error(`connector bearer salt at ${path} is wrong length`)
    }
    return buf
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE })
  const fresh = randomBytes(SALT_BYTES)
  await atomicWriteFile(path, fresh)
  await chmod(path, FILE_MODE)
  return fresh
}

/**
 * Why both a master key AND a per-fleet salt: the master key is a
 * long-lived secret derived from the install layout; the salt is a
 * per-purpose randomizer that scopes the wrapping key to this store
 * only. Combined with `HKDF_INFO` (the namespace string), HKDF gives
 * us a wrapping key that is unique to (master key, this store, this
 * fleet) — so a compromise of any single OAuth-store salt does not
 * derive the connector-bearer wrapping key, and vice versa. The
 * primitives are the same as the per-Agent vault; the namespacing is
 * what keeps the blast radius small.
 */
async function getOrCreateWrappingKey(home: string): Promise<Buffer> {
  const masterKey = await loadOrCreateMasterKey(home)
  const salt = await getOrCreateSalt(home)
  const info = Buffer.from(HKDF_INFO, 'utf-8')
  return Buffer.from(hkdfSync('sha256', masterKey, salt, info, AES_KEY_BYTES))
}
