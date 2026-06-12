/**
 * Tests for the user identity file loader/writer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadUserIdentity,
  loadUserIdentityIfExists,
  UserIdentityParseError,
  writeUserIdentity,
} from '../../../src/runtime/user/loader.js'
import type { UserIdentityFrontmatter } from '../../../src/runtime/user/types.js'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), '2200-user-loader-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const sampleFrontmatter: UserIdentityFrontmatter = {
  schema_version: 1,
  display_name: 'Alice',
  pub: {
    identity: '01919c4f-7e3a-7000-8000-d4a984f2c1b3',
    handle: '@alice',
    credentials: { source: 'file', id: '/var/2200/config/user.pub.secret' },
    key_version: 1,
    issuer_url: 'local://localhost',
  },
  scut: {},
  created: '2026-04-26',
}

describe('writeUserIdentity + loadUserIdentity', () => {
  it('round-trips frontmatter', async () => {
    const path = join(tmp, 'user.md')
    await writeUserIdentity(path, sampleFrontmatter, 'Free-form bio.')
    const record = await loadUserIdentity(path)
    expect(record.frontmatter).toEqual(sampleFrontmatter)
    expect(record.body.trim()).toBe('Free-form bio.')
    expect(record.source_path).toBe(path)
  })

  it('preserves an empty body', async () => {
    const path = join(tmp, 'user.md')
    await writeUserIdentity(path, sampleFrontmatter, '')
    const record = await loadUserIdentity(path)
    expect(record.body.trim()).toBe('')
  })

  it('writes a valid frontmatter delimited by --- on first line', async () => {
    const path = join(tmp, 'user.md')
    await writeUserIdentity(path, sampleFrontmatter)
    const raw = await readFile(path, 'utf8')
    expect(raw.startsWith('---\n')).toBe(true)
    expect(raw).toContain('display_name: Alice')
    expect(raw).toContain('handle: "@alice"')
  })

  it('rejects writing an invalid frontmatter (missing required field)', async () => {
    const path = join(tmp, 'user.md')
    const broken = { ...sampleFrontmatter }
    // @ts-expect-error: deliberately invalid
    delete broken.display_name
    await expect(writeUserIdentity(path, broken)).rejects.toThrow()
  })
})

describe('loadUserIdentity error paths', () => {
  it('throws UserIdentityParseError when file does not exist', async () => {
    await expect(loadUserIdentity(join(tmp, 'no-such.md'))).rejects.toThrow(UserIdentityParseError)
  })

  it('throws when frontmatter delimiters are missing', async () => {
    const path = join(tmp, 'user.md')
    await writeFile(path, 'just text\n', 'utf8')
    await expect(loadUserIdentity(path)).rejects.toThrow(/no YAML frontmatter/)
  })

  it('throws on malformed YAML', async () => {
    const path = join(tmp, 'user.md')
    await writeFile(path, '---\nthis: : not: : valid\n---\n', 'utf8')
    await expect(loadUserIdentity(path)).rejects.toThrow(/malformed YAML/)
  })

  it('throws on schema mismatch with descriptive issues', async () => {
    const path = join(tmp, 'user.md')
    await writeFile(path, '---\nschema_version: 1\ndisplay_name: Alice\n---\n', 'utf8')
    let caught: string | undefined
    try {
      await loadUserIdentity(path)
    } catch (err) {
      caught = err instanceof Error ? err.message : String(err)
    }
    expect(caught).toMatch(/fails schema validation/)
    expect(caught).toMatch(/pub/)
  })
})

describe('loadUserIdentityIfExists', () => {
  it('returns null when the file does not exist', async () => {
    const result = await loadUserIdentityIfExists(join(tmp, 'no-such.md'))
    expect(result).toBeNull()
  })

  it('returns the record when the file exists', async () => {
    const path = join(tmp, 'user.md')
    await writeUserIdentity(path, sampleFrontmatter)
    const result = await loadUserIdentityIfExists(path)
    expect(result?.frontmatter.display_name).toBe('Alice')
  })

  it('propagates non-not-found errors', async () => {
    const path = join(tmp, 'user.md')
    await writeFile(path, 'no frontmatter\n', 'utf8')
    await expect(loadUserIdentityIfExists(path)).rejects.toThrow(/no YAML frontmatter/)
  })
})

describe('forward-compat', () => {
  it('tolerates unknown keys inside scut block (Epic 4 placeholder)', async () => {
    const path = join(tmp, 'user.md')
    const withFutureScut: UserIdentityFrontmatter = {
      ...sampleFrontmatter,
      scut: { future_field: 'whatever' },
    }
    await writeUserIdentity(path, withFutureScut)
    const record = await loadUserIdentity(path)
    expect(record.frontmatter.scut['future_field']).toBe('whatever')
  })
})

describe('directory and re-create', () => {
  it('write replaces an existing user.md atomically', async () => {
    const dir = join(tmp, 'config')
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'user.md')
    await writeUserIdentity(path, sampleFrontmatter)
    const updated: UserIdentityFrontmatter = {
      ...sampleFrontmatter,
      display_name: 'Alice Hardman',
    }
    await writeUserIdentity(path, updated)
    const record = await loadUserIdentity(path)
    expect(record.frontmatter.display_name).toBe('Alice Hardman')
  })
})
