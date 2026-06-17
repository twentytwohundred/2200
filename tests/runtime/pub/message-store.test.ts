/**
 * Tests for the durable per-pub chat log (Studio persistence).
 *
 * The decisive case: when the pub-server's in-memory window is empty (it
 * restarted), the messages endpoint must still return the persisted history ...
 * so the Studio is never blank on entry.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  mergeAndPersistMessages,
  readPersistedMessages,
  type StoredMessage,
} from '../../../src/runtime/pub/message-store.js'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-msg-store-'))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function msg(id: string, seconds: number): StoredMessage {
  const ts = `2026-06-17T00:00:${String(seconds).padStart(2, '0')}.000Z`
  return { message_id: id, timestamp: ts, agent_id: 'a', display_name: 'd', content: id }
}

describe('mergeAndPersistMessages', () => {
  it('persists live messages and returns them oldest-first', async () => {
    const out = await mergeAndPersistMessages(home, 'studio', [msg('m2', 2), msg('m1', 1)], 100)
    expect(out.map((m) => m.message_id)).toEqual(['m1', 'm2'])
    expect((await readPersistedMessages(home, 'studio')).length).toBe(2)
  })

  it('serves history when the live window is empty (the restart case)', async () => {
    await mergeAndPersistMessages(home, 'studio', [msg('m1', 1), msg('m2', 2)], 100)
    // pub-server restarted -> live window empty. History must still come back.
    const out = await mergeAndPersistMessages(home, 'studio', [], 100)
    expect(out.map((m) => m.message_id)).toEqual(['m1', 'm2'])
  })

  it('dedups by message_id across repeated polls', async () => {
    await mergeAndPersistMessages(home, 'studio', [msg('m1', 1)], 100)
    await mergeAndPersistMessages(home, 'studio', [msg('m1', 1), msg('m2', 2)], 100)
    const out = await mergeAndPersistMessages(home, 'studio', [msg('m2', 2)], 100)
    expect(out.map((m) => m.message_id)).toEqual(['m1', 'm2'])
    expect((await readPersistedMessages(home, 'studio')).length).toBe(2)
  })

  it('returns only the last `limit`, oldest-first', async () => {
    const msgs = [msg('m0', 0), msg('m1', 1), msg('m2', 2), msg('m3', 3), msg('m4', 4)]
    const out = await mergeAndPersistMessages(home, 'studio', msgs, 2)
    expect(out.map((m) => m.message_id)).toEqual(['m3', 'm4'])
  })
})
