/**
 * Conduits registry (Phase 2 / PR-B1).
 *
 * On-disk source of truth: one JSON file per conduit under
 *   `<home>/state/connector/conduits/<client_id>.json`
 *
 * Operator-visible projection: `<shared>/brain/conduits.md`, a
 * regenerated Brain note that lists every conduit with relationship
 * metadata. Same pattern as `<home>/state/fleet.md` — the file is a
 * rebuildable mirror; never edit by hand.
 *
 * Files here are NOT sealed (unlike the OAuth client + token stores).
 * Conduit records contain operator-facing metadata (display name,
 * registered_at, last_seen_at). The OAuth client_id is the primary
 * key, but on its own it is not a secret — the access token binds
 * the OAuth security.
 */
import { mkdir, readdir, readFile, unlink, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile } from '../../../util/atomic-write.js'
import { BrainStore } from '../../../brain/store.js'
import { homePaths } from '../../../storage/layout.js'
import { ConduitRecordSchema, type ConduitRecord } from './types.js'

const DIR_MODE = 0o700
const FILE_MODE = 0o600

const SHARED_INDEX_SLUG = 'conduits'

function conduitsDir(home: string): string {
  return join(homePaths(home).state, 'connector', 'conduits')
}

function conduitPath(home: string, clientId: string): string {
  return join(conduitsDir(home), `${clientId}.json`)
}

export async function ensureConduitsDir(home: string): Promise<void> {
  await mkdir(conduitsDir(home), { recursive: true, mode: DIR_MODE })
}

/**
 * Persist a conduit record. Atomic write; mode 0600. The shared-
 * brain conduits.md index is NOT regenerated here — callers do that
 * once per top-level operation via `regenerateConduitsIndex`.
 */
export async function writeConduit(home: string, record: ConduitRecord): Promise<void> {
  await ensureConduitsDir(home)
  const path = conduitPath(home, record.client_id)
  await atomicWriteFile(path, JSON.stringify(record, null, 2))
  await chmod(path, FILE_MODE)
}

/** Read a conduit by client_id. Null if missing. */
export async function readConduit(home: string, clientId: string): Promise<ConduitRecord | null> {
  const path = conduitPath(home, clientId)
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  return ConduitRecordSchema.parse(JSON.parse(raw))
}

/** List every conduit on disk. Sorted by registered_at descending. */
export async function listConduits(home: string): Promise<ConduitRecord[]> {
  let entries: string[]
  try {
    entries = await readdir(conduitsDir(home))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const records: ConduitRecord[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const clientId = entry.slice(0, -'.json'.length)
    const r = await readConduit(home, clientId).catch(() => null)
    if (r !== null) records.push(r)
  }
  return records.sort((a, b) => b.registered_at.localeCompare(a.registered_at))
}

/** Idempotent delete. Returns true iff a file was removed. */
export async function deleteConduit(home: string, clientId: string): Promise<boolean> {
  try {
    await unlink(conduitPath(home, clientId))
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/** Patch `last_seen_at` on a conduit (called by the listener on every routed /mcp call). */
export async function recordLastSeen(home: string, clientId: string, when: Date): Promise<void> {
  const existing = await readConduit(home, clientId)
  if (existing === null) return
  await writeConduit(home, { ...existing, last_seen_at: when.toISOString() })
}

/** Mark a conduit retired. The record stays for audit; the listener stops routing through it. */
export async function markRetired(home: string, clientId: string, when: Date): Promise<void> {
  const existing = await readConduit(home, clientId)
  if (existing === null) throw new Error(`unknown client_id "${clientId}"`)
  await writeConduit(home, { ...existing, retired_at: when.toISOString() })
}

/**
 * Regenerate the operator-visible `<shared>/brain/conduits.md` index.
 * Rebuilds from the on-disk source of truth; safe to call repeatedly.
 */
export async function regenerateConduitsIndex(home: string): Promise<void> {
  const records = await listConduits(home)
  const store = BrainStore.forShared(home)
  const body = renderConduitsIndex(records)
  await store.write({
    slug: SHARED_INDEX_SLUG,
    title: 'Conduits',
    body,
    type: 'conduits-index',
    tags: ['conduits', 'fleet'],
  })
}

function renderConduitsIndex(records: ConduitRecord[]): string {
  const parts: string[] = []
  parts.push('_Regenerated from `<home>/state/connector/conduits/*.json`. Do not edit by hand._')
  parts.push('')
  if (records.length === 0) {
    parts.push('No conduits registered. Configure one with `2200 connector mcp register`.')
    return parts.join('\n')
  }
  const active = records.filter((r) => r.retired_at === null)
  const retired = records.filter((r) => r.retired_at !== null)
  if (active.length > 0) {
    parts.push('## Active')
    parts.push('')
    for (const r of active) parts.push(renderConduitRow(r))
    parts.push('')
  }
  if (retired.length > 0) {
    parts.push('## Retired')
    parts.push('')
    for (const r of retired) parts.push(renderConduitRow(r))
  }
  return parts.join('\n')
}

function renderConduitRow(r: ConduitRecord): string {
  const lines: string[] = []
  lines.push(`### ${r.display_name}`)
  lines.push('')
  lines.push(`- **external model:** \`${r.external_model}\``)
  lines.push(`- **client_id:** \`${r.client_id}\``)
  lines.push(`- **embassy agent:** \`${r.embassy_agent}\` (\`${r.mode}\`)`)
  lines.push(
    `- **registered:** ${r.registered_at}${r.registered_by ? ` by ${r.registered_by}` : ''}`,
  )
  if (r.last_seen_at !== null) lines.push(`- **last call:** ${r.last_seen_at}`)
  if (r.retired_at !== null) lines.push(`- **retired:** ${r.retired_at}`)
  return lines.join('\n')
}
