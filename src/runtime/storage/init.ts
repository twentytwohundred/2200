/**
 * Initialize the 2200_HOME directory structure.
 *
 * Creates the seed layout (commons/{reference,scratch}, agents/, state/,
 * config/). Idempotent: running on an existing structure is a no-op
 * (mkdir -p semantics). Does not create per-Agent directories; those
 * land on `agent create`.
 *
 * Per [[2026-04-26-commons-and-storage-root]], the runtime creates the
 * structure but does not police what users put inside. The structure
 * is convention; users can deviate (`commons/clients/<acme>/...` etc.)
 * and the runtime keeps working.
 */
import { mkdir } from 'node:fs/promises'
import { homePaths, agentPaths } from './layout.js'
import { copyFile } from 'node:fs/promises'

export async function initHome(home: string): Promise<void> {
  const paths = homePaths(home)
  // Order does not matter for mkdir { recursive: true }; we list the
  // leaf-most directories so a single sweep creates everything above.
  const dirs = [
    paths.commonsReference,
    paths.commonsScratch,
    paths.agents,
    paths.stateNotifications,
    paths.config,
  ]
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true })
  }
}

/**
 * Create the per-Agent directory structure. Called by
 * `supervisor.createAgent`. Copies the user-provided Identity file into
 * the canonical location at `agents/<name>/identity.md` (per the
 * commons-spec addendum, choice (a)).
 */
export async function initAgentDirs(
  home: string,
  name: string,
  sourceIdentityPath: string,
): Promise<void> {
  const paths = agentPaths(home, name)
  await mkdir(paths.root, { recursive: true })
  await mkdir(paths.project, { recursive: true })
  await mkdir(paths.brain, { recursive: true })
  await mkdir(paths.shared, { recursive: true })
  // Copy the Identity into the canonical location so the runtime owns
  // the file's location while the user/Agent owns its contents. If the
  // source IS the canonical path (re-run case), copyFile is a no-op
  // overwrite of the same content.
  if (sourceIdentityPath !== paths.identity) {
    await copyFile(sourceIdentityPath, paths.identity)
  }
}
