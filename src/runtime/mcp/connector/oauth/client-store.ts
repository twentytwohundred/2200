/**
 * OAuth client registration store (Phase 2 PR-A1).
 *
 * One sealed JSON file per registered client at
 * `<home>/state/connector/oauth-clients/<client_id>.json`. Parallel
 * to PR 1a's bearer-store and PR 3's brief vault discipline:
 * AES-256-GCM + HKDF, mode 0600, atomic writes. Distinct HKDF info
 * string ("2200-oauth-clients-v1:fleet") so a compromise of any
 * sibling sealed store does not derive this one's wrapping key.
 *
 * Client secrets, when registered, are stored as a scrypt-derived
 * hash (`<scrypt-key>:<salt>` encoded). The plaintext secret is
 * shown to the operator exactly once at registration time and never
 * re-exposed. If the operator loses it, they re-register the
 * client (mint a fresh client_id + secret).
 *
 * Threat model boundary (locked, 2026-05-23): the operator's
 * `2200 connector oauth-client register` call IS the human security
 * boundary. Subsequent `/authorize` requests from this client_id
 * proceed without operator presence, validated against the record
 * here. Compromise of this sealed vault is sufficient to obtain
 * tokens; the master key + per-purpose HKDF salt remain the
 * load-bearing primitive.
 */
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto'
import { chmod, mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { atomicWriteFile } from '../../../util/atomic-write.js'
import { loadOrCreateMasterKey } from '../../../identity/keystore.js'
import { homePaths } from '../../../storage/layout.js'

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>

const SALT_BYTES = 32
const AES_KEY_BYTES = 32
const GCM_IV_BYTES = 12
const HKDF_INFO = '2200-oauth-clients-v1:fleet'
const FILE_MODE = 0o600
const DIR_MODE = 0o700

const CLIENT_ID_BYTES = 12 // 24 hex chars
const CLIENT_SECRET_BYTES = 32 // 43 base64url chars
const SCRYPT_SALT_BYTES = 16
const SCRYPT_KEYLEN = 32

/**
 * Canonical redirect URI grok.com/connectors uses for the Custom
 * Connector flow. Discovered empirically 2026-05-23 by registering a
 * connector and reading the redirect_uri query parameter off the
 * /authorize request. Not documented anywhere in xAI's public docs;
 * this constant is the fleet's source of truth.
 *
 * Other consumer-side MCP clients (Claude Desktop, ChatGPT MCP) use
 * different callback URLs; operators override via `--redirect-uri`
 * or the equivalent web form field.
 */
export const GROK_CONNECTOR_REDIRECT_URI = 'https://grok.com/connectors-oauth-exchange-code/'

const ClientRecordSchema = z.object({
  schema_version: z.literal(1),
  client_id: z.string().min(1),
  display_name: z.string().min(1),
  redirect_uris: z.array(z.url()).min(1),
  /** Encoded as `<scrypt-keylen-32 hex>:<scrypt-salt hex>` when present. */
  client_secret_hash: z.string().nullable(),
  scopes_allowed: z.array(z.string().min(1)).min(1),
  registered_at: z.string(),
  registered_by_operator: z.boolean(),
  last_authorize_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
})
export type ClientRecord = z.infer<typeof ClientRecordSchema>

const SealedClientSchema = z.object({
  schema_version: z.literal(1),
  client_id: z.string(),
  iv: z.string(),
  ciphertext: z.string(),
  tag: z.string(),
})

export interface RegisterClientArgs {
  home: string
  displayName: string
  /** Operator-supplied redirect URIs. Strict pre-registration; any redirect_uri sent at /authorize that is not in this set is rejected. */
  redirectUris: string[]
  /** When true, mint a client secret and return it once. Default false (PKCE-only). */
  mintSecret?: boolean
  /** Scopes the client may request. Default `['connector:full']`. */
  scopesAllowed?: string[]
  /** Injected clock (tests). */
  now?: () => Date
}

export interface RegisterClientResult {
  clientId: string
  /** Non-null iff `mintSecret` was true. Returned ONCE; not re-derivable from the stored hash. */
  clientSecret: string | null
}

/** Mint a fresh client_id (`grok-<24 hex>` shape — `grok-` reads as the canonical client). */
export function mintClientId(): string {
  return `grok-${randomBytes(CLIENT_ID_BYTES).toString('hex')}`
}

/** Mint a fresh client_secret (32 random bytes, base64url, no padding). */
export function mintClientSecret(): string {
  return randomBytes(CLIENT_SECRET_BYTES).toString('base64url')
}

/**
 * Hash a client secret using scrypt. Returns `<hex-key>:<hex-salt>`.
 * Use `verifyClientSecret` for the constant-time comparison side.
 */
export async function hashClientSecret(secret: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES)
  const key = await scryptAsync(secret, salt, SCRYPT_KEYLEN)
  return `${key.toString('hex')}:${salt.toString('hex')}`
}

