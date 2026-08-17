/**
 * Access-mode config tests (Epic 19).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  readAccessConfig,
  writeAccessConfig,
  webBindHostForMode,
  accessConfigPath,
  DEFAULT_ACCESS_CONFIG,
} from '../../../src/runtime/tunnel/access-config.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-access-config-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('access config', () => {
  it('returns the default (local, no hostname) when nothing is written', async () => {
    expect(await readAccessConfig(home)).toEqual(DEFAULT_ACCESS_CONFIG)
  })

  it('round-trips a cloud config with a hostname', async () => {
    await writeAccessConfig(home, { mode: 'cloud', hostname: 'alice.2200.dev' })
    expect(await readAccessConfig(home)).toEqual({
      schema_version: 1,
      mode: 'cloud',
      hostname: 'alice.2200.dev',
    })
  })

  it('rejects an unknown mode on read', async () => {
    const path = accessConfigPath(home)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ schema_version: 1, mode: 'wormhole', hostname: null }))
    await expect(readAccessConfig(home)).rejects.toThrow()
  })
})

describe('webBindHostForMode', () => {
  it('binds loopback for cloud (tunnel is the only ingress)', () => {
    expect(webBindHostForMode('cloud')).toBe('127.0.0.1')
  })

  it('binds loopback for tailscale', () => {
    expect(webBindHostForMode('tailscale')).toBe('127.0.0.1')
  })

  it('binds all interfaces for local (LAN by design)', () => {
    expect(webBindHostForMode('local')).toBe('0.0.0.0')
  })
})
