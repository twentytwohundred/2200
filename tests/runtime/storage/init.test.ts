/**
 * Tests for the 2200_HOME initializer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initHome, initAgentDirs } from '../../../src/runtime/storage/init.js'
import { homePaths, agentPaths } from '../../../src/runtime/storage/layout.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-init-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('initHome', () => {
  it('creates the seed directory layout', async () => {
    await initHome(home)
    const paths = homePaths(home)
    for (const dir of [
      paths.commonsReference,
      paths.commonsScratch,
      paths.agents,
      paths.stateNotifications,
      paths.config,
    ]) {
      const s = await stat(dir)
      expect(s.isDirectory()).toBe(true)
    }
  })

  it('is idempotent (running on an already-initialized home is a no-op)', async () => {
    await initHome(home)
    await initHome(home)
    const entries = await readdir(home)
    expect(entries.sort()).toEqual(['agents', 'commons', 'config', 'state'])
  })

  it('creates parent dirs that do not yet exist', async () => {
    const nested = join(home, 'a', 'b', 'c')
    await initHome(nested)
    const s = await stat(nested)
    expect(s.isDirectory()).toBe(true)
  })
})

describe('initAgentDirs', () => {
  it('creates per-Agent project, brain, shared dirs', async () => {
    await initHome(home)
    const sourceIdentity = join(home, 'src.identity.md')
    await writeFile(sourceIdentity, '---\nschema_version: 1\n---\n# body\n')
    await initAgentDirs(home, 'hobby', sourceIdentity)
    const a = agentPaths(home, 'hobby')
    expect((await stat(a.root)).isDirectory()).toBe(true)
    expect((await stat(a.project)).isDirectory()).toBe(true)
    expect((await stat(a.brain)).isDirectory()).toBe(true)
    expect((await stat(a.shared)).isDirectory()).toBe(true)
  })

  it('copies the source Identity to the canonical agents/<name>/identity.md', async () => {
    await initHome(home)
    const sourceIdentity = join(home, 'src.identity.md')
    const content = '---\nschema_version: 1\n---\n# body\n'
    await writeFile(sourceIdentity, content)
    await initAgentDirs(home, 'hobby', sourceIdentity)
    const canonical = agentPaths(home, 'hobby').identity
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(canonical, 'utf8')).toBe(content)
  })

  it('is a no-op overwrite when source IS the canonical path', async () => {
    await initHome(home)
    const canonical = agentPaths(home, 'hobby').identity
    // Pre-create canonical so initAgentDirs sees source==canonical.
    const { mkdir } = await import('node:fs/promises')
    await mkdir(agentPaths(home, 'hobby').root, { recursive: true })
    await writeFile(canonical, 'preexisting')
    await initAgentDirs(home, 'hobby', canonical)
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(canonical, 'utf8')).toBe('preexisting')
  })
})