/** Constant-time verify a candidate secret against a stored hash. */
export async function verifyClientSecret(candidate: string, stored: string): Promise<boolean> {
  const parts = stored.split(':')
  if (parts.length !== 2) return false
  const [keyHex, saltHex] = parts
  if (keyHex === undefined || saltHex === undefined) return false
  let storedKey: Buffer
  let salt: Buffer
  try {
    storedKey = Buffer.from(keyHex, 'hex')
    salt = Buffer.from(saltHex, 'hex')
  } catch {
    return false
  }
  if (storedKey.length !== SCRYPT_KEYLEN) return false
  const candidateKey = await scryptAsync(candidate, salt, SCRYPT_KEYLEN)
  if (candidateKey.length !== storedKey.length) return false
  return timingSafeEqual(candidateKey, storedKey)
}

function clientFilePath(home: string, clientId: string): string {
  return join(homePaths(home).state, 'connector', 'oauth-clients', `${clientId}.json`)
}

function clientStoreSaltPath(home: string): string {
  return join(homePaths(home).state, 'connector', 'oauth-clients', 'salt')
}

function clientStoreDir(home: string): string {
  return join(homePaths(home).state, 'connector', 'oauth-clients')
}

/**
 * Register a fresh OAuth client. Mints client_id (always) and
 * client_secret (if requested), persists the sealed record, returns
 * the operator-visible values. The plaintext secret in the result
 * is the ONE TIME it is exposed.
 */
export async function registerClient(args: RegisterClientArgs): Promise<RegisterClientResult> {
  const now = args.now?.() ?? new Date()
  const clientId = mintClientId()
  let clientSecret: string | null = null
  let secretHash: string | null = null
  if (args.mintSecret === true) {
    clientSecret = mintClientSecret()
    secretHash = await hashClientSecret(clientSecret)
  }
  const record: ClientRecord = {
    schema_version: 1,
    client_id: clientId,
    display_name: args.displayName,
    redirect_uris: args.redirectUris,
    client_secret_hash: secretHash,
    scopes_allowed: args.scopesAllowed ?? ['connector:full'],
    registered_at: now.toISOString(),
    registered_by_operator: true,
    last_authorize_at: null,
    revoked_at: null,
  }
  await writeRecord(args.home, record)
  return { clientId, clientSecret }
}

/** Read a client record by id. Returns null if missing. */
export async function readClient(home: string, clientId: string): Promise<ClientRecord | null> {
  const path = clientFilePath(home, clientId)
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const sealed = SealedClientSchema.parse(JSON.parse(raw))
  if (sealed.client_id !== clientId) {
    throw new Error(
      `oauth client file at ${path} has client_id="${sealed.client_id}" but expected "${clientId}"`,
    )
  }
  const wrappingKey = await getOrCreateWrappingKey(home)
  const iv = Buffer.from(sealed.iv, 'hex')
  const ciphertext = Buffer.from(sealed.ciphertext, 'hex')
  const tag = Buffer.from(sealed.tag, 'hex')
  const decipher = createDecipheriv('aes-256-gcm', wrappingKey, iv)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8')
  return ClientRecordSchema.parse(JSON.parse(plaintext))
}

