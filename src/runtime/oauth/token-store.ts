/**
 * Fleet-scoped sealed OAuth token store.
 *
 * The per-Agent CredentialVault (`runtime/credentials/vault.ts`) is
 * exactly the wrong shape for an OAuth subscription bearer: a
 * SuperGrok subscription belongs to the operator, not to any one
 * Agent, and refresh writes need a single canonical location ... not
 * N copies in N per-Agent vaults that can drift.
 *
 * This store sits at the home level. One sealed JSON file per OAuth
 * provider at `<home>/state/oauth-tokens/<provider>.json`, sealed with
 * the same AES-256-GCM + HKDF primitives the per-Agent vault uses, but
 * keyed by a fleet-scoped HKDF info string so a per-Agent salt
 * compromise does not cross into this namespace and vice versa.
 *
 * The persisted shape includes the refresh token, expiry timestamp,
 * scope grant, and a `provider` discriminant so a future provider's
 * tokens can land here without colliding.
 *
 * See wiki/decisions/2026-05-21-xai-grok-oauth.md.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { mkdir, readFile, stat, writeFile, chmod, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { atomicWriteFile } from '../util/atomic-write.js'
import { loadOrCreateMasterKey } from '../identity/keystore.js'
import { homePaths } from '../storage/layout.js'

const SALT_BYTES = 32
const AES_KEY_BYTES = 32
const GCM_IV_BYTES = 12
const HKDF_INFO = '2200-oauth-tokens-v1:fleet'
const FILE_MODE = 0o600
const DIR_MODE = 0o700

const SealedOAuthTokenSchema = z.object({
  schema_version: z.literal(1),
  provider: z.string(),
  iv: z.string(),
  ciphertext: z.string(),
  tag: z.string(),
  /** Public metadata; NOT secret. */
  metadata: z.object({
    /** Identifier for the upstream account (e.g. xAI `sub` claim). Optional. */
    subject: z.string().optional(),
    /** Scopes the provider granted. */
    granted_scopes: z.array(z.string()).default([]),
    /** Unix ms when the bearer expires. Used by the refresh service. */
    expires_at_ms: z.number(),
    /** ISO8601 of when this record was created. */
    created_at: z.string(),
    /** ISO8601 of last successful refresh, if any. */
    refreshed_at: z.string().optional(),
  }),
})

export type SealedOAuthToken = z.infer<typeof SealedOAuthTokenSchema>

/** Plaintext token record. The `bearer` + `refresh_token` are secret. */
export interface OAuthTokenRecord {
  readonly provider: string
  readonly bearer: string
  readonly refreshToken: string
  readonly metadata: SealedOAuthToken['metadata']
}

/** Path to the sealed token file for the named provider. */
export function oauthTokenFilePath(home: string, provider: string): string {
  return join(homePaths(home).state, 'oauth-tokens', `${provider}.json`)
}

/** Path to the fleet salt that seeds the wrapping key. */
function oauthTokenSaltPath(home: string): string {
  return join(homePaths(home).state, 'oauth-tokens', 'salt')
}

/** Persist a token. Overwrites any prior record for the same provider. */
export async function saveOAuthToken(home: string, record: OAuthTokenRecord): Promise<void> {
  const wrappingKey = await getOrCreateWrappingKey(home)
  const payload = JSON.stringify({
    bearer: record.bearer,
    refresh_token: record.refreshToken,
  })
  const iv = randomBytes(GCM_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', wrappingKey, iv)
  const ciphertext = Buffer.concat([cipher.update(payload, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()

  const envelope: SealedOAuthToken = {
    schema_version: 1,
    provider: record.provider,
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    tag: tag.toString('hex'),
    metadata: record.metadata,
  }
  const path = oauthTokenFilePath(home, record.provider)
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE })
  await atomicWriteFile(path, JSON.stringify(envelope, null, 2))
  await chmod(path, FILE_MODE)
}

/** Read + unseal a token. Returns null if no file exists. */
export async function readOAuthToken(
  home: string,
  provider: string,
): Promise<OAuthTokenRecord | null> {
  const path = oauthTokenFilePath(home, provider)
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const parsed = SealedOAuthTokenSchema.parse(JSON.parse(raw))
  if (parsed.provider !== provider) {
    throw new Error(
      `oauth token file at ${path} has provider="${parsed.provider}" but expected "${provider}"`,
    )
  }
  const wrappingKey = await getOrCreateWrappingKey(home)
  const iv = Buffer.from(parsed.iv, 'hex')
  const ciphertext = Buffer.from(parsed.ciphertext, 'hex')
  const tag = Buffer.from(parsed.tag, 'hex')
  const decipher = createDecipheriv('aes-256-gcm', wrappingKey, iv)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8')
  const payload = JSON.parse(plaintext) as { bearer: string; refresh_token: string }
  return {
    provider,
    bearer: payload.bearer,
    refreshToken: payload.refresh_token,
    metadata: parsed.metadata,
  }
}

/** Returns true iff a token file exists for the named provider. */
export async function hasOAuthToken(home: string, provider: string): Promise<boolean> {
  try {
    await stat(oauthTokenFilePath(home, provider))
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/** Delete the token. Returns true if a file was removed. */
export async function deleteOAuthToken(home: string, provider: string): Promise<boolean> {
  try {
    await unlink(oauthTokenFilePath(home, provider))
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/** Lazy create + read of the fleet-wrapping HKDF salt. */
async function getOrCreateSalt(home: string): Promise<Buffer> {
  const path = oauthTokenSaltPath(home)
  try {
    const buf = await readFile(path)
    if (buf.length !== SALT_BYTES) {
      throw new Error(`oauth token salt at ${path} is wrong length`)
    }
    return buf
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE })
  const fresh = randomBytes(SALT_BYTES)
  await writeFile(path, fresh, { mode: FILE_MODE })
  await chmod(path, FILE_MODE)
  return fresh
}

async function getOrCreateWrappingKey(home: string): Promise<Buffer> {
  const masterKey = await loadOrCreateMasterKey(home)
  const salt = await getOrCreateSalt(home)
  const info = Buffer.from(HKDF_INFO, 'utf-8')
  return Buffer.from(hkdfSync('sha256', masterKey, salt, info, AES_KEY_BYTES))
}
