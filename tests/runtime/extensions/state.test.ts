import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  EXTENSION_STATE_MAX_BYTES,
  ExtensionStateError,
  readExtensionState,
  writeExtensionState,
} from '../../../src/runtime/extensions/state.js'
import { extensionStatePaths } from '../../../src/runtime/storage/layout.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-ext-state-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('readExtensionState', () => {
  it('returns {} when the file is missing', async () => {
    expect(await readExtensionState(home, 'fresh')).toEqual({})
  })

  it('round-trips', async () => {
    await writeExtensionState(home, 'rt', { foo: 'bar', n: 42, list: [1, 2, 3] })
    expect(await readExtensionState(home, 'rt')).toEqual({
      foo: 'bar',
      n: 42,
      list: [1, 2, 3],
    })
  })

  it('throws on malformed JSON', async () => {
    const path = extensionStatePaths(home, 'broken').state
    await mkdir(join(home, 'state', 'extensions', 'broken'), { recursive: true })
    await writeFile(path, 'not json', 'utf8')
    await expect(readExtensionState(home, 'broken')).rejects.toBeInstanceOf(ExtensionStateError)
  })

  it('throws when the top-level value is not an object', async () => {
    const path = extensionStatePaths(home, 'arr').state
    await mkdir(join(home, 'state', 'extensions', 'arr'), { recursive: true })
    await writeFile(path, '[1, 2, 3]', 'utf8')
    await expect(readExtensionState(home, 'arr')).rejects.toThrow(
      /top-level value must be a JSON object/,
    )
  })

  it('rejects oversized files at read time', async () => {
    const path = extensionStatePaths(home, 'huge').state
    await mkdir(join(home, 'state', 'extensions', 'huge'), { recursive: true })
    const oversized = '{"x":"' + 'A'.repeat(EXTENSION_STATE_MAX_BYTES + 100) + '"}'
    await writeFile(path, oversized, 'utf8')
    await expect(readExtensionState(home, 'huge')).rejects.toThrow(/exceeds/)
  })
})

describe('writeExtensionState', () => {
  it('rejects oversized payloads without writing to disk', async () => {
    const big: Record<string, string> = {}
    for (let i = 0; i < 200_000; i++) {
      big[`k${String(i)}`] = 'v'
    }
    await expect(writeExtensionState(home, 'big', big)).rejects.toThrow(/exceeds/)
  })

  it('creates the state directory lazily', async () => {
    await writeExtensionState(home, 'lazy', { key: 'val' })
    expect(await readExtensionState(home, 'lazy')).toEqual({ key: 'val' })
  })
})
