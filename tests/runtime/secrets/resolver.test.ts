/**
 * Tests for the SecretRef resolver.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSecret, SecretResolveError } from '../../../src/runtime/secrets/resolver.js'

let dir: string
const ENV_KEY = 'TEST_2200_SECRET_RESOLVER'

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), '2200-secrets-'))
  Reflect.deleteProperty(process.env, ENV_KEY)
})

afterEach(async () => {
  Reflect.deleteProperty(process.env, ENV_KEY)
  await rm(dir, { recursive: true, force: true })
})

describe('resolveSecret env source', () => {
  it('resolves a set env var', async () => {
    process.env[ENV_KEY] = 'sk-secret'
    const value = await resolveSecret({ source: 'env', id: ENV_KEY })
    expect(value).toBe('sk-secret')
  })

  it('trims whitespace from env values', async () => {
    process.env[ENV_KEY] = '  sk-secret\n'
    const value = await resolveSecret({ source: 'env', id: ENV_KEY })
    expect(value).toBe('sk-secret')
  })

  it('throws SecretResolveError(ENV_MISSING) when the var is not set', async () => {
    await expect(resolveSecret({ source: 'env', id: ENV_KEY })).rejects.toMatchObject({
      name: 'SecretResolveError',
      code: 'ENV_MISSING',
    })
  })

  it('throws SecretResolveError(EMPTY_VALUE) on empty/whitespace env value', async () => {
    process.env[ENV_KEY] = '   '
    await expect(resolveSecret({ source: 'env', id: ENV_KEY })).rejects.toMatchObject({
      code: 'EMPTY_VALUE',
    })
  })
})

describe('resolveSecret file source', () => {
  it('resolves a file', async () => {
    const path = join(dir, 'key.txt')
    await writeFile(path, 'sk-from-file\n')
    const value = await resolveSecret({ source: 'file', id: path })
    expect(value).toBe('sk-from-file')
  })

  it('throws SecretResolveError(FILE_UNREADABLE) when the file does not exist', async () => {
    await expect(
      resolveSecret({ source: 'file', id: join(dir, 'nope.txt') }),
    ).rejects.toMatchObject({ code: 'FILE_UNREADABLE' })
  })

  it('throws on empty file content', async () => {
    const path = join(dir, 'empty.txt')
    await writeFile(path, '\n   \n')
    await expect(resolveSecret({ source: 'file', id: path })).rejects.toMatchObject({
      code: 'EMPTY_VALUE',
    })
  })
})

describe('SecretResolveError', () => {
  it('exposes the code as a discriminated property', async () => {
    try {
      await resolveSecret({ source: 'env', id: ENV_KEY })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(SecretResolveError)
      expect((err as SecretResolveError).code).toBe('ENV_MISSING')
    }
  })
})
