/**
 * CredentialVault: per-Agent encrypted credential storage (Epic 9 Phase B).
 *
 * Stores string secrets (bearer tokens, API keys, OAuth refresh
 * tokens) sealed with AES-256-GCM. Wrapping key is derived per-Agent
 * via HKDF from the per-instance master key + a per-Agent salt (in
 * a separate namespace from the SCUT keystore so a single salt
 * compromise does not cross subsystems).
 *
 * Layout per Agent:
 *   <home>/state/credentials/<agent>/
 *   ├── salt                              32 raw bytes, mode 0600
 *   └── <credential_name>.json            sealed envelope, mode 0600
 *
 * The vault is process-agnostic. The supervisor uses it at MCP server
 * spawn time to resolve SecretRefs of source 'vault'; the CLI uses
 * it for `2200 credential set / list / show / delete`. v1 reads the
 * master key directly from disk (same posture as the SCUT keystore;
 * known limitation per CLAUDE.md). Hardening to TPM / OS-keychain
 * is a post-launch item that lives at the keystore layer, not here.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, unlink, writeFile, chmod, stat } from 'node:fs/promises'
import {
  agentCredentialFilePath,
  agentCredentialPaths,
  agentCredentialsDir,
} from '../storage/layout.js'
import { atomicWriteFile } from '../util/atomic-write.js'
import { loadOrCreateMasterKey } from '../identity/keystore.js'
import {
  CredentialMetadataSchema,
  CREDENTIAL_NAME_RE,
  CredentialVaultError,
  SealedCredentialSchema,
  type CredentialMetadata,
  type PlaintextCredential,
  type SealedCredential,
} from './types.js'

const SALT_BYTES = 32
const AES_KEY_BYTES = 32
const GCM_IV_BYTES = 12
const HKDF_INFO_PREFIX = '2200-agent-credentials-v1:'
const FILE_MODE = 0o600
const DIR_MODE = 0o700

export interface VaultListEntry {
  name: string
  metadata: CredentialMetadata
}

export class CredentialVault {
  constructor(
    private readonly home: string,
    private readonly agentName: string,
  ) {}

  /** Resolve the vault root without touching disk. */
  dir(): string {
    return agentCredentialsDir(this.home, this.agentName)
  }

  /**
   * Persist a credential. Generates the per-Agent salt on first call;
   * subsequent calls reuse it. Idempotent on (name): a second write
   * to the same name overwrites.
   */
  async set(name: string, plaintext: PlaintextCredential): Promise<void> {
    assertName(name)
    const wrappingKey = await this.getOrCreateWrappingKey()
    const sealed = sealValue(plaintext.value, wrappingKey)
    const envelope: SealedCredential = {
      schema_version: 1,
      ...sealed,
      metadata: CredentialMetadataSchema.parse(plaintext.metadata),
    }
    const path = agentCredentialFilePath(this.home, this.agentName, name)
    await atomicWriteFile(path, JSON.stringify(envelope, null, 2))
    await chmod(path, FILE_MODE)
  }

  /** Read + unseal a credential by name. Throws if missing or tampered. */
  async get(name: string): Promise<PlaintextCredential> {
    assertName(name)
    const path = agentCredentialFilePath(this.home, this.agentName, name)
    let raw: string
    try {
      raw = await readFile(path, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new CredentialVaultError(`credential "${name}" does not exist`, 'NOT_FOUND')
      }
      throw new CredentialVaultError(
        `could not read credential "${name}": ${err instanceof Error ? err.message : String(err)}`,
        'IO_ERROR',
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw new CredentialVaultError(
        `credential "${name}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        'CORRUPT',
      )
    }
    const envelope = SealedCredentialSchema.safeParse(parsed)
    if (!envelope.success) {
      throw new CredentialVaultError(`credential "${name}" envelope is malformed`, 'CORRUPT')
    }
    const wrappingKey = await this.getOrCreateWrappingKey()
    let value: string
    try {
      value = unsealValue(envelope.data, wrappingKey)
    } catch {
      throw new CredentialVaultError(
        `credential "${name}" GCM tag mismatch (wrong master key, salt, or tampered file)`,
        'TAMPERED',
      )
    }
    return { value, metadata: envelope.data.metadata }
  }

  /** List entries in the vault with their plaintext metadata only. */
  async list(): Promise<VaultListEntry[]> {
    const root = this.dir()
    let entries: string[]
    try {
      entries = await readdir(root)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new CredentialVaultError(
        `could not list vault: ${err instanceof Error ? err.message : String(err)}`,
        'IO_ERROR',
      )
    }
    const out: VaultListEntry[] = []
    for (const file of entries.sort()) {
      if (!file.endsWith('.json')) continue
      const name = file.slice(0, -5)
      if (!CREDENTIAL_NAME_RE.test(name)) continue
      const path = agentCredentialFilePath(this.home, this.agentName, name)
      try {
        const raw = await readFile(path, 'utf-8')
        const parsed = SealedCredentialSchema.parse(JSON.parse(raw))
        out.push({ name, metadata: parsed.metadata })
      } catch {
        /* skip malformed entries; they still appear in delete */
      }
    }
    return out
  }

  /** True if a credential by that name is present. */
  async has(name: string): Promise<boolean> {
    assertName(name)
    try {
      await stat(agentCredentialFilePath(this.home, this.agentName, name))
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw err
    }
  }

  /** Delete a credential. Returns true if a file was removed. */
  async delete(name: string): Promise<boolean> {
    assertName(name)
    try {
      await unlink(agentCredentialFilePath(this.home, this.agentName, name))
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw err
    }
  }

  // -------------------------------------------------------------------------
  // Internal: salt + wrapping key.
  // -------------------------------------------------------------------------

  private async getOrCreateWrappingKey(): Promise<Buffer> {
    const masterKey = await loadOrCreateMasterKey(this.home)
    const salt = await this.getOrCreateSalt()
    const info = Buffer.from(`${HKDF_INFO_PREFIX}${this.agentName}`, 'utf-8')
    const derived = hkdfSync('sha256', masterKey, salt, info, AES_KEY_BYTES)
    return Buffer.from(derived)
  }

  private async getOrCreateSalt(): Promise<Buffer> {
    const paths = agentCredentialPaths(this.home, this.agentName)
    try {
      const buf = await readFile(paths.salt)
      if (buf.length !== SALT_BYTES) {
        throw new CredentialVaultError(`vault salt at ${paths.salt} is wrong length`, 'CORRUPT')
      }
      return buf
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    await mkdir(paths.root, { recursive: true, mode: DIR_MODE })
    const fresh = randomBytes(SALT_BYTES)
    await writeFile(paths.salt, fresh, { mode: FILE_MODE })
    await chmod(paths.salt, FILE_MODE)
    return fresh
  }
}

interface RawSealedFields {
  iv: string
  ciphertext: string
  tag: string
}

function sealValue(value: string, wrappingKey: Buffer): RawSealedFields {
  const iv = randomBytes(GCM_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', wrappingKey, iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    tag: tag.toString('hex'),
  }
}

function unsealValue(envelope: SealedCredential, wrappingKey: Buffer): string {
  const iv = Buffer.from(envelope.iv, 'hex')
  const ciphertext = Buffer.from(envelope.ciphertext, 'hex')
  const tag = Buffer.from(envelope.tag, 'hex')
  const decipher = createDecipheriv('aes-256-gcm', wrappingKey, iv)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plaintext.toString('utf-8')
}

function assertName(name: string): void {
  if (!CREDENTIAL_NAME_RE.test(name)) {
    throw new CredentialVaultError(
      `invalid credential name "${name}": must be a slug starting with a lowercase letter; lowercase + digits + dashes only`,
      'INVALID_NAME',
    )
  }
}
