/**
 * Broker install-secret resolution: sealed-store-first, env-fallback.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveBrokerSecret,
  BROKER_SECRET_KEY,
} from '../../../src/runtime/tunnel/broker-secret.js'
import {
  saveInstanceSecret,
  listInstanceSecretKeys,
} from '../../../src/runtime/tunnel/secret-store.js'

let home: string
const ENV = 'TWENTYTWOHUNDRED_BROKER_INSTALL_SECRET'
let prevEnv: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-broker-secret-'))
  prevEnv = process.env[ENV]
  Reflect.deleteProperty(process.env, ENV)
})

afterEach(async () => {
  if (prevEnv === undefined) Reflect.deleteProperty(process.env, ENV)
  else process.env[ENV] = prevEnv
  await rm(home, { recursive: true, force: true })
})

describe('resolveBrokerSecret', () => {
  it('returns null when neither the sealed store nor the env is set', async () => {
    expect(await resolveBrokerSecret(home)).toBeNull()
  })

  it('reads the sealed store', async () => {
    await saveInstanceSecret(home, BROKER_SECRET_KEY, 'sealed-value')
    expect(await resolveBrokerSecret(home)).toBe('sealed-value')
  })

  it('falls back to the env var when the store is empty', async () => {
    process.env[ENV] = 'env-value'
    expect(await resolveBrokerSecret(home)).toBe('env-value')
  })

  it('prefers the sealed store over the env var', async () => {
    await saveInstanceSecret(home, BROKER_SECRET_KEY, 'sealed-wins')
    process.env[ENV] = 'env-loses'
    expect(await resolveBrokerSecret(home)).toBe('sealed-wins')
  })

  it('lists the key by name (not value) after set', async () => {
    await saveInstanceSecret(home, BROKER_SECRET_KEY, 'x')
    expect(await listInstanceSecretKeys(home)).toEqual([BROKER_SECRET_KEY])
  })
})
