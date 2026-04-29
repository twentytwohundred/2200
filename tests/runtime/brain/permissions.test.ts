import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BRAIN_PERMISSIONS_SCHEMA_VERSION,
  brainPermissionsPath,
  canReadBrain,
  grantBrainRead,
  readBrainPermissions,
  revokeBrainRead,
  writeBrainPermissions,
} from '../../../src/runtime/brain/permissions.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-brainperms-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('readBrainPermissions', () => {
  it('returns an empty default record when no file exists', async () => {
    const r = await readBrainPermissions(home, 'hobby')
    expect(r.schema_version).toBe(BRAIN_PERMISSIONS_SCHEMA_VERSION)
    expect(r.readers).toEqual([])
  })

  it('throws on malformed JSON', async () => {
    const path = brainPermissionsPath(home, 'hobby')
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, 'not json', 'utf8')
    await expect(readBrainPermissions(home, 'hobby')).rejects.toThrow(/not valid JSON/)
  })
})

describe('writeBrainPermissions', () => {
  it('persists a sorted, deduped reader list', async () => {
    const r = await writeBrainPermissions(home, 'hobby', ['simon', 'poe', 'simon'])
    expect(r.readers).toEqual(['poe', 'simon'])
    const rt = await readBrainPermissions(home, 'hobby')
    expect(rt.readers).toEqual(['poe', 'simon'])
  })

  it('writes the file at the canonical path under <state>/brain/<owner>/permissions.json', async () => {
    await writeBrainPermissions(home, 'hobby', ['poe'])
    const path = brainPermissionsPath(home, 'hobby')
    expect(path).toContain(join('state', 'brain', 'hobby', 'permissions.json'))
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(parsed['readers']).toEqual(['poe'])
  })
})

describe('grantBrainRead / revokeBrainRead', () => {
  it('grants are idempotent', async () => {
    await grantBrainRead(home, 'hobby', 'simon')
    const r = await grantBrainRead(home, 'hobby', 'simon')
    expect(r.readers).toEqual(['simon'])
  })

  it('revokes a previously granted reader', async () => {
    await grantBrainRead(home, 'hobby', 'simon')
    await grantBrainRead(home, 'hobby', 'poe')
    const r = await revokeBrainRead(home, 'hobby', 'simon')
    expect(r.readers).toEqual(['poe'])
  })

  it('revoking a non-reader is a no-op', async () => {
    const r = await revokeBrainRead(home, 'hobby', 'simon')
    expect(r.readers).toEqual([])
  })
})

describe('canReadBrain', () => {
  it('an Agent can always read its own brain', async () => {
    expect(await canReadBrain(home, 'hobby', 'hobby')).toBe(true)
  })

  it('returns false for an unauthorized caller', async () => {
    expect(await canReadBrain(home, 'hobby', 'simon')).toBe(false)
  })

  it('returns true for a granted reader', async () => {
    await grantBrainRead(home, 'hobby', 'simon')
    expect(await canReadBrain(home, 'hobby', 'simon')).toBe(true)
  })

  it('returns false again after revoke', async () => {
    await grantBrainRead(home, 'hobby', 'simon')
    await revokeBrainRead(home, 'hobby', 'simon')
    expect(await canReadBrain(home, 'hobby', 'simon')).toBe(false)
  })
})
