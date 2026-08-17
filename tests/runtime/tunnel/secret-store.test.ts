/**
 * Sealed instance-secret store tests (Epic 19).
 *
 * Real filesystem + real master key. The point of this store is that the
 * secret is NOT plaintext on disk, so the strongest assertion is: the sealed
 * file does not contain the secret value, and a round-trip recovers it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  saveInstanceSecret,
  readInstanceSecret,
  hasInstanceSecret,
  deleteInstanceSecret,
  instanceSecretPath,
} from '../../../src/runtime/tunnel/secret-store.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-secret-store-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

const SECRET = 'br0ker-1nstall-s3cret-do-not-leak'

describe('instance secret store', () => {
  it('round-trips a secret', async () => {
    await saveInstanceSecret(home, 'broker-install-secret', SECRET)
    expect(await readInstanceSecret(home, 'broker-install-secret')).toBe(SECRET)
  })

  it('seals the value ... plaintext is NOT on disk', async () => {
    await saveInstanceSecret(home, 'broker-install-secret', SECRET)
    const raw = await readFile(instanceSecretPath(home, 'broker-install-secret'), 'utf-8')
    expect(raw).not.toContain(SECRET)
    // It's a sealed envelope, not the bare value.
    expect(JSON.parse(raw)).toMatchObject({ schema_version: 1, key: 'broker-install-secret' })
  })

  it('writes the file 0600', async () => {
    await saveInstanceSecret(home, 'broker-install-secret', SECRET)
    const st = await stat(instanceSecretPath(home, 'broker-install-secret'))
    expect(st.mode & 0o777).toBe(0o600)
  })

  it('returns null for a missing key', async () => {
    expect(await readInstanceSecret(home, 'nope')).toBeNull()
    expect(await hasInstanceSecret(home, 'nope')).toBe(false)
  })

  it('overwrites a prior value', async () => {
    await saveInstanceSecret(home, 'k', 'first')
    await saveInstanceSecret(home, 'k', 'second')
    expect(await readInstanceSecret(home, 'k')).toBe('second')
  })

  it('deletes a secret', async () => {
    await saveInstanceSecret(home, 'k', 'v')
    expect(await deleteInstanceSecret(home, 'k')).toBe(true)
    expect(await hasInstanceSecret(home, 'k')).toBe(false)
    expect(await deleteInstanceSecret(home, 'k')).toBe(false)
  })

  it('rejects an unsafe key (no directory traversal)', async () => {
    await expect(saveInstanceSecret(home, '../escape', 'v')).rejects.toThrow(/invalid/)
    expect(() => instanceSecretPath(home, 'a/b')).toThrow(/invalid/)
  })

  it('fails loud on a tampered ciphertext rather than returning garbage', async () => {
    await saveInstanceSecret(home, 'k', SECRET)
    const path = instanceSecretPath(home, 'k')
    const env = JSON.parse(await readFile(path, 'utf-8')) as { ciphertext: string }
    // Flip a byte in the ciphertext; the GCM auth tag must reject it.
    const flipped = env.ciphertext.slice(0, -2) + (env.ciphertext.endsWith('00') ? 'ff' : '00')
    await writeFile(path, JSON.stringify({ ...env, ciphertext: flipped }))
    await expect(readInstanceSecret(home, 'k')).rejects.toThrow()
  })
})
