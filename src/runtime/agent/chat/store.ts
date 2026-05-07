/**
 * ChatStore: per-Agent conversation thread (Epic 15 Phase C).
 *
 * One JSONL file per Agent at `<home>/agents/<name>/chat.jsonl`. Each
 * line is a ChatMessage record (user or assistant turn). Append-only;
 * the file IS the source of truth.
 *
 * Why JSONL and not markdown like Brain notes:
 *   - Notes are documents (one per topic). Chat is a stream (one per
 *     conversation). Append cadence is too high for atomic-write-
 *     entire-file-each-time.
 *   - JSONL is grep-friendly, easy to tail, and bounded-write per
 *     append. SQLite would be overkill at v1; we'll revisit if a
 *     branching/threaded conversation model lands later.
 *
 * Concurrency: append-only, single writer (the daemon HTTP handler).
 * Multiple readers OK. The supervisor process is the only writer at
 * v1; agent processes don't write to chat.jsonl directly.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { agentPaths } from '../../storage/layout.js'

export const ChatMessageRoleSchema = z.enum(['user', 'assistant', 'system'])
export type ChatMessageRole = z.infer<typeof ChatMessageRoleSchema>

export const ChatMessageSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().min(1),
  ts: z.string().min(1),
  role: ChatMessageRoleSchema,
  content: z.string(),
  /** Optional reference to a task this message is the body/outcome of. */
  task_id: z.string().nullable().default(null),
})
export type ChatMessage = z.infer<typeof ChatMessageSchema>

export interface AppendArgs {
  role: ChatMessageRole
  content: string
  taskId?: string | null
  now?: () => Date
  id?: string
}

export class ChatStore {
  constructor(
    private readonly home: string,
    private readonly agentName: string,
  ) {}

  private path(): string {
    return agentPaths(this.home, this.agentName).chatLog
  }

  /** Append one message. Returns the persisted record. */
  async append(args: AppendArgs): Promise<ChatMessage> {
    const now = args.now ?? ((): Date => new Date())
    const msg: ChatMessage = {
      schema_version: 1,
      id: args.id ?? newChatMessageId(),
      ts: now().toISOString(),
      role: args.role,
      content: args.content,
      task_id: args.taskId ?? null,
    }
    const path = this.path()
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, JSON.stringify(msg) + '\n', 'utf8')
    return msg
  }

  /**
   * Read all messages, ordered by file order (== chronological since
   * the writer is append-only). Tolerates malformed lines (skips with
   * a console.warn equivalent ... a single bad line should not
   * truncate the visible history).
   */
  async list(): Promise<ChatMessage[]> {
    let raw: string
    try {
      raw = await readFile(this.path(), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const out: ChatMessage[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        const obj = JSON.parse(trimmed) as unknown
        const parsed = ChatMessageSchema.safeParse(obj)
        if (parsed.success) out.push(parsed.data)
      } catch {
        // skip malformed line
      }
    }
    return out
  }
}

let counter = 0
function newChatMessageId(): string {
  counter += 1
  const stamp = Date.now().toString(36)
  return `chat_${stamp}_${counter.toString(36)}`
}
