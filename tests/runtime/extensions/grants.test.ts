import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  EXTENSION_GRANTS_SCHEMA_VERSION,
  ExtensionGrantsError,
  hasGrant,
  readGrants,
  writeGrants,
} from '../../../src/runtime/extensions/grants.js'
import { extensionStatePaths } from '../../../src/runtime/storage/layout.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-ext-grants-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('readGrants', () => {
  it('returns the empty grant set when no file exists', async () => {
    const g = await readGrants(home, 'nope')
    expect(g.permissions).toEqual([])
    expect(g.name).toBe('nope')
    expect(g.schema_version).toBe(EXTENSION_GRANTS_SCHEMA_VERSION)
  })

  it('round-trips the persisted grants', async () => {
    const written = await writeGrants(home, 'finance', ['network', 'notifications'])
    const read = await readGrants(home, 'finance')
    expect(read).toEqual(written)
    expect(read.permissions).toEqual(['network', 'notifications'])
  })

  it('throws on malformed JSON', async () => {
    const path = extensionStatePaths(home, 'broken').grants
    await mkdir(join(home, 'state', 'extensions', 'broken'), { recursive: true })
    await writeFile(path, 'not json', 'utf8')
    await expect(readGrants(home, 'broken')).rejects.toBeInstanceOf(ExtensionGrantsError)
  })

  it('throws when the on-disk name does not match the directory', async () => {
    const path = extensionStatePaths(home, 'foo').grants
    await mkdir(join(home, 'state', 'extensions', 'foo'), { recursive: true })
    await writeFile(
      path,
      JSON.stringify({
        schema_version: EXTENSION_GRANTS_SCHEMA_VERSION,
        name: 'bar',
        granted_at: new Date().toISOString(),
        permissions: [],
      }),
      'utf8',
    )
    await expect(readGrants(home, 'foo')).rejects.toThrow(/does not match directory/)
  })

  it('throws on schema mismatch (unknown permission)', async () => {
    const path = extensionStatePaths(home, 'corrupt').grants
    await mkdir(join(home, 'state', 'extensions', 'corrupt'), { recursive: true })
    await writeFile(
      path,
      JSON.stringify({
        schema_version: EXTENSION_GRANTS_SCHEMA_VERSION,
        name: 'corrupt',
        granted_at: new Date().toISOString(),
        permissions: ['nuke-everything'],
      }),
      'utf8',
    )
    await expect(readGrants(home, 'corrupt')).rejects.toThrow(/permissions/)
  })
})

describe('writeGrants', () => {
  it('sorts and dedups before writing', async () => {
    const g = await writeGrants(home, 'sorted', ['notifications', 'network', 'notifications'])
    expect(g.permissions).toEqual(['network', 'notifications'])
    const path = extensionStatePaths(home, 'sorted').grants
    const onDisk = JSON.parse(await readFile(path, 'utf8')) as { permissions: string[] }
    expect(onDisk.permissions).toEqual(['network', 'notifications'])
  })

  it('writes the supplied timestamp via the now() override', async () => {
    const fixed = new Date('2026-05-06T12:00:00.000Z')
    await writeGrants(home, 'tspaced', [], () => fixed)
    const g = await readGrants(home, 'tspaced')
    expect(g.granted_at).toBe(fixed.toISOString())
  })

  it('overwrites an existing grants file', async () => {
    await writeGrants(home, 'mut', ['network'])
    await writeGrants(home, 'mut', ['network', 'fs.scratch'])
    const g = await readGrants(home, 'mut')
    expect(g.permissions).toEqual(['fs.scratch', 'network'])
  })
})

describe('hasGrant', () => {
  it('returns true only when the permission is in the persisted set', async () => {
    const g = await writeGrants(home, 'check', ['network', 'pub_send'])
    expect(hasGrant(g, 'network')).toBe(true)
    expect(hasGrant(g, 'pub_send')).toBe(true)
    expect(hasGrant(g, 'fs.scratch')).toBe(false)
  })
})
