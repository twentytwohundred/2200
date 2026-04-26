/**
 * Tests for the user-config loader and 2200_HOME resolution precedence.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultHome,
  resolveHome,
  saveUserConfig,
  tryLoadUserConfig,
  userConfigDir,
  userConfigPath,
} from '../../../src/runtime/config/loader.js'

let tmp: string
const ENV_HOME = 'TWENTYTWOHUNDRED_HOME'
const XDG_CONFIG = 'XDG_CONFIG_HOME'
const XDG_DATA = 'XDG_DATA_HOME'

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), '2200-config-'))
  Reflect.deleteProperty(process.env, ENV_HOME)
  Reflect.deleteProperty(process.env, XDG_CONFIG)
  Reflect.deleteProperty(process.env, XDG_DATA)
})

afterEach(async () => {
  Reflect.deleteProperty(process.env, ENV_HOME)
  Reflect.deleteProperty(process.env, XDG_CONFIG)
  Reflect.deleteProperty(process.env, XDG_DATA)
  await rm(tmp, { recursive: true, force: true })
})

describe('XDG path defaults', () => {
  it('honors $XDG_CONFIG_HOME for the config directory', () => {
    process.env[XDG_CONFIG] = tmp
    expect(userConfigDir()).toBe(join(tmp, '2200'))
    expect(userConfigPath()).toBe(join(tmp, '2200', 'config.json'))
  })

  it('honors $XDG_DATA_HOME for the default home', () => {
    process.env[XDG_DATA] = tmp
    expect(defaultHome()).toBe(join(tmp, '2200'))
  })
})

describe('resolveHome precedence', () => {
  it('cliHome wins over everything', async () => {
    process.env[ENV_HOME] = '/from-env'
    process.env[XDG_CONFIG] = tmp
    await mkdir(join(tmp, '2200'), { recursive: true })
    await writeFile(
      join(tmp, '2200', 'config.json'),
      JSON.stringify({ schema_version: 1, home: '/from-config' }),
    )
    expect(await resolveHome('/from-cli')).toBe('/from-cli')
  })

  it('env var wins over config file', async () => {
    process.env[ENV_HOME] = '/from-env'
    process.env[XDG_CONFIG] = tmp
    await mkdir(join(tmp, '2200'), { recursive: true })
    await writeFile(
      join(tmp, '2200', 'config.json'),
      JSON.stringify({ schema_version: 1, home: '/from-config' }),
    )
    expect(await resolveHome()).toBe('/from-env')
  })

  it('config file wins over default', async () => {
    process.env[XDG_CONFIG] = tmp
    await mkdir(join(tmp, '2200'), { recursive: true })
    await writeFile(
      join(tmp, '2200', 'config.json'),
      JSON.stringify({ schema_version: 1, home: '/from-config' }),
    )
    expect(await resolveHome()).toBe('/from-config')
  })

  it('falls back to default when no other source is present', async () => {
    process.env[XDG_CONFIG] = tmp
    process.env[XDG_DATA] = tmp
    expect(await resolveHome()).toBe(join(tmp, '2200'))
  })
})

describe('saveUserConfig + tryLoadUserConfig round-trip', () => {
  it('persists and reads back', async () => {
    process.env[XDG_CONFIG] = tmp
    await saveUserConfig({ schema_version: 1, home: '/some/where' })
    const loaded = await tryLoadUserConfig()
    expect(loaded).toEqual({ schema_version: 1, home: '/some/where' })
  })

  it('returns null when no config has been written', async () => {
    process.env[XDG_CONFIG] = tmp
    expect(await tryLoadUserConfig()).toBeNull()
  })

  it('throws on schema mismatch', async () => {
    process.env[XDG_CONFIG] = tmp
    await mkdir(join(tmp, '2200'), { recursive: true })
    await writeFile(
      join(tmp, '2200', 'config.json'),
      JSON.stringify({ schema_version: 1 /* missing home */ }),
    )
    await expect(tryLoadUserConfig()).rejects.toThrow(/schema validation/)
  })
})
