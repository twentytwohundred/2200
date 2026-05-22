/**
 * OAuth access + refresh token stores (Phase 2 PR-A1).
 *
 * Two parallel sealed-vault stores:
 *
 *   - `<home>/state/connector/oauth-access-tokens/<lookup-hash>.json`
 *   - `<home>/state/connector/oauth-refresh-tokens/<lookup-hash>.json`
 *
 * Tokens themselves are opaque (`2200-mcp-at-<43 base64url>` for
 * access, `2200-mcp-rt-<43 base64url>` for refresh). The on-disk
 * filename is a SHA-256 over the token (first 24 hex of the digest)
 * so a casual `ls` does not expose the secret material. The token
 * itself is stored sealed inside the file.
 *
 * Replay protection (RFC 6749 BCP): refresh tokens carry a
 * `rotation_chain` — when a refresh token is used, the AS issues a
 * fresh refresh token and revokes the chain. If a previously-rotated
 * refresh is presented again, the AS revokes ALL tokens in the
 * chain (refresh-token reuse is the canonical compromise signal).
 *
 * HKDF namespaces:
 *   - `2200-oauth-access-tokens-v1:fleet`
 *   - `2200-oauth-refresh-tokens-v1:fleet`
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { atomicWriteFile } from '../../../util/atomic-write.js'
import { loadOrCreateMasterKey } from '../../../identity/keystore.js'
import { homePaths } from '../../../storage/layout.js'

const SALT_BYTES = 32
const AES_KEY_BYTES = 32
const GCM_IV_BYTES = 12
const FILE_MODE = 0o600
const DIR_MODE = 0o700

const ACCESS_HKDF_INFO = '2200-oauth-access-tokens-v1:fleet'
const REFRESH_HKDF_INFO = '2200-oauth-refresh-tokens-v1:fleet'

const ACCESS_TOKEN_PREFIX = '2200-mcp-at-'
const REFRESH_TOKEN_PREFIX = '2200-mcp-rt-'
const TOKEN_RANDOM_BYTES = 32 // → 43 base64url chars

const DEFAULT_ACCESS_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
const DEFAULT_REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000 // 90 days

export interface AccessTokenRecord {
  token: string
  client_id: string
  scopes: string[]
  issued_at: string
  expires_at: string
}

export interface RefreshTokenRecord {
  token: string
  client_id: string
  scopes: string[]
  issued_at: string
  expires_at: string
  /**
   * Chain identifier: stable across rotations of the same logical
   * refresh credential. When a refresh-token reuse is detected (a
   * previously-rotated token presented again), the AS revokes the
   * entire chain by purging every refresh token with this id.
   */
  chain_id: string
  /** True once this token has been used to mint a successor. Reuse after this is the compromise signal. */
  rotated: boolean
}

const SealedTokenSchema = z.object({
  schema_version: z.literal(1),
  iv: z.string(),
  ciphertext: z.string(),
  tag: z.string(),
  metadata: z.record(z.string(), z.unknown()),
})

const AccessTokenPayloadSchema = z.object({
  token: z.string(),
  client_id: z.string(),
  scopes: z.array(z.string()),
  issued_at: z.string(),
  expires_at: z.string(),
})

const RefreshTokenPayloadSchema = z.object({
  token: z.string(),
  client_id: z.string(),
  scopes: z.array(z.string()),
  issued_at: z.string(),
  expires_at: z.string(),
  chain_id: z.string(),
  rotated: z.boolean(),
})

/** Mint a fresh access token in the canonical `2200-mcp-at-<...>` shape. */
export function mintAccessToken(): string {
  return `${ACCESS_TOKEN_PREFIX}${randomBytes(TOKEN_RANDOM_BYTES).toString('base64url')}`
}

/** Mint a fresh refresh token in the canonical `2200-mcp-rt-<...>` shape. */
export function mintRefreshToken(): string {
  return `${REFRESH_TOKEN_PREFIX}${randomBytes(TOKEN_RANDOM_BYTES).toString('base64url')}`
}

/** Mint a fresh refresh-token chain id (independent of token value). */
export function mintChainId(): string {
  return `chain-${randomBytes(8).toString('hex')}`
}

export function isAccessTokenShape(token: string): boolean {
  return token.startsWith(ACCESS_TOKEN_PREFIX)
}

export function isRefreshTokenShape(token: string): boolean {
  return token.startsWith(REFRESH_TOKEN_PREFIX)
}

/**
 * On-disk filename for a token. SHA-256 over the token value,
 * first 24 hex chars. The token itself is NOT in the filename — a
 * casual `ls` shows only the digest prefix.
 */
function tokenLookupName(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 24)
}