/** List every registered client. Sorted by registered_at descending. */
export async function listClients(home: string): Promise<ClientRecord[]> {
  let entries: string[]
  try {
    entries = await readdir(clientStoreDir(home))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const records: ClientRecord[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const clientId = entry.slice(0, -'.json'.length)
    const record = await readClient(home, clientId).catch(() => null)
    if (record !== null) records.push(record)
  }
  return records.sort((a, b) => b.registered_at.localeCompare(a.registered_at))
}

/** Idempotent delete; returns true iff a file was removed. */
export async function deleteClient(home: string, clientId: string): Promise<boolean> {
  try {
    await unlink(clientFilePath(home, clientId))
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/** Update `last_authorize_at` on the record. */
export async function recordAuthorize(home: string, clientId: string, when: Date): Promise<void> {
  const existing = await readClient(home, clientId)
  if (existing === null) throw new Error(`unknown client_id "${clientId}"`)
  const updated: ClientRecord = { ...existing, last_authorize_at: when.toISOString() }
  await writeRecord(home, updated)
}

/** Mark a client revoked. Does not delete the record (audit trail). */
export async function markRevoked(home: string, clientId: string, when: Date): Promise<void> {
  const existing = await readClient(home, clientId)
  if (existing === null) throw new Error(`unknown client_id "${clientId}"`)
  const updated: ClientRecord = { ...existing, revoked_at: when.toISOString() }
  await writeRecord(home, updated)
}

/** Rotate the client_secret on an existing client. Returns the new plaintext secret. */
export async function rotateClientSecret(home: string, clientId: string): Promise<string> {
  const existing = await readClient(home, clientId)
  if (existing === null) throw new Error(`unknown client_id "${clientId}"`)
  const fresh = mintClientSecret()
  const hash = await hashClientSecret(fresh)
  const updated: ClientRecord = { ...existing, client_secret_hash: hash }
  await writeRecord(home, updated)
  return fresh
}

async function writeRecord(home: string, record: ClientRecord): Promise<void> {
  const wrappingKey = await getOrCreateWrappingKey(home)
  const payload = JSON.stringify(record)
  const iv = randomBytes(GCM_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', wrappingKey, iv)
  const ciphertext = Buffer.concat([cipher.update(payload, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const envelope = {
    schema_version: 1,
    client_id: record.client_id,
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    tag: tag.toString('hex'),
  }
  const path = clientFilePath(home, record.client_id)
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE })
  await atomicWriteFile(path, JSON.stringify(envelope, null, 2))
  await chmod(path, FILE_MODE)
}

async function getOrCreateSalt(home: string): Promise<Buffer> {
  const path = clientStoreSaltPath(home)
  try {
    const buf = await readFile(path)
    if (buf.length !== SALT_BYTES) {
      throw new Error(`oauth client store salt at ${path} is wrong length`)
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

async function getOrCreateWrappingKey(home: string): Promise<Buffer> {
  const masterKey = await loadOrCreateMasterKey(home)
  const salt = await getOrCreateSalt(home)
  const info = Buffer.from(HKDF_INFO, 'utf-8')
  return Buffer.from(hkdfSync('sha256', masterKey, salt, info, AES_KEY_BYTES))
}

/** Returns true iff `clientId` corresponds to a non-revoked registered client. */
export async function clientExists(home: string, clientId: string): Promise<boolean> {
  const record = await readClient(home, clientId)
  return record !== null && record.revoked_at === null
}

/** Touch the store directory just enough for `listClients` to be cheap on a missing home. */
export async function ensureClientStore(home: string): Promise<void> {
  await mkdir(clientStoreDir(home), { recursive: true, mode: DIR_MODE })
}

/** Check whether the file mode is at most 0600 (defensive for tests). */
export async function clientFileMode(home: string, clientId: string): Promise<number> {
  const s = await stat(clientFilePath(home, clientId))
  return s.mode & 0o777
}
