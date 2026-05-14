/**
 * Tests for the MultiChatStore (Epic 15 Phase C; design-system v1.1
 * port). The store powers the multi-thread chat surface ... per-agent
 * chats/ directory with index.json metadata, per-chat JSONL message
 * files, attachments under each chat, and transparent migration of
 * the legacy single-thread chat.jsonl as the "default" chat.
 *
 * Cover:
 *  - createChat / listChats: live + archived ordering
 *  - appendMessage: file written, index updated (snippet, updated_at,
 *    unread on assistant, last_user_at on user)
 *  - appendMessage: title auto-derive on first user turn for a "New chat"
 *  - listMessages: round-trips through JSONL; tolerates malformed lines
 *  - listMessages on `default`: merges legacy chat.jsonl with modern JSONL,
 *    dedup by id, sorted by ts
 *  - ensureLegacyMigrated: idempotent, populates snippet + last_user_at
 *  - renameChat / archiveChat / markRead surface the right state
 *  - saveAttachment writes the file and the AttachmentRef shape is sound
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MultiChatStore } from '../../../../src/runtime/agent/chat/multi-store.js'
import { agentPaths } from '../../../../src/runtime/storage/layout.js'

const FIXED_NOW = (): Date => new Date('2026-05-14T12:00:00.000Z')

describe('MultiChatStore', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), '2200-mcs-'))
    // The store works under <home>/agents/<name>/. Make sure the
    // parent exists so saveIndex's mkdir(chatsDir) starts from a real
    // ancestor.
    await mkdir(join(home, 'agents', 'jodin'), { recursive: true })
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  function newStore(name = 'jodin'): MultiChatStore {
    return new MultiChatStore(home, name)
  }

  it('createChat returns a thread with consistent timestamps + lands in listChats', async () => {
    const store = newStore()
    const chat = await store.createChat({ title: 'work', now: FIXED_NOW })
    expect(chat.title).toBe('work')
    expect(chat.created_at).toBe(chat.updated_at)
    expect(chat.archived).toBe(false)
    expect(chat.unread).toBe(false)

    const all = await store.listChats()
    expect(all).toHaveLength(1)
    expect(all[0]?.id).toBe(chat.id)
  })

  it('appendMessage writes to the chat JSONL and updates index metadata', async () => {
    const store = newStore()
    const chat = await store.createChat({ title: 'New chat', now: FIXED_NOW })

    const userMsg = await store.appendMessage({
      chatId: chat.id,
      role: 'user',
      body: 'hello from doug',
      now: () => new Date('2026-05-14T12:01:00.000Z'),
    })
    expect(userMsg.task_id).toBeNull()
    expect(userMsg.role).toBe('user')

    const reloaded = await store.getChat(chat.id)
    expect(reloaded?.snippet).toBe('hello from doug')
    expect(reloaded?.last_user_at).toBe('2026-05-14T12:01:00.000Z')
    // First user message into a "New chat" auto-derives the title.
    expect(reloaded?.title).toBe('hello from doug')
    expect(reloaded?.unread).toBe(false)

    const assistant = await store.appendMessage({
      chatId: chat.id,
      role: 'assistant',
      body: 'hi doug',
      now: () => new Date('2026-05-14T12:01:30.000Z'),
    })
    expect(assistant.role).toBe('assistant')
    const afterAssistant = await store.getChat(chat.id)
    expect(afterAssistant?.unread).toBe(true)
    // last_user_at unchanged across the assistant turn.
    expect(afterAssistant?.last_user_at).toBe('2026-05-14T12:01:00.000Z')

    // The JSONL file is real on disk and round-trips through listMessages.
    const msgs = await store.listMessages(chat.id)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(msgs.map((m) => m.body)).toEqual(['hello from doug', 'hi doug'])
  })

  it('listMessages tolerates malformed JSONL lines', async () => {
    const store = newStore()
    const chat = await store.createChat({ now: FIXED_NOW })
    await store.appendMessage({ chatId: chat.id, role: 'user', body: 'one', now: FIXED_NOW })

    // Inject a junk line directly into the JSONL.
    const { chatsDir } = agentPaths(home, 'jodin')
    const threadPath = join(chatsDir, `${chat.id}.jsonl`)
    const existing = await readFile(threadPath, 'utf8')
    await writeFile(threadPath, existing + 'this is not json\n', 'utf8')

    const msgs = await store.listMessages(chat.id)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.body).toBe('one')
  })

  it('listMessages on default merges legacy chat.jsonl with modern JSONL, dedup + sort', async () => {
    // Plant a legacy chat.jsonl with two entries...
    const { chatLog } = agentPaths(home, 'jodin')
    await writeFile(
      chatLog,
      [
        JSON.stringify({
          id: 'legacy-1',
          ts: '2026-05-01T10:00:00.000Z',
          role: 'user',
          content: 'first',
        }),
        JSON.stringify({
          id: 'legacy-2',
          ts: '2026-05-01T10:05:00.000Z',
          role: 'assistant',
          content: 'second',
        }),
      ].join('\n') + '\n',
      'utf8',
    )

    const store = newStore()
    // Touch the store so the legacy migration creates the "default" thread.
    await store.listChats()
    // Append a modern message into default.
    await store.appendMessage({
      chatId: 'default',
      role: 'user',
      body: 'third',
      now: () => new Date('2026-05-14T12:00:00.000Z'),
    })

    const msgs = await store.listMessages('default')
    expect(msgs.map((m) => m.id)).toEqual(['legacy-1', 'legacy-2', expect.any(String) as string])
    expect(msgs.map((m) => m.body)).toEqual(['first', 'second', 'third'])
  })

  it('ensureLegacyMigrated is idempotent', async () => {
    const { chatLog } = agentPaths(home, 'jodin')
    await writeFile(
      chatLog,
      JSON.stringify({
        id: 'legacy-1',
        ts: '2026-04-30T10:00:00.000Z',
        role: 'user',
        content: 'hi',
      }) + '\n',
      'utf8',
    )
    const store = newStore()
    await store.listChats()
    const before = await store.listChats()
    expect(before).toHaveLength(1)
    expect(before[0]?.id).toBe('default')

    // Touch again ... no duplicate thread should be appended.
    await store.listChats()
    const after = await store.listChats()
    expect(after).toHaveLength(1)
  })

  it('renameChat / archiveChat / markRead surface the right state', async () => {
    const store = newStore()
    const chat = await store.createChat({ title: 'A', now: FIXED_NOW })
    // unread starts false; flip to true via an assistant message
    await store.appendMessage({
      chatId: chat.id,
      role: 'assistant',
      body: 'hi',
      now: FIXED_NOW,
    })
    expect((await store.getChat(chat.id))?.unread).toBe(true)
    await store.markRead(chat.id)
    expect((await store.getChat(chat.id))?.unread).toBe(false)

    const renamed = await store.renameChat(chat.id, 'B')
    expect(renamed.title).toBe('B')

    const archived = await store.archiveChat(chat.id, true)
    expect(archived.archived).toBe(true)
    // Archived chats sort AFTER live ones.
    const second = await store.createChat({ title: 'C', now: FIXED_NOW })
    const all = await store.listChats()
    expect(all.map((c) => c.id)).toEqual([second.id, chat.id])
  })

  it('saveAttachment writes the file with a sanitized name and returns the ref', async () => {
    const store = newStore()
    const chat = await store.createChat({ now: FIXED_NOW })
    const buf = Buffer.from('binary blob content', 'utf8')
    const ref = await store.saveAttachment({
      chatId: chat.id,
      kind: 'file',
      name: 'weird file name!.txt',
      mime: 'text/plain',
      data: buf,
    })
    expect(ref.kind).toBe('file')
    expect(ref.size).toBe(buf.byteLength)
    expect(ref.mime).toBe('text/plain')
    // Sanitizer collapses spaces + special chars to underscores.
    expect(ref.name).toBe('weird_file_name_.txt')
    const path = store.attachmentPath(chat.id, ref.id, ref.name)
    expect(await readFile(path)).toEqual(buf)
  })

  it('createChat rejects duplicate ids', async () => {
    const store = newStore()
    await store.createChat({ id: 'pinned', now: FIXED_NOW })
    await expect(store.createChat({ id: 'pinned', now: FIXED_NOW })).rejects.toThrow(
      /already exists/,
    )
  })

  it('listChats returns empty when nothing has been created', async () => {
    const store = newStore()
    expect(await store.listChats()).toEqual([])
  })
})
