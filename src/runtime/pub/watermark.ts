/**
 * Per-Agent per-pub message watermark.
 *
 * Per Epic 3 spec [[03-local-pub-integration]]: `pub_read` dedupes
 * by `last_read_message_id`. The watermark file lives at
 * `<home>/agents/<name>/state/pub-watermarks.json` and is written
 * atomically (temp+rename) per the Epic 2 atomic-write convention.
 *
 * State, not knowledge. Lives under the Agent's `state/` subtree
 * rather than the brain (the brain is for knowledge). The file is
 * runtime-internal; users should not edit it directly.
 */
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { atomicWriteFile } from '../util/atomic-write.js'
import { agentPaths } from '../storage/layout.js'

interface WatermarkFile {
  schema_version: 1
  pubs: Record<
    string,
    {
      pub_id: string
      last_read_message_id: string
      last_read_ts: string
    }
  >
}

function watermarkPath(home: string, agentName: string): string {
  return join(agentPaths(home, agentName).root, 'state', 'pub-watermarks.json')
}

/**
 * Load the Agent's pub watermarks from disk. Returns an empty
 * shape on first read (no file yet).
 */
export async function loadWatermarks(home: string, agentName: string): Promise<WatermarkFile> {
  const path = watermarkPath(home, agentName)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') {
      return emptyWatermarks()
    }
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`pub watermarks at ${path} is not valid JSON: ${describeError(err)}`, {
      cause: err,
    })
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    (parsed as Record<string, unknown>)['schema_version'] !== 1
  ) {
    throw new Error(`pub watermarks at ${path} has wrong schema_version`)
  }
  const pubsField = (parsed as Record<string, unknown>)['pubs']
  if (pubsField === null || typeof pubsField !== 'object') {
    throw new Error(`pub watermarks at ${path} is missing or malformed 'pubs' field`)
  }
  return { schema_version: 1, pubs: pubsField as WatermarkFile['pubs'] }
}

/**
 * Read the watermark for one pub. Returns null when no watermark is
 * recorded for that pub (the Agent has not read from it before).
 */
export async function getWatermark(
  home: string,
  agentName: string,
  pubName: string,
): Promise<{ pub_id: string; last_read_message_id: string; last_read_ts: string } | null> {
  const file = await loadWatermarks(home, agentName)
  return file.pubs[pubName] ?? null
}

/**
 * Set or update the watermark for one pub. Atomic write of the
 * whole watermarks file. Idempotent on re-set with the same value.
 */
export async function setWatermark(
  home: string,
  agentName: string,
  pubName: string,
  watermark: { pub_id: string; last_read_message_id: string; last_read_ts: string },
): Promise<void> {
  const path = watermarkPath(home, agentName)
  await mkdir(dirname(path), { recursive: true })
  const file = await loadWatermarks(home, agentName)
  file.pubs[pubName] = watermark
  await atomicWriteFile(path, JSON.stringify(file, null, 2) + '\n')
}

function emptyWatermarks(): WatermarkFile {
  return { schema_version: 1, pubs: {} }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
