import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  extensionExists,
  extensionsHome,
  listExtensions,
  readExtension,
} from '../../../src/runtime/extensions/registry.js'
import {
  EXTENSION_SCHEMA_VERSION,
  validateManifest,
} from '../../../src/runtime/extensions/types.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-ext-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

interface MakeArgs {
  name: string
  version?: string
  permissions?: string[]
  display_name?: string
  description?: string
  invalid?: boolean
}

async function makeExtension(args: MakeArgs): Promise<void> {
  const dir = join(home, 'extensions', args.name)
  await mkdir(dir, { recursive: true })
  const manifest = args.invalid
    ? { not: 'a valid manifest' }
    : {
        schema_version: EXTENSION_SCHEMA_VERSION,
        name: args.name,
        version: args.version ?? '0.1.0',
        display_name: args.display_name ?? args.name,
        description: args.description ?? `Test extension ${args.name}`,
        author: 'Test Author',
        permissions: args.permissions ?? [],
        schedules: [],
        tools: [],
      }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')
}

describe('listExtensions', () => {
  it('returns [] when the extensions root does not exist', async () => {
    expect(await listExtensions(home)).toEqual([])
  })

  it('returns one entry per valid manifest', async () => {
    await makeExtension({ name: 'alpha' })
    await makeExtension({ name: 'beta', version: '1.2.3' })
    const items = await listExtensions(home)
    expect(items.map((e) => e.name).sort()).toEqual(['alpha', 'beta'])
    expect(items.every((e) => e.status === 'ok')).toBe(true)
    expect(items.find((e) => e.name === 'beta')?.version).toBe('1.2.3')
  })

  it('marks malformed manifests as invalid without breaking other entries', async () => {
    await makeExtension({ name: 'good' })
    await makeExtension({ name: 'bad', invalid: true })
    const items = await listExtensions(home)
    expect(items.find((e) => e.name === 'good')?.status).toBe('ok')
    expect(items.find((e) => e.name === 'bad')?.status).toBe('invalid')
    expect(items.find((e) => e.name === 'bad')?.reason).toContain('manifest')
  })

  it('skips dot-prefixed entries', async () => {
    await mkdir(join(home, 'extensions', '.hidden'), { recursive: true })
    expect(await listExtensions(home)).toEqual([])
  })
})

describe('readExtension', () => {
  it('returns the parsed manifest + paths', async () => {
    await makeExtension({
      name: 'finance-tracker',
      display_name: 'Finance Tracker',
      description: 'Track Mercury + Chase nightly',
      permissions: ['network', 'notifications'],
    })
    const rec = await readExtension(home, 'finance-tracker')
    expect(rec.manifest.display_name).toBe('Finance Tracker')
    expect(rec.manifest.permissions).toEqual(['network', 'notifications'])
    expect(rec.rootPath).toContain('extensions/finance-tracker')
    expect(rec.manifestPath).toContain('manifest.json')
  })

  it('throws when the manifest is missing', async () => {
    await expect(readExtension(home, 'nope')).rejects.toThrow(/does not exist/)
  })

  it('throws when the manifest name does not match the dir', async () => {
    const dir = join(home, 'extensions', 'wrongname')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({
        schema_version: EXTENSION_SCHEMA_VERSION,
        name: 'differentname',
        version: '0.1.0',
        display_name: 'X',
        description: 'X',
        author: 'X',
      }),
      'utf-8',
    )
    await expect(readExtension(home, 'wrongname')).rejects.toThrow(/does not match directory/)
  })
})

describe('extensionExists', () => {
  it('returns true when the manifest file is present', async () => {
    await makeExtension({ name: 'present' })
    expect(await extensionExists(home, 'present')).toBe(true)
  })

  it('returns false when the manifest file is missing', async () => {
    expect(await extensionExists(home, 'absent')).toBe(false)
  })
})

describe('extensionsHome', () => {
  it('returns <home>/extensions', () => {
    expect(extensionsHome(home)).toBe(join(home, 'extensions'))
  })
})

describe('validateManifest', () => {
  it('accepts a minimal valid manifest', () => {
    const m = validateManifest(
      {
        schema_version: 1,
        name: 'minimal',
        version: '0.0.1',
        display_name: 'Minimal',
        description: 'Smoke',
        author: 'Test',
      },
      'inline',
    )
    expect(m.permissions).toEqual([])
    expect(m.schedules).toEqual([])
  })

  it('rejects unknown permission strings', () => {
    expect(() =>
      validateManifest(
        {
          schema_version: 1,
          name: 'bad-perm',
          version: '0.0.1',
          display_name: 'Bad',
          description: 'Bad',
          author: 'Test',
          permissions: ['nuke-the-fleet'],
        },
        'inline',
      ),
    ).toThrow(/Extension manifest at inline/)
  })

  it('rejects bad name slugs', () => {
    expect(() =>
      validateManifest(
        {
          schema_version: 1,
          name: 'BadName',
          version: '0.0.1',
          display_name: 'Bad',
          description: 'Bad',
          author: 'Test',
        },
        'inline',
      ),
    ).toThrow(/slug starting with a lowercase letter/)
  })

  it('rejects bad version strings', () => {
    expect(() =>
      validateManifest(
        {
          schema_version: 1,
          name: 'badver',
          version: 'not-a-version',
          display_name: 'Bad',
          description: 'Bad',
          author: 'Test',
        },
        'inline',
      ),
    ).toThrow(/semver/)
  })
})
