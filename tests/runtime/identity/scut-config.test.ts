/**
 * Tests for the SCUT config loader and SecretRef resolver
 * (Epic 4 Phase A PR F).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ScutConfigError,
  loadScutConfig,
  resolveSecret,
  scutConfigPath,
} from '../../../src/runtime/identity/scut-config.js'
import { initHome } from '../../../src/runtime/storage/init.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-scut-config-'))
  await initHome(home)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

const VALID = {
  schema_version: 1,
  rpc_url: 'https://mainnet.base.org',
  chain_id: 8453,
  contract_address: '0x199b48E27a28881502b251B0068F388Ce750feff',
  wallet_address: '0x6050bB51838d007336e10A0054e3173998269b6C',
  wallet_private_key: { source: 'env', id: 'SCUT_WALLET_PRIVATE_KEY' },
}

async function writeConfig(content: unknown): Promise<void> {
  const path = scutConfigPath(home)
  await mkdir(path.replace(/\/[^/]+$/, ''), { recursive: true })
  await writeFile(path, JSON.stringify(content), 'utf8')
}

describe('loadScutConfig', () => {
  it('loads a valid config and applies defaults', async () => {
    await writeConfig(VALID)
    const config = await loadScutConfig(home)
    expect(config.chain_id).toBe(8453)
    expect(config.contract_address).toBe('0x199b48E27a28881502b251B0068F388Ce750feff')
    expect(config.wallet_address).toBe('0x6050bB51838d007336e10A0054e3173998269b6C')
    expect(config.wallet_private_key.source).toBe('env')
  })

  it('throws ScutConfigError when the file is missing', async () => {
    await expect(loadScutConfig(home)).rejects.toThrow(ScutConfigError)
  })

  it('throws ScutConfigError on malformed JSON', async () => {
    const path = scutConfigPath(home)
    await mkdir(path.replace(/\/[^/]+$/, ''), { recursive: true })
    await writeFile(path, '{ not valid json', 'utf8')
    await expect(loadScutConfig(home)).rejects.toThrow(/not valid JSON/)
  })

  it('throws ScutConfigError on schema mismatch', async () => {
    await writeConfig({ ...VALID, contract_address: '0xshort' })
    await expect(loadScutConfig(home)).rejects.toThrow(/schema validation/)
  })

  it('rejects an unknown schema_version', async () => {
    await writeConfig({ ...VALID, schema_version: 99 })
    await expect(loadScutConfig(home)).rejects.toThrow(/schema validation/)
  })
})

describe('resolveSecret', () => {
  it('reads an env-source secret from process.env', async () => {
    process.env['TEST_SCUT_KEY'] = '0xdeadbeef'
    const v = await resolveSecret({ source: 'env', id: 'TEST_SCUT_KEY' })
    expect(v).toBe('0xdeadbeef')
    delete process.env['TEST_SCUT_KEY']
  })

  it('throws when an env-source secret is unset', async () => {
    delete process.env['NEVER_SET_SCUT_KEY']
    await expect(resolveSecret({ source: 'env', id: 'NEVER_SET_SCUT_KEY' })).rejects.toThrow(
      /not set or empty/,
    )
  })

  it('reads a file-source secret', async () => {
    const path = join(home, 'wallet-key.txt')
    await writeFile(path, '0xfeedface\n', 'utf8')
    const v = await resolveSecret({ source: 'file', id: path })
    expect(v).toBe('0xfeedface')
  })

  it('throws when a file-source secret is empty', async () => {
    const path = join(home, 'empty.txt')
    await writeFile(path, '   \n  \n', 'utf8')
    await expect(resolveSecret({ source: 'file', id: path })).rejects.toThrow(/empty/)
  })
})
