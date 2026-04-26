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
import { mkdir, copyFile, writeFile } from 'node:fs/promises'
import { homePaths, agentPaths, pubPaths, assertPubName } from './layout.js'
import { atomicWriteFile } from '../util/atomic-write.js'

export async function initHome(home: string): Promise<void> {
  const paths = homePaths(home)
  // Order does not matter for mkdir { recursive: true }; we list the
  // leaf-most directories so a single sweep creates everything above.
  const dirs = [
    paths.commonsReference,
    paths.commonsScratch,
    paths.agents,
    paths.stateNotifications,
    paths.stateOpenpub,
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

/**
 * Per-pub directory creation and PUB.md write. Called by
 * `Supervisor.createPub`.
 *
 * Creates `<home>/state/openpub/<pub_name>/{data/}` and writes the PUB.md
 * config file at `<home>/state/openpub/<pub_name>/PUB.md` atomically. The
 * caller composes the PUB.md content (it is openpub-server's config
 * format, owned by `@openpub-ai/pub-server`); this function just
 * ensures the directory exists and writes the bytes safely.
 *
 * Throws if a pub by that name already has a PUB.md (refuse to
 * silently overwrite the user's pub config). Re-creating a pub is
 * an explicit `pub delete` followed by `pub create`.
 */
export async function initPubDirs(
  home: string,
  pubName: string,
  pubMdContent: string,
): Promise<void> {
  assertPubName(pubName)
  const paths = pubPaths(home, pubName)
  await mkdir(paths.root, { recursive: true })
  await mkdir(paths.data, { recursive: true })
  // Use writeFile with `wx` flag to fail if PUB.md already exists.
  // atomicWriteFile would clobber on rename; we want a hard "already
  // exists" error here so the caller can distinguish create-new from
  // re-create.
  try {
    await writeFile(paths.pubMd, pubMdContent, { encoding: 'utf8', flag: 'wx' })
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'EEXIST') {
      throw new Error(
        `pub "${pubName}" already exists at ${paths.pubMd}; delete it first or pick a different name`,
      )
    }
    throw err
  }
}

/**
 * Atomic update of an existing PUB.md (e.g., when bumping the
 * description or capacity through a future `pub set` command).
 * Differs from `initPubDirs` in that it expects PUB.md to already
 * exist and overwrites it via temp+rename.
 */
export async function writePubMd(
  home: string,
  pubName: string,
  pubMdContent: string,
): Promise<void> {
  assertPubName(pubName)
  const paths = pubPaths(home, pubName)
  await atomicWriteFile(paths.pubMd, pubMdContent)
}