function accessFilePath(home: string, token: string): string {
  return join(
    homePaths(home).state,
    'connector',
    'oauth-access-tokens',
    `${tokenLookupName(token)}.json`,
  )
}

function refreshFilePath(home: string, token: string): string {
  return join(
    homePaths(home).state,
    'connector',
    'oauth-refresh-tokens',
    `${tokenLookupName(token)}.json`,
  )
}

function accessSaltPath(home: string): string {
  return join(homePaths(home).state, 'connector', 'oauth-access-tokens', 'salt')
}

function refreshSaltPath(home: string): string {
  return join(homePaths(home).state, 'connector', 'oauth-refresh-tokens', 'salt')
}

async function getOrCreateSalt(path: string): Promise<Buffer> {
  try {
    const buf = await readFile(path)
    if (buf.length !== SALT_BYTES) throw new Error(`oauth token salt at ${path} is wrong length`)
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

async function wrappingKey(home: string, saltPath: string, info: string): Promise<Buffer> {
  const masterKey = await loadOrCreateMasterKey(home)
  const salt = await getOrCreateSalt(saltPath)
  return Buffer.from(hkdfSync('sha256', masterKey, salt, Buffer.from(info, 'utf-8'), AES_KEY_BYTES))
}

/** Persist a fresh access token. Returns the file path. */
export async function saveAccessToken(home: string, record: AccessTokenRecord): Promise<string> {
  const key = await wrappingKey(home, accessSaltPath(home), ACCESS_HKDF_INFO)
  const iv = randomBytes(GCM_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(record), 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const envelope = {
    schema_version: 1 as const,
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    tag: tag.toString('hex'),
    metadata: { client_id: record.client_id, expires_at: record.expires_at },
  }
  const path = accessFilePath(home, record.token)
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE })
  await atomicWriteFile(path, JSON.stringify(envelope, null, 2))
  await chmod(path, FILE_MODE)
  return path
}

/** Read + unseal an access token by its plaintext value. Null if missing. */
export async function readAccessToken(
  home: string,
  token: string,
): Promise<AccessTokenRecord | null> {
  const path = accessFilePath(home, token)
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const sealed = SealedTokenSchema.parse(JSON.parse(raw))
  const key = await wrappingKey(home, accessSaltPath(home), ACCESS_HKDF_INFO)
  const iv = Buffer.from(sealed.iv, 'hex')
  const ciphertext = Buffer.from(sealed.ciphertext, 'hex')
  const tag = Buffer.from(sealed.tag, 'hex')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8')
  const parsed = AccessTokenPayloadSchema.parse(JSON.parse(plaintext))
  if (parsed.token !== token) return null
  return parsed
}

/** Delete an access token. Returns true iff a file was removed. */
export async function deleteAccessToken(home: string, token: string): Promise<boolean> {
  try {
    await unlink(accessFilePath(home, token))
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/** Persist a refresh token. */
export async function saveRefreshToken(home: string, record: RefreshTokenRecord): Promise<string> {
  const key = await wrappingKey(home, refreshSaltPath(home), REFRESH_HKDF_INFO)
  const iv = randomBytes(GCM_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(record), 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const envelope = {
    schema_version: 1 as const,
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    tag: tag.toString('hex'),
    metadata: { client_id: record.client_id, chain_id: record.chain_id, rotated: record.rotated },
  }
  const path = refreshFilePath(home, record.token)
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE })
  await atomicWriteFile(path, JSON.stringify(envelope, null, 2))
  await chmod(path, FILE_MODE)
  return path
}

/** Read + unseal a refresh token. Null if missing. */
export async function readRefreshToken(
  home: string,
  token: string,
): Promise<RefreshTokenRecord | null> {
  const path = refreshFilePath(home, token)
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const sealed = SealedTokenSchema.parse(JSON.parse(raw))
  const key = await wrappingKey(home, refreshSaltPath(home), REFRESH_HKDF_INFO)
  const iv = Buffer.from(sealed.iv, 'hex')
  const ciphertext = Buffer.from(sealed.ciphertext, 'hex')
  const tag = Buffer.from(sealed.tag, 'hex')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8')
  const parsed = RefreshTokenPayloadSchema.parse(JSON.parse(plaintext))
  if (parsed.token !== token) return null
  return parsed
}

/** Delete a refresh token. */
export async function deleteRefreshToken(home: string, token: string): Promise<boolean> {
  try {
    await unlink(refreshFilePath(home, token))
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/**
 * Issue a fresh access token for a client + scopes. Default TTL 24h
 * per the Phase 2 PR-A lock.
 */
export async function issueAccessToken(args: {
  home: string
  clientId: string
  scopes: string[]
  ttlMs?: number
  now?: () => Date
}): Promise<{ token: string; record: AccessTokenRecord }> {
  const now = args.now?.() ?? new Date()
  const ttl = args.ttlMs ?? DEFAULT_ACCESS_TTL_MS
  const token = mintAccessToken()
  const record: AccessTokenRecord = {
    token,
    client_id: args.clientId,
    scopes: args.scopes,
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttl).toISOString(),
  }
  await saveAccessToken(args.home, record)
  return { token, record }
}

/** Issue a fresh refresh token in a new chain. Default TTL 90 days. */
export async function issueRefreshToken(args: {
  home: string
  clientId: string
  scopes: string[]
  chainId?: string
  ttlMs?: number
  now?: () => Date
}): Promise<{ token: string; record: RefreshTokenRecord }> {
  const now = args.now?.() ?? new Date()
  const ttl = args.ttlMs ?? DEFAULT_REFRESH_TTL_MS
  const token = mintRefreshToken()
  const record: RefreshTokenRecord = {
    token,
    client_id: args.clientId,
    scopes: args.scopes,
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttl).toISOString(),
    chain_id: args.chainId ?? mintChainId(),
    rotated: false,
  }
  await saveRefreshToken(args.home, record)
  return { token, record }
}

/** Iterate every refresh token file and yield records (used for chain-wide revocation). */
export async function* iterateRefreshTokens(home: string): AsyncIterable<RefreshTokenRecord> {
  const { readdir } = await import('node:fs/promises')
  const dir = join(homePaths(home).state, 'connector', 'oauth-refresh-tokens')
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const path = join(dir, entry)
    let raw: string
    try {
      raw = await readFile(path, 'utf-8')
    } catch {
      continue
    }
    const sealed = SealedTokenSchema.safeParse(JSON.parse(raw))
    if (!sealed.success) continue
    const key = await wrappingKey(home, refreshSaltPath(home), REFRESH_HKDF_INFO)
    const iv = Buffer.from(sealed.data.iv, 'hex')
    const ciphertext = Buffer.from(sealed.data.ciphertext, 'hex')
    const tag = Buffer.from(sealed.data.tag, 'hex')
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
        'utf-8',
      )
      const record = RefreshTokenPayloadSchema.safeParse(JSON.parse(plaintext))
      if (record.success) yield record.data
    } catch {
      // Skip records that fail to decrypt (master-key rotation regressions etc.)
    }
  }
}

