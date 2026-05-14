/**
 * MultiChatStore: per-Agent multi-thread chat surface (design-system
 * v1.1 port).
 *
 * Storage layout, all under `<home>/agents/<name>/chats/`:
 *
 *   index.json                              chat metadata (array)
 *   <chat-id>.jsonl                         one message per line
 *   <chat-id>/attachments/<att-id>-<name>   binary blobs referenced by messages
 *
 * Design choices:
 *   - JSONL per thread keeps the "files on disk a human can `cat`"
 *     property of the brain dir. No split-brain with a database.
 *   - index.json is small (one entry per chat) and rewritten atomically
 *     on every metadata change. The thread JSONLs are append-only.
 *   - Attachments are written to disk on upload; messages reference them
 *     by attachment-id. The store owns the disk path; consumers see only
 *     the public AttachmentRef.
 *   - Legacy `<root>/chat.jsonl` is migrated into a single chat with id
 *     "default" the first time the multi-store touches the agent. The
 *     migration is idempotent and the legacy file is left in place
 *     untouched (no destructive moves at v1.1).
 *
 * Concurrency: the supervisor process is the single writer. Multiple
 * readers OK. If we ever multi-write the supervisor (unlikely at v1),
 * the index.json rewrite is the chokepoint and would need a file lock.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { agentChatAttachmentsDir, agentPaths } from '../../storage/layout.js'

// ── Types ──────────────────────────────────────────────────────────────────

export const ChatRoleSchema = z.enum(['user', 'assistant', 'system'])
export type ChatRole = z.infer<typeof ChatRoleSchema>

export const SendModeSchema = z.enum(['pure', 'checkpointed', 'destructive'])
export type SendMode = z.infer<typeof SendModeSchema>

export const AttachmentKindSchema = z.enum(['file', 'image'])
export type AttachmentKind = z.infer<typeof AttachmentKindSchema>

export const AttachmentRefSchema = z.object({
  id: z.string().min(1),
  kind: AttachmentKindSchema,
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  mime: z.string().min(1),
})
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>

/**
 * Discriminator for system-role messages emitted by the runtime
 * itself rather than the agent or operator. v1 has just one kind:
 * `audit` for claim-vs-evidence audit cards. Future system-authored
 * messages pick their own enum value here so the renderer can route
 * them. Null for normal user / assistant / system messages.
 */
export const ChatMessageKindSchema = z.enum(['audit']).nullable().default(null)
export type ChatMessageKind = z.infer<typeof ChatMessageKindSchema>

export const ChatMessageRecordSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().min(1),
  chat_id: z.string().min(1),
  ts: z.string().min(1),
  role: ChatRoleSchema,
  body: z.string(),
  mode: SendModeSchema.nullable().default(null),
  attachments: z.array(AttachmentRefSchema).default([]),
  /** Optional reference to a task this message is the body/outcome of. */
  task_id: z.string().nullable().default(null),
  /** Runtime-side discriminator; see ChatMessageKindSchema. */
  kind: ChatMessageKindSchema,
})
export type ChatMessageRecord = z.infer<typeof ChatMessageRecordSchema>

export const ChatThreadSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().min(1),
  title: z.string().min(1),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  unread: z.boolean().default(false),
  archived: z.boolean().default(false),
  /** Most-recent message preview, populated lazily by the store on append. */
  snippet: z.string().default(''),
  /** Last user-author message ts; helpful for filtering "active conversations". */
  last_user_at: z.string().nullable().default(null),
})
export type ChatThread = z.infer<typeof ChatThreadSchema>

const ChatIndexSchema = z.object({
  schema_version: z.literal(1),
  chats: z.array(ChatThreadSchema),
})
type ChatIndex = z.infer<typeof ChatIndexSchema>

export interface AppendMessageArgs {
  chatId: string
  role: ChatRole
  body: string
  mode?: SendMode | null
  attachments?: AttachmentRef[]
  taskId?: string | null
  now?: () => Date
  id?: string
  /** System-role discriminator; surfaces in the renderer routing. */
  kind?: ChatMessageKind
}

