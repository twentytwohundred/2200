/**
 * The PUB.md owner must come from the operator's identity, never a
 * baked-in default.
 *
 * Why this matters: a 2200 install belongs to whoever ran first-run.
 * Until 2026-06-12, `composePubMd` silently defaulted the owner to
 * 'doug', which would have branded every user's pubs with the wrong
 * operator. These tests pin the contract: derive from the user
 * identity's pub handle, fail loud when no identity exists, and let
 * an explicit owner override (tests, advanced callers).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Supervisor } from '../../../src/runtime/supervisor/supervisor.js'
import { pubPaths } from '../../../src/runtime/storage/layout.js'

let home: string
let supervisor: Supervisor | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-pub-owner-'))
  supervisor = await Supervisor.create({ home })
  await supervisor.start()
})

afterEach(async () => {
  if (supervisor) {
    await supervisor.shutdown()
    supervisor = undefined
  }
  await rm(home, { recursive: true, force: true })
})

describe('createPub owner derivation', () => {
  it('fails loud when no user identity exists and no owner is passed', async () => {
    await expect(supervisor!.createPub('ops')).rejects.toThrow(/no user identity/)
  })

  it('derives the owner from the user identity pub handle (sans @)', async () => {
    await supervisor!.createUserIdentity({ display_name: 'Test User' })
    await supervisor!.createPub('ops')
    const md = await readFile(pubPaths(home, 'ops').pubMd, 'utf8')
    // defaultHandleFor('Test User') is '@testuser'; PUB.md owner drops the '@'.
    expect(md).toContain('owner: testuser')
    expect(md).not.toContain('owner: doug')
  })

  it('an explicit owner overrides derivation and needs no identity', async () => {
    await supervisor!.createPub('ops', { owner: 'someone-else' })
    const md = await readFile(pubPaths(home, 'ops').pubMd, 'utf8')
    expect(md).toContain('owner: someone-else')
  })
})