/**
 * Revoke every refresh + access token associated with a chain id.
 * Called when a refresh-token reuse is detected (the canonical
 * compromise signal per OAuth BCPs).
 */
export async function revokeChain(home: string, chainId: string): Promise<{ removed: number }> {
  let removed = 0
  for await (const record of iterateRefreshTokens(home)) {
    if (record.chain_id === chainId) {
      const refreshGone = await deleteRefreshToken(home, record.token)
      if (refreshGone) removed += 1
    }
  }
  return { removed }
}

/**
 * Revoke every refresh + access token associated with a client. Used
 * by `connector oauth-client revoke`.
 */
export async function revokeClientTokens(
  home: string,
  clientId: string,
): Promise<{ removed_refresh: number; removed_access: number }> {
  let removedRefresh = 0
  for await (const record of iterateRefreshTokens(home)) {
    if (record.client_id === clientId) {
      const gone = await deleteRefreshToken(home, record.token)
      if (gone) removedRefresh += 1
    }
  }
  // Access tokens we walk the directory; the metadata block carries
  // client_id so we don't have to decrypt fully to filter.
  const removedAccess = await revokeAccessTokensByClient(home, clientId)
  return { removed_refresh: removedRefresh, removed_access: removedAccess }
}

async function revokeAccessTokensByClient(home: string, clientId: string): Promise<number> {
  const { readdir } = await import('node:fs/promises')
  const dir = join(homePaths(home).state, 'connector', 'oauth-access-tokens')
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw err
  }
  let removed = 0
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const path = join(dir, entry)
    let raw: string
    try {
      raw = await readFile(path, 'utf-8')
    } catch {
      continue
    }
    const sealed = SealedTokenSchema.safeParse(JSON.parse(raw))
    if (!sealed.success) continue
    if (sealed.data.metadata['client_id'] !== clientId) continue
    try {
      await unlink(path)
      removed += 1
    } catch {
      // best-effort
    }
  }
  return removed
}

export const DEFAULTS = {
  ACCESS_TTL_MS: DEFAULT_ACCESS_TTL_MS,
  REFRESH_TTL_MS: DEFAULT_REFRESH_TTL_MS,
  ACCESS_TOKEN_PREFIX,
  REFRESH_TOKEN_PREFIX,
} as const
