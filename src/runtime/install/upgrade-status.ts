/**
 * Upgrade-status file substrate.
 *
 * When the operator triggers a self-upgrade from the web UI (POST
 * `/api/v1/system/update`), the daemon spawns a detached helper that
 * outlives the daemon's own shutdown. The helper needs a place to
 * record progress that the web app can poll once the new daemon comes
 * back up; the file at `<home>/state/upgrade-status.json` is that
 * place.
 *
 * The file is also how the new daemon, on boot, can answer "did the
 * last upgrade complete cleanly?" ... it just reads the file.
 *
 * Schema is intentionally narrow: a stage enum, the source and
 * target versions, a timestamp per transition, optional error.
 * Anything richer (per-step logs, byte counts) is out of scope.
 */
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { atomicWriteJson } from '../util/atomic-write.js'
import { homePaths } from '../storage/layout.js'
import { join } from 'node:path'
import { z } from 'zod'

/** All possible stages, in order. */
export const UpgradeStages = [
  'pending',
  'stopping_daemon',
  'installing',
  'restarting',
  'completed',
  'failed',
] as const

export type UpgradeStage = (typeof UpgradeStages)[number]

export const UpgradeStatusSchema = z.object({
  schema_version: z.literal(1),
  stage: z.enum(UpgradeStages),
  version_from: z.string(),
  version_to: z.string(),
  triggered_at: z.string(), // ISO8601
  updated_at: z.string(), // ISO8601, advances per stage
  finished_at: z.string().nullable(), // set when stage is 'completed' or 'failed'
  error: z.string().nullable(), // human-readable; populated on failed
})

export type UpgradeStatus = z.infer<typeof UpgradeStatusSchema>

/** Path to the upgrade-status file for a given home. */
export function upgradeStatusPath(home: string): string {
  return join(homePaths(home).state, 'upgrade-status.json')
}

/**
 * Read the current upgrade-status. Returns null when the file does
 * not exist (no upgrade has ever been triggered on this home).
 * Throws on a malformed file ... a corrupted status is a real
 * problem the operator needs to see.
 */
export async function readUpgradeStatus(home: string): Promise<UpgradeStatus | null> {
  const path = upgradeStatusPath(home)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if (isEnoent(err)) return null
    throw err
  }
  const parsed: unknown = JSON.parse(raw)
  return UpgradeStatusSchema.parse(parsed)
}

/**
 * Write the upgrade-status atomically. Creates the parent dir if
 * needed (defensive: the helper may run before the daemon has
 * finished initializing the home layout on a partial-install).
 */
export async function writeUpgradeStatus(home: string, status: UpgradeStatus): Promise<void> {
  const path = upgradeStatusPath(home)
  await mkdir(dirname(path), { recursive: true })
  await atomicWriteJson(path, status)
}

/**
 * Mutate the current status by advancing the stage and updating the
 * `updated_at` field. Convenience wrapper used by both the trigger
 * path and the detached helper.
 */
export async function advanceUpgradeStage(
  home: string,
  stage: UpgradeStage,
  opts: { error?: string } = {},
): Promise<UpgradeStatus> {
  const current = await readUpgradeStatus(home)
  if (current === null) {
    throw new Error(
      `cannot advance upgrade-status: no current status at ${upgradeStatusPath(home)}`,
    )
  }
  const now = new Date().toISOString()
  const next: UpgradeStatus = {
    ...current,
    stage,
    updated_at: now,
    finished_at: stage === 'completed' || stage === 'failed' ? now : current.finished_at,
    error: opts.error ?? current.error,
  }
  await writeUpgradeStatus(home, next)
  return next
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT'
}
