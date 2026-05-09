/**
 * Cross-Agent brain read permissions (Epic 8 Phase C).
 *
 * Each Agent owns a small permissions file at
 *
 *   <home>/state/brain/<owner_agent>/permissions.json
 *
 * listing the agents that may read its private brain. Default
 * permission set is empty: no other Agent can read until the owner
 * (or the operator via `2200 brain permissions`) grants access.
 *
 * The check happens at tool-dispatch time: `brain_search_agent` and
 * `brain_list_agent` consult `canReadBrain(home, owner, caller)`
 * before opening the owner's index. The owner Agent's writer
 * continues to use a read-write handle; cross-Agent readers open
 * the same SQLite file with `?mode=ro` so there is no second writer.
 *
 * The permissions file is JSON (not markdown) because it is metadata,
 * not Agent-authored content. Lives under `state/brain/...` next to
 * the FTS5 index for the same reason. Schema-versioned, mode 0600.
 */
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { atomicWriteFile } from '../util/atomic-write.js'
import { agentBrainIndexPath } from '../storage/layout.js'

export const BRAIN_PERMISSIONS_SCHEMA_VERSION = 1 as const

export const BrainPermissionsSchema = z.object({
  schema_version: z.literal(BRAIN_PERMISSIONS_SCHEMA_VERSION),
  /** Agent names allowed to read the owner's private brain. */
  readers: z.array(z.string().min(1)).default([]),
  /** Last modified, ISO 8601 UTC. */
  updated_at: z.string(),
})
export type BrainPermissions = z.infer<typeof BrainPermissionsSchema>

/**
 * Path of the permissions file for an Agent. Lives next to the
 * Agent's brain.db so a single state-tree subtree owns the brain
 * substrate for that Agent.
 */
export function brainPermissionsPath(home: string, ownerAgent: string): string {
  // Reuse the existing helper to anchor under <state>/brain/<owner>/.
  return join(dirname(agentBrainIndexPath(home, ownerAgent)), 'permissions.json')
}

/**
 * Read the permissions file. Returns a default empty record if no
 * file exists yet. Throws on JSON / schema errors.
 */
export async function readBrainPermissions(
  home: string,
  ownerAgent: string,
): Promise<BrainPermissions> {
  const path = brainPermissionsPath(home, ownerAgent)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        schema_version: BRAIN_PERMISSIONS_SCHEMA_VERSION,
        readers: [],
        updated_at: new Date(0).toISOString(),
      }
    }
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return BrainPermissionsSchema.parse(parsed)
}

/**
 * Replace the permissions file with `readers`. The list is de-duped
 * + sorted on write so the file diffs cleanly under git.
 */
export async function writeBrainPermissions(
  home: string,
  ownerAgent: string,
  readers: readonly string[],
  now: () => Date = () => new Date(),
): Promise<BrainPermissions> {
  const path = brainPermissionsPath(home, ownerAgent)
  await mkdir(dirname(path), { recursive: true })
  const dedupedSorted = [...new Set(readers)].sort((a, b) => a.localeCompare(b))
  const record: BrainPermissions = {
    schema_version: BRAIN_PERMISSIONS_SCHEMA_VERSION,
    readers: dedupedSorted,
    updated_at: now().toISOString(),
  }
  await atomicWriteFile(path, `${JSON.stringify(record, null, 2)}\n`)
  return record
}

/** Add `reader` to the owner's permissions. Idempotent. */
export async function grantBrainRead(
  home: string,
  ownerAgent: string,
  reader: string,
): Promise<BrainPermissions> {
  const cur = await readBrainPermissions(home, ownerAgent)
  if (cur.readers.includes(reader)) return cur
  return writeBrainPermissions(home, ownerAgent, [...cur.readers, reader])
}

/** Remove `reader` from the owner's permissions. Idempotent. */
export async function revokeBrainRead(
  home: string,
  ownerAgent: string,
  reader: string,
): Promise<BrainPermissions> {
  const cur = await readBrainPermissions(home, ownerAgent)
  if (!cur.readers.includes(reader)) return cur
  return writeBrainPermissions(
    home,
    ownerAgent,
    cur.readers.filter((r) => r !== reader),
  )
}

/**
 * Check whether `caller` may read `owner`'s private brain. An Agent
 * can always read its own brain.
 */
export async function canReadBrain(
  home: string,
  ownerAgent: string,
  callerAgent: string,
): Promise<boolean> {
  if (ownerAgent === callerAgent) return true
  const perms = await readBrainPermissions(home, ownerAgent)
  return perms.readers.includes(callerAgent)
}

export class BrainPermissionDeniedError extends Error {
  constructor(
    public readonly ownerAgent: string,
    public readonly callerAgent: string,
  ) {
    super(
      `agent "${callerAgent}" is not authorized to read "${ownerAgent}"'s brain (owner can grant via \`2200 brain permissions ${ownerAgent} --add ${callerAgent}\`)`,
    )
    this.name = 'BrainPermissionDeniedError'
  }
}
