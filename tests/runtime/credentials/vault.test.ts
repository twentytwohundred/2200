import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CredentialVault } from '../../../src/runtime/credentials/vault.js'
import { CredentialVaultError } from '../../../src/runtime/credentials/types.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-cred-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('CredentialVault', () => {
  it('round-trips a credential value + metadata', async () => {
    const vault = new CredentialVault(home, 'hobby')
    const ts = '2026-04-29T20:00:00.000Z'
    await vault.set('github-token', {
      value: 'ghp_supersecret_xyz123',
      metadata: { created_at: ts, provider: 'github', scopes: ['repo', 'read:org'] },
    })
    const got = await vault.get('github-token')
    expect(got.value).toBe('ghp_supersecret_xyz123')
    expect(got.metadata.created_at).toBe(ts)
    expect(got.metadata.provider).toBe('github')
    expect(got.metadata.scopes).toEqual(['repo', 'read:org'])
  })

  it('isolates per-Agent vaults', async () => {
    const a = new CredentialVault(home, 'hobby')
    const b = new CredentialVault(home, 'simon')
    await a.set('shared-name', {
      value: 'hobbys-secret',
      metadata: { created_at: '2026-04-29T00:00:00.000Z' },
    })
    await b.set('shared-name', {
      value: 'simons-secret',
      metadata: { created_at: '2026-04-29T00:00:00.000Z' },
    })
    const aGot = await a.get('shared-name')
    const bGot = await b.get('shared-name')
    expect(aGot.value).toBe('hobbys-secret')
    expect(bGot.value).toBe('simons-secret')
  })

  it('list returns names + metadata without revealing values', async () => {
    const vault = new CredentialVault(home, 'hobby')
    await vault.set('alpha', {
      value: 'A',
      metadata: { created_at: '2026-04-29T00:00:00.000Z', provider: 'a' },
    })
    await vault.set('beta', {
      value: 'B',
      metadata: { created_at: '2026-04-29T00:01:00.000Z', provider: 'b' },
    })
    const list = await vault.list()
    expect(list.map((e) => e.name).sort()).toEqual(['alpha', 'beta'])
    expect(list.find((e) => e.name === 'alpha')?.metadata.provider).toBe('a')
    // No 'value' field on a list entry — typed away.
  })

  it('has() returns true for present, false for absent', async () => {
    const vault = new CredentialVault(home, 'hobby')
    expect(await vault.has('absent')).toBe(false)
    await vault.set('present', {
      value: 'x',
      metadata: { created_at: '2026-04-29T00:00:00.000Z' },
    })
    expect(await vault.has('present')).toBe(true)
  })

  it('delete is idempotent', async () => {
    const vault = new CredentialVault(home, 'hobby')
    await vault.set('to-be-deleted', {
      value: 'x',
      metadata: { created_at: '2026-04-29T00:00:00.000Z' },
    })
    expect(await vault.delete('to-be-deleted')).toBe(true)
    expect(await vault.delete('to-be-deleted')).toBe(false)
    expect(await vault.has('to-be-deleted')).toBe(false)
  })

  it('rejects invalid credential names', async () => {
    const vault = new CredentialVault(home, 'hobby')
    await expect(
      vault.set('BadName', {
        value: 'x',
        metadata: { created_at: '2026-04-29T00:00:00.000Z' },
      }),
    ).rejects.toBeInstanceOf(CredentialVaultError)
    await expect(
      vault.set('has spaces', {
        value: 'x',
        metadata: { created_at: '2026-04-29T00:00:00.000Z' },
      }),
    ).rejects.toBeInstanceOf(CredentialVaultError)
  })

  it('throws NOT_FOUND when reading a missing credential', async () => {
    const vault = new CredentialVault(home, 'hobby')
    try {
      await vault.get('not-there')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialVaultError)
      expect((err as CredentialVaultError).code).toBe('NOT_FOUND')
    }
  })

  it('detects tampering via the GCM tag', async () => {
    const vault = new CredentialVault(home, 'hobby')
    await vault.set('victim', {
      value: 'real-value',
      metadata: { created_at: '2026-04-29T00:00:00.000Z' },
    })
    // Mutate the ciphertext byte-for-byte by flipping a hex digit.
    const path = join(home, 'state', 'credentials', 'hobby', 'victim.json')
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw) as { ciphertext: string }
    const orig = parsed.ciphertext
    const flipped = orig.slice(0, -2) + (orig.endsWith('00') ? '01' : '00')
    parsed.ciphertext = flipped
    await writeFile(path, JSON.stringify(parsed), 'utf-8')

    try {
      await vault.get('victim')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialVaultError)
      expect((err as CredentialVaultError).code).toBe('TAMPERED')
    }
  })

  it('overwrites on second set with the same name', async () => {
    const vault = new CredentialVault(home, 'hobby')
    await vault.set('rotates', {
      value: 'first',
      metadata: { created_at: '2026-04-29T00:00:00.000Z' },
    })
    await vault.set('rotates', {
      value: 'second',
      metadata: { created_at: '2026-04-29T00:01:00.000Z' },
    })
    const got = await vault.get('rotates')
    expect(got.value).toBe('second')
    expect(got.metadata.created_at).toBe('2026-04-29T00:01:00.000Z')
  })
})