export interface CreateChatArgs {
  /** Optional override; otherwise derived from the seed message or "new chat". */
  title?: string
  /** Optional explicit id; for tests and re-imports. */
  id?: string
  now?: () => Date
}

export interface SaveAttachmentArgs {
  chatId: string
  kind: AttachmentKind
  name: string
  mime: string
  data: Buffer
}

// ── Store ──────────────────────────────────────────────────────────────────

const DEFAULT_CHAT_ID = 'default'
const SCHEMA_VERSION = 1 as const

export class MultiChatStore {
  constructor(
    private readonly home: string,
    private readonly agentName: string,
  ) {}

  private paths() {
    return agentPaths(this.home, this.agentName)
  }

  private threadPath(chatId: string): string {
    return join(this.paths().chatsDir, `${chatId}.jsonl`)
  }

  // ── Index I/O ──────────────────────────────────────────────────────────

  private async loadIndex(): Promise<ChatIndex> {
    const { chatsIndex } = this.paths()
    try {
      const raw = await readFile(chatsIndex, 'utf8')
      const parsed = ChatIndexSchema.safeParse(JSON.parse(raw))
      if (parsed.success) return parsed.data
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    return { schema_version: SCHEMA_VERSION, chats: [] }
  }

  private async saveIndex(index: ChatIndex): Promise<void> {
    const { chatsDir, chatsIndex } = this.paths()
    await mkdir(chatsDir, { recursive: true })
    const tmp = `${chatsIndex}.tmp-${process.pid.toString()}-${Date.now().toString(36)}`
    await writeFile(tmp, JSON.stringify(index, null, 2) + '\n', 'utf8')
    await rename(tmp, chatsIndex)
  }

  // ── Legacy migration ───────────────────────────────────────────────────

  /**
   * If a legacy <root>/chat.jsonl exists and the multi-store has no
   * thread yet, surface the legacy log as the "default" chat. Reads-only
   * ... the new system serves both files transparently. The legacy file
   * is left in place so existing tooling (`chat_send` tool, old GET
   * /api/v1/agents/:name/chat) keeps working.
   */
  async ensureLegacyMigrated(now: () => Date = (): Date => new Date()): Promise<void> {
    const index = await this.loadIndex()
    if (index.chats.some((c) => c.id === DEFAULT_CHAT_ID)) return
    const { chatLog } = this.paths()
    if (!existsSync(chatLog)) return

    // Read the legacy log to populate snippet + updated_at.
    let snippet = ''
    let updatedAt = now().toISOString()
    let lastUserAt: string | null = null
    try {
      const raw = await readFile(chatLog, 'utf8')
      const lines = raw.split('\n').filter((l) => l.trim().length > 0)
      if (lines.length > 0) {
        const lastObj = JSON.parse(lines[lines.length - 1] ?? '{}') as Partial<{
          ts: string
          content: string
        }>
        if (typeof lastObj.ts === 'string') updatedAt = lastObj.ts
        if (typeof lastObj.content === 'string') snippet = firstLine(lastObj.content, 80)
        // Walk for the last user-author ts.
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          try {
            const o = JSON.parse(lines[i] ?? '{}') as { role?: string; ts?: string }
            if (o.role === 'user' && typeof o.ts === 'string') {
              lastUserAt = o.ts
              break
            }
          } catch {
            /* skip malformed */
          }
        }
      }
    } catch {
      /* legacy unreadable; surface the chat empty rather than skipping */
    }

    const thread: ChatThread = {
      schema_version: SCHEMA_VERSION,
      id: DEFAULT_CHAT_ID,
      title: 'Chat',
      created_at: now().toISOString(),
      updated_at: updatedAt,
      unread: false,
      archived: false,
      snippet,
      last_user_at: lastUserAt,
    }
    await this.saveIndex({
      schema_version: SCHEMA_VERSION,
      chats: [...index.chats, thread],
    })
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /** All non-archived chats first (most recent updated_at first), then archived. */
  async listChats(): Promise<ChatThread[]> {
    await this.ensureLegacyMigrated()
    const index = await this.loadIndex()
    const live = index.chats
      .filter((c) => !c.archived)
      .sort((a, b) => (b.updated_at < a.updated_at ? -1 : b.updated_at > a.updated_at ? 1 : 0))
    const archived = index.chats
      .filter((c) => c.archived)
      .sort((a, b) => (b.updated_at < a.updated_at ? -1 : b.updated_at > a.updated_at ? 1 : 0))
    return [...live, ...archived]
  }

  async getChat(chatId: string): Promise<ChatThread | null> {
    await this.ensureLegacyMigrated()
    const index = await this.loadIndex()
    return index.chats.find((c) => c.id === chatId) ?? null
  }

  async createChat(args: CreateChatArgs = {}): Promise<ChatThread> {
    await this.ensureLegacyMigrated()
    const index = await this.loadIndex()
    const now = args.now ?? ((): Date => new Date())
    const id = args.id ?? newChatId()
    if (index.chats.some((c) => c.id === id)) {
      throw new Error(`chat with id "${id}" already exists`)
    }
    const ts = now().toISOString()
    const thread: ChatThread = {
      schema_version: SCHEMA_VERSION,
      id,
      title: args.title ?? 'New chat',
      created_at: ts,
      updated_at: ts,
      unread: false,
      archived: false,
      snippet: '',
      last_user_at: null,
    }
    await this.saveIndex({
      schema_version: SCHEMA_VERSION,
      chats: [...index.chats, thread],
    })
    return thread
  }

  async renameChat(chatId: string, title: string): Promise<ChatThread> {
    const index = await this.loadIndex()
    const next = index.chats.map((c) => (c.id === chatId ? { ...c, title } : c))
    const updated = next.find((c) => c.id === chatId)
    if (!updated) throw new Error(`chat not found: ${chatId}`)
    await this.saveIndex({ schema_version: SCHEMA_VERSION, chats: next })
    return updated
  }

  async archiveChat(chatId: string, archived: boolean): Promise<ChatThread> {
    const index = await this.loadIndex()
    const next = index.chats.map((c) => (c.id === chatId ? { ...c, archived } : c))
    const updated = next.find((c) => c.id === chatId)
    if (!updated) throw new Error(`chat not found: ${chatId}`)
    await this.saveIndex({ schema_version: SCHEMA_VERSION, chats: next })
    return updated
  }

  async markRead(chatId: string): Promise<void> {
    const index = await this.loadIndex()
    if (!index.chats.some((c) => c.id === chatId)) return
    const next = index.chats.map((c) => (c.id === chatId ? { ...c, unread: false } : c))
    await this.saveIndex({ schema_version: SCHEMA_VERSION, chats: next })
  }

  async appendMessage(args: AppendMessageArgs): Promise<ChatMessageRecord> {
    const index = await this.loadIndex()
    const thread = index.chats.find((c) => c.id === args.chatId)
    if (!thread) throw new Error(`chat not found: ${args.chatId}`)

    const now = args.now ?? ((): Date => new Date())
    const tsIso = now().toISOString()
    const msg: ChatMessageRecord = {
      schema_version: SCHEMA_VERSION,
      id: args.id ?? newMessageId(),
      chat_id: args.chatId,
      ts: tsIso,
      role: args.role,
      body: args.body,
      mode: args.mode ?? null,
      attachments: args.attachments ?? [],
      task_id: args.taskId ?? null,
      kind: args.kind ?? null,
    }
    const path = this.threadPath(args.chatId)
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, JSON.stringify(msg) + '\n', 'utf8')

    // Update metadata: snippet, updated_at, unread (if assistant turn).
    const snippet = firstLine(args.body, 80)
    const next = index.chats.map((c) => {
      if (c.id !== args.chatId) return c
      return {
        ...c,
        title: c.title === 'New chat' && args.role === 'user' ? deriveTitle(args.body) : c.title,
        updated_at: tsIso,
        snippet,
        unread: args.role === 'assistant' ? true : c.unread,
        last_user_at: args.role === 'user' ? tsIso : c.last_user_at,
      }
    })
    await this.saveIndex({ schema_version: SCHEMA_VERSION, chats: next })
    return msg
  }

