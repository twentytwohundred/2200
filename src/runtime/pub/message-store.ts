/**
 * Durable per-pub chat log.
 *
 * The OpenPub pub-server keeps only an in-memory conversation window and
 * explicitly delegates persistence to the on-box host (server.js: "persistence
 * is the agent's responsibility on-box"). So that window is lost on every
 * pub-server restart, leaving the Studio blank on entry. This store is the
 * on-box persistence: every time the messages endpoint reads the live window,
 * it appends anything new to a per-pub JSONL log and serves the merge ... so
 * the chat history is there even across restarts and fresh sessions.
 *
 * Append-only on the hot path (cheap); the file is trimmed back to MAX_PERSISTED
 * only when it grows well past that, so the common poll does one read + (usually)
 * no write.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Cap on persisted messages per pub. Older messages roll off on trim. */
const MAX_PERSISTED = 2000
/** Trim the on-disk log only once it exceeds this (avoids rewriting every poll). */
const TRIM_THRESHOLD = Math.floor(MAX_PERSISTED * 1.5)

/**
 * A persisted message. We store whatever the live message carries (keyed by
 * message_id) so the store stays decoupled from the exact pub message shape.
 */
export interface StoredMessage {
  message_id: string
  timestamp?: string
  [k: string]: unknown
}

export function messagesLogPath(home: string, pubName: string): string {
  return join(home, 'state', 'openpub', pubName, 'messages.jsonl')
}

/** Read the persisted log (empty when none yet). Skips any corrupt line. */
export async function readPersistedMessages(
  home: string,
  pubName: string,
): Promise<StoredMessage[]> {
  let raw: string
  try {
    raw = await readFile(messagesLogPath(home, pubName), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: StoredMessage[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const m = JSON.parse(line) as unknown
      if (m && typeof m === 'object' && typeof (m as StoredMessage).message_id === 'string') {
        out.push(m as StoredMessage)
      }
    } catch {
      // Skip a partially-written / corrupt line rather than fail the read.
    }
  }
  return out
}

function byTimeThenId(a: StoredMessage, b: StoredMessage): number {
  const ta = a.timestamp ?? ''
  const tb = b.timestamp ?? ''
  if (ta !== tb) return ta < tb ? -1 : 1
  return a.message_id < b.message_id ? -1 : a.message_id > b.message_id ? 1 : 0
}

/**
 * Append any of `live` not already persisted, then return the most recent
 * `limit` messages (persisted ∪ live), deduped by message_id, oldest-first.
 */
export async function mergeAndPersistMessages(
  home: string,
  pubName: string,
  live: readonly StoredMessage[],
  limit: number,
): Promise<StoredMessage[]> {
  const persisted = await readPersistedMessages(home, pubName)
  const seen = new Set(persisted.map((m) => m.message_id))
  const fresh: StoredMessage[] = []
  for (const m of live) {
    if (seen.has(m.message_id)) continue
    seen.add(m.message_id)
    fresh.push(m)
  }

  const path = messagesLogPath(home, pubName)
  if (fresh.length > 0) {
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, fresh.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8')
  }

  const merged = [...persisted, ...fresh].sort(byTimeThenId)

  // Occasionally trim the on-disk log so it can't grow without bound.
  if (persisted.length + fresh.length > TRIM_THRESHOLD) {
    const trimmed = merged.slice(-MAX_PERSISTED)
    await writeFile(path, trimmed.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8')
    return trimmed.slice(-limit)
  }

  return merged.slice(-limit)
}
