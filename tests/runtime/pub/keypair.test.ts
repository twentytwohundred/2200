/**
 * Tests for the Ed25519 keypair / credential file module.
 *
 * Pins the wire-shape (base64url scalars), the file mode (0600), the
 * round-trip through writeCredentialFile + readCredentialFile, and the
 * sign/verify path that backs the auth handshake.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPublicKey, verify } from 'node:crypto'
import {
  composeAuthMessage,
  generateKeypair,
  isCredentialFileMode0600,
  readCredentialFile,
  signMessage,
  writeCredentialFile,
  type PubCredential,
} from '../../../src/runtime/pub/keypair.js'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), '2200-keypair-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('generateKeypair', () => {
  it('produces base64url private and public keys', () => {
    const cred = generateKeypair({ display_name: 'hobby', issuer_url: 'local://localhost' })
    expect(cred.private_key).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(cred.public_key).toMatch(/^[A-Za-z0-9_-]+$/)
    // base64url-encoded 32-byte Ed25519 scalars are 43 chars (no padding).
    expect(cred.private_key.length).toBe(43)
    expect(cred.public_key.length).toBe(43)
  })

  it('starts with key_version=1 and agent_id=null', () => {
    const cred = generateKeypair({ display_name: 'hobby', issuer_url: 'local://x' })
    expect(cred.key_version).toBe(1)
    expect(cred.agent_id).toBeNull()
  })

  it('preserves display_name and issuer_url verbatim', () => {
    const cred = generateKeypair({
      display_name: 'Carl Monday',
      issuer_url: 'https://openpub.ai',
    })
    expect(cred.display_name).toBe('Carl Monday')
    expect(cred.issuer_url).toBe('https://openpub.ai')
  })

  it('two calls produce distinct keypairs', () => {
    const a = generateKeypair({ display_name: 'a', issuer_url: 'local://x' })
    const b = generateKeypair({ display_name: 'b', issuer_url: 'local://x' })
    expect(a.private_key).not.toBe(b.private_key)
    expect(a.public_key).not.toBe(b.public_key)
  })
})

describe('writeCredentialFile + readCredentialFile', () => {
  it('round-trips a credential record', async () => {
    const cred = generateKeypair({ display_name: 'hobby', issuer_url: 'local://x' })
    const path = join(tmp, 'pub.secret')
    await writeCredentialFile(path, cred)
    const reloaded = await readCredentialFile(path)
    expect(reloaded).toEqual(cred)
  })

  it('persists agent_id when set', async () => {
    const cred: PubCredential = {
      ...generateKeypair({ display_name: 'hobby', issuer_url: 'local://x' }),
      agent_id: '01919c4f-7e3a-7000-8000-d4a984f2c1b3',
    }
    const path = join(tmp, 'pub.secret')
    await writeCredentialFile(path, cred)
    const reloaded = await readCredentialFile(path)
    expect(reloaded.agent_id).toBe(cred.agent_id)
  })

  it('writes the file at mode 0600 on POSIX', async () => {
    const cred = generateKeypair({ display_name: 'hobby', issuer_url: 'local://x' })
    const path = join(tmp, 'pub.secret')
    await writeCredentialFile(path, cred)
    expect(await isCredentialFileMode0600(path)).toBe(true)
  })

  it('does NOT include the private key bytes in parse-error messages', async () => {
    const path = join(tmp, 'pub.secret')
    // Write garbage and try to parse.
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, '{not json', 'utf8')
    let captured = ''
    try {
      await readCredentialFile(path)
    } catch (err) {
      captured = err instanceof Error ? err.message : String(err)
    }
    expect(captured).toContain('not valid JSON')
    // The error message should NOT contain the file content (defense
    // against a future file that has a real private key in it
    // alongside a stray syntax error).
    expect(captured).not.toContain('not json')
  })

  it('rejects a credential file missing required fields', async () => {
    const path = join(tmp, 'pub.secret')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, JSON.stringify({ public_key: 'x', display_name: 'h' }), 'utf8')
    await expect(readCredentialFile(path)).rejects.toThrow(/missing required fields/)
  })

  it('rejects a credential file with wrong field types', async () => {
    const path = join(tmp, 'pub.secret')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      path,
      JSON.stringify({
        agent_id: null,
        private_key: 'x',
        public_key: 'y',
        key_version: 'not-a-number',
        display_name: 'h',
        issuer_url: 'local://x',
      }),
      'utf8',
    )
    await expect(readCredentialFile(path)).rejects.toThrow(/wrong field types/)
  })
})

describe('signMessage', () => {
  it('produces a signature verifiable with the public key', () => {
    const cred = generateKeypair({ display_name: 'hobby', issuer_url: 'local://x' })
    const message = composeAuthMessage(
      '01919c4f-7e3a-7000-8000-d4a984f2c1b3',
      '2026-04-26T18:00:00.000Z',
    )
    const signatureB64u = signMessage(cred, message)
    expect(signatureB64u).toMatch(/^[A-Za-z0-9_-]+$/)
    // Verify with the public key.
    const pubKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: cred.public_key },
      format: 'jwk',
    })
    const ok = verify(
      null,
      Buffer.from(message, 'utf8'),
      pubKey,
      Buffer.from(signatureB64u, 'base64url'),
    )
    expect(ok).toBe(true)
  })

  it('signature differs by message', () => {
    const cred = generateKeypair({ display_name: 'hobby', issuer_url: 'local://x' })
    const a = signMessage(cred, 'message-a')
    const b = signMessage(cred, 'message-b')
    expect(a).not.toBe(b)
  })

  it('different keys produce different signatures for the same message', () => {
    const credA = generateKeypair({ display_name: 'a', issuer_url: 'local://x' })
    const credB = generateKeypair({ display_name: 'b', issuer_url: 'local://x' })
    const sigA = signMessage(credA, 'same')
    const sigB = signMessage(credB, 'same')
    expect(sigA).not.toBe(sigB)
  })
})

describe('composeAuthMessage', () => {
  it('joins agent_id and timestamp with a colon (matches Poe contract)', () => {
    expect(composeAuthMessage('a', 't')).toBe('a:t')
  })
})

describe('round-trip into a real Node KeyObject', () => {
  it('persisted public_key re-imports cleanly', async () => {
    const cred = generateKeypair({ display_name: 'hobby', issuer_url: 'local://x' })
    const path = join(tmp, 'pub.secret')
    await writeCredentialFile(path, cred)
    const reloaded = await readCredentialFile(path)
    const pubKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: reloaded.public_key },
      format: 'jwk',
    })
    expect(pubKey.asymmetricKeyType).toBe('ed25519')
  })
})

describe('mode check sanity', () => {
  it('a file we deliberately set to 0644 reports false', async () => {
    const path = join(tmp, 'plain.json')
    const { writeFile, chmod } = await import('node:fs/promises')
    await writeFile(path, '{}', 'utf8')
    await chmod(path, 0o644)
    if (process.platform !== 'win32') {
      expect(await isCredentialFileMode0600(path)).toBe(false)
    }
  })

  it('post-write the credential file is exactly mode 0600', async () => {
    const cred = generateKeypair({ display_name: 'h', issuer_url: 'local://x' })
    const path = join(tmp, 'cred.json')
    await writeCredentialFile(path, cred)
    if (process.platform !== 'win32') {
      const { stat } = await import('node:fs/promises')
      const s = await stat(path)
      expect(s.mode & 0o777).toBe(0o600)
      // Also: confirm the file content matches the JSON we wrote.
      const raw = await readFile(path, 'utf8')
      expect(JSON.parse(raw)).toEqual(cred)
    }
  })
})
