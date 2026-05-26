/**
 * Pending shelf-placement approval store (Phase 2 / PR-B2).
 *
 * When the embassy calls `request_human_shelf_placement` with a
 * `sensitivity: 'private'` item, the spec section 9 mechanism
 * captures the proposed item PLUS the embassy's reasoning into an
 * Inbox notification. The notification carries an `approval_token`
 * the operator uses with `2200 connector mcp shelf approve <token>`.
 *
 * Pending approvals live at
 *   `<home>/state/connector/embassy-approvals/<token>.json`
 *
 * NOT sealed at v1 — the payload is operator-readable, the secret
 * surface is the approval_token itself (operator only sees it via
 * the Inbox entry, which is loopback-only). If we ever need
 * stronger isolation here, wrap with the same HKDF/AES-GCM idiom
 * used by the OAuth stores.
 */
import { mkdir, readFile, readdir, unlink, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { atomicWriteFile } from '../../../../util/atomic-write.js'
import { homePaths } from '../../../../storage/layout.js'
import { ShelfItemSourceSchema, ShelfItemTypeSchema, ShelfItemPrioritySchema } from './types.js'

const DIR_MODE = 0o700
const FILE_MODE = 0o600

export const PendingApprovalSchema = z.object({
  schema_version: z.literal(1),
  approval_token: z.string().min(1),
  embassy_agent: z.string().min(1),
  /** OAuth client_id the embassy serves (target_model is derived from the conduit). */
  client_id: z.string().min(1),
  proposed: z.object({
    type: ShelfItemTypeSchema,
    source: ShelfItemSourceSchema,
    target_model: z.string().min(1),
    priority: ShelfItemPrioritySchema,
    body: z.string().min(1),
    /** Embassy's reasoning for the placement; embedded in the Inbox card. */
    reasoning: z.string().min(1),
  }),
  /** Notification id paired to this pending approval. */
  notification_id: z.string().min(1),
  created_at: z.string().min(1),
})
export type PendingApproval = z.infer<typeof PendingApprovalSchema>

export function newApprovalToken(): string {
  // 16 random bytes -> 22-char base64url -> short enough to be human-pasteable, long enough to be unguessable.
  return `appr_${randomBytes(16).toString('base64url')}`
}

function approvalDir(home: string): string {
  return join(homePaths(home).state, 'connector', 'embassy-approvals')
}

function approvalPath(home: string, token: string): string {
  return join(approvalDir(home), `${token}.json`)
}

export async function saveApproval(home: string, record: PendingApproval): Promise<void> {
  PendingApprovalSchema.parse(record)
  await mkdir(approvalDir(home), { recursive: true, mode: DIR_MODE })
  const path = approvalPath(home, record.approval_token)
  await atomicWriteFile(path, JSON.stringify(record, null, 2))
  await chmod(path, FILE_MODE)
}

export async function readApproval(home: string, token: string): Promise<PendingApproval | null> {
  const path = approvalPath(home, token)
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  return PendingApprovalSchema.parse(JSON.parse(raw))
}

export async function deleteApproval(home: string, token: string): Promise<boolean> {
  try {
    await unlink(approvalPath(home, token))
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/** List every pending approval. Used by a future operator surface. */
export async function listApprovals(home: string): Promise<PendingApproval[]> {
  let entries: string[]
  try {
    entries = await readdir(approvalDir(home))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: PendingApproval[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const token = entry.slice(0, -'.json'.length)
    const r = await readApproval(home, token).catch(() => null)
    if (r !== null) out.push(r)
  }
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at))
}
