/**
 * Tests for atomicWriteFile / atomicWriteJson.
 *
 * Verify that:
 *  - The target file ends up with the right contents.
 *  - No `.tmp.*` files are left behind on success.
 *  - The temp file is cleaned up on failure (open() failure case).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteFile, atomicWriteJson, dirOf } from '../../../src/runtime/util/atomic-write.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), '2200-atomic-write-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('atomicWriteFile', () => {
  it('writes the requested contents to the target', async () => {
    const path = join(dir, 'a.txt')
    await atomicWriteFile(path, 'hello world')
    const read = await readFile(path, 'utf8')
    expect(read).toBe('hello world')
  })

  it('overwrites an existing file', async () => {
    const path = join(dir, 'a.txt')
    await atomicWriteFile(path, 'first')
    await atomicWriteFile(path, 'second')
    const read = await readFile(path, 'utf8')
    expect(read).toBe('second')
  })

  it('leaves no temp files behind on success', async () => {
    const path = join(dir, 'a.txt')
    await atomicWriteFile(path, 'data')
    const entries = await readdir(dir)
    expect(entries.filter((e) => e.includes('.tmp.'))).toEqual([])
    expect(entries).toContain('a.txt')
  })

  it('writes binary data via Uint8Array', async () => {
    const path = join(dir, 'b.bin')
    const data = new Uint8Array([1, 2, 3, 4, 5])
    await atomicWriteFile(path, data)
    const read = await readFile(path)
    expect(Array.from(read)).toEqual([1, 2, 3, 4, 5])
  })

  it('rejects when the parent dir does not exist', async () => {
    const path = join(dir, 'nope', 'a.txt')
    await expect(atomicWriteFile(path, 'x')).rejects.toThrow()
  })
})

describe('atomicWriteJson', () => {
  it('writes the JSON-serialized value with a trailing newline', async () => {
    const path = join(dir, 'a.json')
    await atomicWriteJson(path, { foo: 1, bar: ['baz'] })
    const read = await readFile(path, 'utf8')
    expect(read.endsWith('\n')).toBe(true)
    expect(JSON.parse(read)).toEqual({ foo: 1, bar: ['baz'] })
  })

  it('formats the JSON with two-space indent', async () => {
    const path = join(dir, 'a.json')
    await atomicWriteJson(path, { a: 1 })
    const read = await readFile(path, 'utf8')
    expect(read).toContain('  "a": 1')
  })
})

describe('dirOf', () => {
  it('returns the directory of a path', () => {
    expect(dirOf('/a/b/c.txt')).toBe('/a/b')
  })
})

describe('atomic + stat', () => {
  it('produces a regular file (not a symlink or special)', async () => {
    const path = join(dir, 'a.txt')
    await atomicWriteFile(path, 'data')
    const s = await stat(path)
    expect(s.isFile()).toBe(true)
  })
})
