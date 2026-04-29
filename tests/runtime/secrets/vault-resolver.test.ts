import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CredentialVault } from '../../../src/runtime/credentials/vault.js'
import { resolveSecret, SecretResolveError } from '../../../src/runtime/secrets/resolver.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-vault-resolve-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('resolveSecret(vault)', () => {
  it('resolves a bare id against the default Agent vault', async () => {
    const vault = new CredentialVault(home, 'hobby')
    await vault.set('github-token', {
      value: 'ghp_test123',
      metadata: { created_at: '2026-04-29T00:00:00.000Z' },
    })
    const got = await resolveSecret(
      { source: 'vault', id: 'github-token' },
      { home, agentName: 'hobby' },
    )
    expect(got).toBe('ghp_test123')
  })

  it('resolves a prefixed id against the named Agent vault', async () => {
    const sa = new CredentialVault(home, 'simon')
    await sa.set('ops-token', {
      value: 'opstoken-xyz',
      metadata: { created_at: '2026-04-29T00:00:00.000Z' },
    })
    const got = await resolveSecret(
      { source: 'vault', id: 'simon:ops-token' },
      { home, agentName: 'hobby' }, // default agent is hobby; prefix overrides
    )
    expect(got).toBe('opstoken-xyz')
  })

  it('throws VAULT_MISCONFIGURED when no context is provided', async () => {
    try {
      await resolveSecret({ source: 'vault', id: 'token' })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(SecretResolveError)
      expect((err as SecretResolveError).code).toBe('VAULT_MISCONFIGURED')
    }
  })

  it('throws VAULT_MISCONFIGURED when bare id has no default agent', async () => {
    try {
      await resolveSecret({ source: 'vault', id: 'token' }, { home })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(SecretResolveError)
      expect((err as SecretResolveError).code).toBe('VAULT_MISCONFIGURED')
    }
  })

  it('throws VAULT_MISCONFIGURED on a malformed id', async () => {
    try {
      await resolveSecret({ source: 'vault', id: ':missing-agent' }, { home, agentName: 'hobby' })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(SecretResolveError)
      expect((err as SecretResolveError).code).toBe('VAULT_MISCONFIGURED')
    }
  })

  it('throws VAULT_MISS when the credential does not exist', async () => {
    try {
      await resolveSecret({ source: 'vault', id: 'never-set' }, { home, agentName: 'hobby' })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(SecretResolveError)
      expect((err as SecretResolveError).code).toBe('VAULT_MISS')
    }
  })

  it('still resolves env + file refs without context', async () => {
    process.env['__2200_VAULT_TEST_VAR__'] = 'envvalue'
    try {
      const got = await resolveSecret({ source: 'env', id: '__2200_VAULT_TEST_VAR__' })
      expect(got).toBe('envvalue')
    } finally {
      delete process.env['__2200_VAULT_TEST_VAR__']
    }
  })
})
