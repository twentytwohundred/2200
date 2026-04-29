import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebTokenStore } from '../../../src/runtime/http/tokens.js'

let dir: string
let store: WebTokenStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), '2200-tokens-'))
  store = new WebTokenStore(join(dir, 'web-tokens'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('WebTokenStore', () => {
  it('issues a token with a 64-char value and persists it', async () => {
    const t = await store.issue('default')
    expect(t.value).toMatch(/^[0-9a-f]{64}$/)
    expect(t.label).toBe('default')
    expect(t.id).toMatch(/^[0-9a-f]+$/)
    const list = await store.list()
    expect(list.map((x) => x.id)).toContain(t.id)
  })

  it('list returns tokens sorted by created_at ascending', async () => {
    const a = await store.issue('a')
    await new Promise((r) => setTimeout(r, 5))
    const b = await store.issue('b')
    const list = await store.list()
    expect(list.map((x) => x.id)).toEqual([a.id, b.id])
  })

  it('findByValue resolves a known plaintext bearer', async () => {
    const t = await store.issue('default')
    expect(await store.findByValue(t.value)).toEqual(t)
  })

  it('findByValue returns null for an unknown bearer', async () => {
    await store.issue('default')
    expect(await store.findByValue('deadbeef')).toBeNull()
  })

  it('revoke deletes the token file', async () => {
    const t = await store.issue('default')
    expect(await store.revoke(t.id)).toBe(true)
    expect(await store.findByValue(t.value)).toBeNull()
    expect(await store.revoke(t.id)).toBe(false)
  })

  it('rotate replaces every token with one fresh one', async () => {
    await store.issue('a')
    await store.issue('b')
    const fresh = await store.rotate('default')
    const list = await store.list()
    expect(list).toEqual([fresh])
  })

  it('ensure creates a token only when the store is empty', async () => {
    const first = await store.ensure('default')
    const second = await store.ensure('default')
    expect(first.id).toBe(second.id)
    const list = await store.list()
    expect(list).toHaveLength(1)
  })

  it('list ignores malformed json files but does not throw', async () => {
    const t = await store.issue('default')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'web-tokens', 'corrupt.json'), 'not json', 'utf-8')
    const list = await store.list()
    expect(list.map((x) => x.id)).toEqual([t.id])
  })
})
