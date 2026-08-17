/**
 * Tests for the operator file-browsing surface.
 *
 * Two things are being protected.
 *
 * Containment: this surface hands an HTTP caller a path and reads/
 * writes whatever it resolves to. If the resolver's guarantees stop
 * holding here ... traversal, absolute paths, escaping into another
 * Agent's private tree ... the browser becomes an arbitrary-file-read
 * of the whole box. The traversal tests are not box-ticking; they are
 * the reason this module resolves every path through
 * `resolveVirtualPath` instead of joining strings.
 *
 * Write scope: `/brain` is deliberately readable but not writable
 * here, because brain notes are mirrored into an FTS5 index and a raw
 * write behind the index's back leaves search silently stale. A future
 * "why not just allow it" simplification fails these tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BROWSABLE_ROOTS,
  MAX_EDITABLE_BYTES,
  isWritablePath,
  looksBinary,
  readFileForDisplay,
  readFileRaw,
  walkTree,
  writeFileFromOperator,
} from '../../../src/runtime/http/files.js'
import { initHome, initAgentDirs } from '../../../src/runtime/storage/init.js'
import { agentPaths } from '../../../src/runtime/storage/layout.js'

let home: string
const AGENT = 'skippy'
const PEER = 'jodin'

async function makeAgent(name: string): Promise<void> {
  const identity = join(home, `${name}.identity.md`)
  await writeFile(identity, '---\nschema_version: 1\n---\n# test identity\n', 'utf8')
  await initAgentDirs(home, name, identity)
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-files-'))
  await initHome(home)
  await makeAgent(AGENT)
  await makeAgent(PEER)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('walkTree', () => {
  it('returns the nested structure an Agent built, not just the top level', async () => {
    const project = agentPaths(home, AGENT).project
    await mkdir(join(project, 'reports', 'q3'), { recursive: true })
    await writeFile(join(project, 'reports', 'q3', 'revenue.md'), '# revenue\n', 'utf8')
    await writeFile(join(project, 'notes.txt'), 'hello', 'utf8')

    const tree = await walkTree(home, AGENT, '/project')

    const reports = tree.entries.find((e) => e.name === 'reports')
    expect(reports?.kind).toBe('dir')
    const q3 = reports?.children?.find((e) => e.name === 'q3')
    const revenue = q3?.children?.find((e) => e.name === 'revenue.md')
    expect(revenue?.path).toBe('/project/reports/q3/revenue.md')
    expect(revenue?.kind).toBe('file')
    expect(revenue?.size).toBeGreaterThan(0)
  })

  it('sorts directories first, then by name, so the browser reads in order', async () => {
    const project = agentPaths(home, AGENT).project
    await mkdir(join(project, 'zeta'), { recursive: true })
    await writeFile(join(project, 'alpha.md'), 'a', 'utf8')
    await writeFile(join(project, 'beta.md'), 'b', 'utf8')

    const tree = await walkTree(home, AGENT, '/project')
    expect(tree.entries.map((e) => e.name)).toEqual(['zeta', 'alpha.md', 'beta.md'])
  })

  it('reads an Agent that has never written a file as empty, not as an error', async () => {
    const tree = await walkTree(home, AGENT, '/project')
    expect(tree.entries).toEqual([])
    expect(tree.truncated).toBe(false)
  })

  it('hides dotfiles ... runtime bookkeeping is not the Agent work product', async () => {
    const project = agentPaths(home, AGENT).project
    await writeFile(join(project, '.rate-skippy.json'), '{}', 'utf8')
    await writeFile(join(project, 'real.md'), 'x', 'utf8')

    const tree = await walkTree(home, AGENT, '/project')
    expect(tree.entries.map((e) => e.name)).toEqual(['real.md'])
  })

  it('walks each browsable root', async () => {
    for (const root of BROWSABLE_ROOTS) {
      await expect(walkTree(home, AGENT, root.path)).resolves.toBeDefined()
    }
  })
})

describe('containment', () => {
  it('refuses to traverse out of the Agent tree with ..', async () => {
    await expect(walkTree(home, AGENT, '/project/../../..')).rejects.toMatchObject({ status: 400 })
    await expect(
      readFileForDisplay(home, AGENT, '/project/../../../etc/passwd'),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('refuses absolute host paths', async () => {
    await expect(readFileForDisplay(home, AGENT, '/etc/passwd')).rejects.toMatchObject({
      status: 400,
    })
  })

  it('refuses an unrecognized root', async () => {
    await expect(walkTree(home, AGENT, '/state')).rejects.toMatchObject({ status: 400 })
    await expect(readFileForDisplay(home, AGENT, '/config/user.md')).rejects.toMatchObject({
      status: 400,
    })
  })

  it("does not expose a peer Agent's private project tree through /project", async () => {
    // /project resolves against the *named* Agent, so browsing skippy
    // must never surface jodin's private files.
    await writeFile(join(agentPaths(home, PEER).project, 'secret.md'), 'peer secret', 'utf8')

    const tree = await walkTree(home, AGENT, '/project')
    expect(tree.entries).toEqual([])

    const raw = await readFileForDisplay(home, PEER, '/project/secret.md')
    expect(raw.content).toBe('peer secret')
  })

  it('refuses to write outside the Agent tree', async () => {
    await expect(
      writeFileFromOperator(home, AGENT, '/project/../../escape.md', 'x'),
    ).rejects.toMatchObject({ status: 400 })
  })
})

describe('readFileForDisplay', () => {
  it('returns text content for an editable file', async () => {
    await writeFile(join(agentPaths(home, AGENT).project, 'q3.md'), '# Q3\n\nRevenue.', 'utf8')
    const res = await readFileForDisplay(home, AGENT, '/project/q3.md')
    expect(res.content).toBe('# Q3\n\nRevenue.')
    expect(res.reason).toBeNull()
    expect(res.writable).toBe(true)
  })

  it('withholds content for a binary file so the browser offers a download instead', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02])
    await writeFile(join(agentPaths(home, AGENT).project, 'chart.png'), png)
    const res = await readFileForDisplay(home, AGENT, '/project/chart.png')
    expect(res.content).toBeNull()
    expect(res.reason).toBe('binary')
  })

  it('withholds content for a file too large to hand a browser editor', async () => {
    const big = 'x'.repeat(MAX_EDITABLE_BYTES + 1)
    await writeFile(join(agentPaths(home, AGENT).project, 'big.log'), big, 'utf8')
    const res = await readFileForDisplay(home, AGENT, '/project/big.log')
    expect(res.content).toBeNull()
    expect(res.reason).toBe('too_large')
    // Still downloadable ... withholding is about the editor, not access.
    const { buffer } = await readFileRaw(home, AGENT, '/project/big.log')
    expect(buffer.length).toBe(big.length)
  })

  it('404s a missing file and 400s a directory', async () => {
    await expect(readFileForDisplay(home, AGENT, '/project/nope.md')).rejects.toMatchObject({
      status: 404,
    })
    await mkdir(join(agentPaths(home, AGENT).project, 'sub'), { recursive: true })
    await expect(readFileForDisplay(home, AGENT, '/project/sub')).rejects.toMatchObject({
      status: 400,
    })
  })

  it('marks brain files read-only', async () => {
    await writeFile(join(agentPaths(home, AGENT).brain, 'note.md'), '# note', 'utf8')
    const res = await readFileForDisplay(home, AGENT, '/brain/note.md')
    expect(res.content).toBe('# note')
    expect(res.writable).toBe(false)
  })
})

describe('writeFileFromOperator', () => {
  it('saves an edit the Agent can then read', async () => {
    const abs = join(agentPaths(home, AGENT).project, 'q3.md')
    await writeFile(abs, 'draft', 'utf8')

    await writeFileFromOperator(home, AGENT, '/project/q3.md', 'operator revision')

    expect(await readFile(abs, 'utf8')).toBe('operator revision')
  })

  it('creates parent directories so a new file lands in one step', async () => {
    await writeFileFromOperator(home, AGENT, '/project/new/deep/file.md', 'hi')
    const abs = join(agentPaths(home, AGENT).project, 'new', 'deep', 'file.md')
    expect(await readFile(abs, 'utf8')).toBe('hi')
  })

  it('refuses to write a brain note, and says which surface can', async () => {
    await writeFile(join(agentPaths(home, AGENT).brain, 'note.md'), '# note', 'utf8')

    await expect(
      writeFileFromOperator(home, AGENT, '/brain/note.md', 'rewritten'),
    ).rejects.toMatchObject({ status: 403 })

    // The rejection has to point somewhere, not just deny.
    await expect(writeFileFromOperator(home, AGENT, '/brain/note.md', 'rewritten')).rejects.toThrow(
      /Brain screen/,
    )

    // And the file is untouched.
    expect(await readFile(join(agentPaths(home, AGENT).brain, 'note.md'), 'utf8')).toBe('# note')
  })

  it('allows writes to every root marked writable', () => {
    expect(isWritablePath('/project/a.md')).toBe(true)
    expect(isWritablePath('/shared/a.md')).toBe(true)
    expect(isWritablePath('/commons/a.md')).toBe(true)
    expect(isWritablePath('/brain/a.md')).toBe(false)
    // A root-prefix lookalike must not slip through.
    expect(isWritablePath('/projectile/a.md')).toBe(false)
  })
})

describe('looksBinary', () => {
  it('treats a NUL byte as binary and plain UTF-8 as text', () => {
    expect(looksBinary(Buffer.from('hello world', 'utf8'))).toBe(false)
    expect(looksBinary(Buffer.from('emoji ok ✨ ... ellipses too', 'utf8'))).toBe(false)
    expect(looksBinary(Buffer.from([0x41, 0x00, 0x42]))).toBe(true)
  })
})

describe('readFileRaw', () => {
  it('returns bytes and a filename for download', async () => {
    await writeFile(join(agentPaths(home, AGENT).project, 'q3.md'), 'content', 'utf8')
    const res = await readFileRaw(home, AGENT, '/project/q3.md')
    expect(res.buffer.toString('utf8')).toBe('content')
    expect(res.filename).toBe('q3.md')
  })

  it('refuses a directory', async () => {
    await mkdir(join(agentPaths(home, AGENT).project, 'sub'), { recursive: true })
    await expect(readFileRaw(home, AGENT, '/project/sub')).rejects.toMatchObject({ status: 400 })
  })
})
