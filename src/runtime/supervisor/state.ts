/**
 * Supervisor state persistence.
 *
 * `loadState(home)` reads `<home>/state/supervisor.json` per the layout
 * locked in [[2026-04-26-commons-and-storage-root]]. Returns an empty
 * state when the file does not exist (first boot). Throws on JSON or
 * schema-validation failure.
 *
 * `saveState(state)` writes atomically via temp-and-rename, so crashes
 * mid-write never leave a torn file. Per upgrade-readiness #2.
 */
import { readFile, mkdir } from 'node:fs/promises'
import { StateSnapshotResultSchema } from '../control-plane/protocol.js'
import { atomicWriteJson } from '../util/atomic-write.js'
import { homePaths } from '../storage/layout.js'
import { emptyState, type SupervisorState } from './types.js'

/** Path to the supervisor.json under a given 2200_HOME. */
export function stateFilePath(home: string): string {
  return homePaths(home).stateSupervisorJson
}

/**
 * Load supervisor state from `<home>/state/supervisor.json`. Returns an
 * empty state when the file does not exist (first boot). Throws if the
 * file exists but cannot be parsed or fails schema validation; recovery
 * from corruption is the caller's call.
 */
export async function loadState(home: string): Promise<SupervisorState> {
  const path = stateFilePath(home)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if (isNodeNotFoundError(err)) {
      return emptyState(home)
    }
    throw err
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`supervisor.json is not valid JSON at ${path}: ${stringifyErr(err)}`)
  }

  const result = StateSnapshotResultSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(
      `supervisor.json fails schema validation at ${path}: ${JSON.stringify(result.error.issues)}`,
    )
  }

  // Pin home and state_dir to the current path; if the user moves the
  // home directory, the on-disk record is updated to match on next save.
  const paths = homePaths(home)
  return { ...result.data, home, state_dir: paths.state }
}

/**
 * Persist supervisor state to `<home>/state/supervisor.json` atomically.
 * Creates `<home>/state/` if it does not exist.
 */
export async function saveState(state: SupervisorState): Promise<void> {
  const paths = homePaths(state.home)
  await mkdir(paths.state, { recursive: true })
  await atomicWriteJson(paths.stateSupervisorJson, state)
}

function isNodeNotFoundError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT'
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
