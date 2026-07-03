/**
 * Sealed instance-secret store (Epic 19).
 *
 * Fleet/instance-scoped secrets that aren't per-Agent and aren't OAuth tokens:
 * the tunnel broker's install secret and the provisioned tunnel token. One
 * sealed JSON file per key at `<home>/state/secrets/<key>.json`, using the same
 * AES-256-GCM + HKDF-from-master-key primitives as the OAuth token store, so
 * nothing sits in plaintext on disk (files 0600, dir 0700). The plaintext is a
 * single opaque string ... the caller decides what it means.
 *
 * Keys are validated to a safe filename charset so a key can't escape the
 * secrets dir. HKDF domain-separated from the OAuth store via a distinct info
 * string and its own salt.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, stat, chmod, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { atomicWriteFile } from '../util/atomic-write.js'
import { loadOrCreateMasterKey } from '../identity/keystore.js'
import { homePaths } from '../storage/layout.js'

const SALT_BYTES = 32
const AES_KEY_BYTES = 32
const GCM_IV_BYTES = 12
const HKDF_INFO = '2200-instance-secrets-v1:fleet'
const FILE_MODE = 0o600
const DIR_MODE = 0o700

/** Keys map to filenames, so keep them to a safe, predictable charset. */
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

const SealedSecretSchema = z.object({
  schema_version: z.literal(1),
  key: z.string(),
  iv: z.string(),
  ciphertext: z.string(),
  tag: z.string(),
})

function assertKey(key: string): void {
  if (!KEY_RE.test(key)) {
    throw new Error(
      `invalid instance-secret key "${key}": must match ${String(KEY_RE)} (lowercase letters, digits, dashes)`,
    )
  }
}

function secretsDir(home: string): string {
  return join(homePaths(home).state, 'secrets')
}

/** Path to the sealed file for a key. */
export function instanceSecretPath(home: string, key: string): string {
  assertKey(key)
  return join(secretsDir(home), `${key}.json`)
}

function saltPath(home: string): string {
  return join(secretsDir(home), 'salt')
}

async function getOrCreateSalt(home: string): Promise<Buffer> {
  const path = saltPath(home)
  try {
    const buf = await readFile(path)
    if (buf.length !== SALT_BYTES)
      throw new Error(`instance-secret salt at ${path} is wrong length`)
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

async function getWrappingKey(home: string): Promise<Buffer> {
  const masterKey = await loadOrCreateMasterKey(home)
  const salt = await getOrCreateSalt(home)
  return Buffer.from(
    hkdfSync('sha256', masterKey, salt, Buffer.from(HKDF_INFO, 'utf-8'), AES_KEY_BYTES),
  )
}

/** Seal + persist a secret string under `key`. Overwrites any prior value. */
export async function saveInstanceSecret(home: string, key: string, value: string): Promise<void> {
  assertKey(key)
  const wrappingKey = await getWrappingKey(home)
  const iv = randomBytes(GCM_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', wrappingKey, iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const envelope: z.infer<typeof SealedSecretSchema> = {
    schema_version: 1,
    key,
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    tag: tag.toString('hex'),
  }
  const path = instanceSecretPath(home, key)
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE })
  await atomicWriteFile(path, JSON.stringify(envelope, null, 2))
  await chmod(path, FILE_MODE)
}

/** Read + unseal a secret. Returns null if no file exists. */
export async function readInstanceSecret(home: string, key: string): Promise<string | null> {
  const path = instanceSecretPath(home, key)
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const parsed = SealedSecretSchema.parse(JSON.parse(raw))
  if (parsed.key !== key) {
    throw new Error(`instance-secret file at ${path} has key="${parsed.key}" but expected "${key}"`)
  }
  const wrappingKey = await getWrappingKey(home)
  const decipher = createDecipheriv('aes-256-gcm', wrappingKey, Buffer.from(parsed.iv, 'hex'))
  decipher.setAuthTag(Buffer.from(parsed.tag, 'hex'))
  return Buffer.concat([
    decipher.update(Buffer.from(parsed.ciphertext, 'hex')),
    decipher.final(),
  ]).toString('utf-8')
}

/** List the stored secret KEYS (names only, never values). Excludes the salt. */
export async function listInstanceSecretKeys(home: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(secretsDir(home))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  return entries
    .filter((e) => e.endsWith('.json'))
    .map((e) => e.slice(0, -'.json'.length))
    .sort()
}

export async function hasInstanceSecret(home: string, key: string): Promise<boolean> {
  try {
    await stat(instanceSecretPath(home, key))
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

export async function deleteInstanceSecret(home: string, key: string): Promise<boolean> {
  try {
    await unlink(instanceSecretPath(home, key))
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}