  /**
   * Read all messages for a chat.
   *
   * For the special "default" chat we MERGE the legacy single-thread
   * `chat.jsonl` history with the modern `chats/default.jsonl` so a
   * fresh post-migration message doesn't visually wipe the historical
   * transcript. Dedup by message id; sort by timestamp.
   *
   * For every other chat id, only the modern JSONL is read. Tolerates
   * malformed lines on both sides.
   */
  async listMessages(chatId: string): Promise<ChatMessageRecord[]> {
    const modern = await this.readModernThread(chatId)

    if (chatId !== DEFAULT_CHAT_ID) return modern

    const legacy = await this.readLegacyChatLog()
    if (legacy.length === 0) return modern

    const byId = new Map<string, ChatMessageRecord>()
    // Legacy first so modern entries with the same id win (modern is
    // the more recent shape, e.g. with attachments + mode).
    for (const m of legacy) byId.set(m.id, m)
    for (const m of modern) byId.set(m.id, m)

    return Array.from(byId.values()).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
  }

  private async readModernThread(chatId: string): Promise<ChatMessageRecord[]> {
    const path = this.threadPath(chatId)
    const out: ChatMessageRecord[] = []
    try {
      const raw = await readFile(path, 'utf8')
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        try {
          const parsed = ChatMessageRecordSchema.safeParse(JSON.parse(trimmed))
          if (parsed.success) out.push(parsed.data)
        } catch {
          /* skip malformed */
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    return out
  }

  private async readLegacyChatLog(): Promise<ChatMessageRecord[]> {
    const { chatLog } = this.paths()
    try {
      const raw = await readFile(chatLog, 'utf8')
      const out: ChatMessageRecord[] = []
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        try {
          const obj = JSON.parse(trimmed) as {
            id?: string
            ts?: string
            role?: string
            content?: string
            task_id?: string | null
          }
          const role = obj.role
          if (role !== 'user' && role !== 'assistant' && role !== 'system') continue
          out.push({
            schema_version: SCHEMA_VERSION,
            id: typeof obj.id === 'string' ? obj.id : newMessageId(),
            chat_id: DEFAULT_CHAT_ID,
            ts: typeof obj.ts === 'string' ? obj.ts : new Date().toISOString(),
            role,
            body: typeof obj.content === 'string' ? obj.content : '',
            mode: null,
            attachments: [],
            task_id: typeof obj.task_id === 'string' ? obj.task_id : null,
            kind: null,
          })
        } catch {
          /* skip malformed legacy line */
        }
      }
      return out
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
  }

  // ── Attachments ────────────────────────────────────────────────────────

  async saveAttachment(args: SaveAttachmentArgs): Promise<AttachmentRef> {
    const id = newAttachmentId()
    const safeName = args.name.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'file'
    const dir = agentChatAttachmentsDir(this.home, this.agentName, args.chatId)
    await mkdir(dir, { recursive: true })
    const filePath = join(dir, `${id}-${safeName}`)
    await writeFile(filePath, args.data)
    return {
      id,
      kind: args.kind,
      name: safeName,
      size: args.data.byteLength,
      mime: args.mime,
    }
  }

  attachmentPath(chatId: string, attachmentId: string, filename: string): string {
    const safe = filename.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'file'
    return join(
      agentChatAttachmentsDir(this.home, this.agentName, chatId),
      `${attachmentId}-${safe}`,
    )
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function newChatId(): string {
  return `c_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`
}

function newMessageId(): string {
  return `m_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`
}

function newAttachmentId(): string {
  return `a_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`
}

function firstLine(body: string, max: number): string {
  const line = body.split('\n').find((l) => l.trim().length > 0) ?? body
  const trimmed = line.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

function deriveTitle(body: string): string {
  const line = firstLine(body, 60)
  return line.length === 0 ? 'New chat' : line
}

export const __testing__ = {
  DEFAULT_CHAT_ID,
  newChatId,
  newMessageId,
  newAttachmentId,
}
