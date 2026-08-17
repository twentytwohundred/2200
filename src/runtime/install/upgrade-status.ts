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

/**
 * How long a non-terminal stage may sit without advancing before we
 * conclude the helper is gone. The whole upgrade is bounded well under
 * this: the daemon-exit wait times out at 60s and an `npm install -g`
 * of this package runs in seconds.
 */
export const STALE_UPGRADE_MS = 5 * 60 * 1000

/**
 * Resolve a status the helper abandoned.
 *
 * The upgrade helper writes progress to disk and can die between
 * stages, and when it does nothing ever corrects the record. The web
 * UI then reports "UPGRADING" forever ... including, absurdly, an
 * upgrade *to the version already running*, which is what the operator
 * sees after upgrading by any route other than the web button.
 *
 * This is the same defect shape as tasks stranded in `running` (see
 * agent/orphaned-tasks.ts): a process writes an in-progress state, dies,
 * and nothing re-examines that state on the way back up. Worth
 * remembering as a pattern ... any state machine whose transitions are
 * owned by a process that can die needs someone to check its work.
 *
 * Two resolutions, both from evidence rather than guesswork:
 *
 *   - `version_to` equals the version now running → the upgrade
 *     happened. It does not matter whether this helper finished it, a
 *     later `2200 update` did, or the operator installed by hand; the
 *     recorded goal is met, so the record says completed.
 *   - The stage has not advanced in STALE_UPGRADE_MS and the version
 *     did NOT change → nobody is coming. Record it as failed, naming
 *     the stage it died at so the operator can see how far it got.
 *
 * A genuinely in-flight upgrade (recent, version not yet changed) is
 * left alone.
 *
 * Returns the (possibly corrected) status, and persists any correction
 * so every other reader sees the truth too.
 */
export async function reconcileUpgradeStatus(
  home: string,
  currentVersion: string,
  now: () => Date = (): Date => new Date(),
): Promise<UpgradeStatus | null> {
  let status: UpgradeStatus | null
  try {
    status = await readUpgradeStatus(home)
  } catch {
    // A malformed status file is surfaced by the normal read path;
    // reconciliation is not the place to decide what to do about it.
    return null
  }
  if (status === null) return null
  if (status.stage === 'completed' || status.stage === 'failed') return status

  const nowIso = now().toISOString()

  if (status.version_to === currentVersion) {
    const resolved: UpgradeStatus = {
      ...status,
      stage: 'completed',
      updated_at: nowIso,
      finished_at: nowIso,
    }
    await writeUpgradeStatus(home, resolved)
    return resolved
  }

  const age = now().getTime() - Date.parse(status.updated_at)
  if (Number.isFinite(age) && age > STALE_UPGRADE_MS) {
    const resolved: UpgradeStatus = {
      ...status,
      stage: 'failed',
      updated_at: nowIso,
      finished_at: nowIso,
      error:
        status.error ??
        `The upgrade helper stopped at "${status.stage}" and did not resume. ` +
          `Still running ${currentVersion}. Upgrade from the CLI with \`2200 update\`.`,
    }
    await writeUpgradeStatus(home, resolved)
    return resolved
  }

  return status
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT'
}
