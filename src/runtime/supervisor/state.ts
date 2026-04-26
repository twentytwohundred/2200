/**
 * Supervisor state persistence.
 *
 * `loadState(stateDir)` reads `<state-dir>/supervisor.json` and validates it
 * against the schema. If the file does not exist, returns an empty state.
 * If the file exists but is malformed, throws (caller decides recovery).
 *
 * `saveState(state)` writes atomically via the util's temp-and-rename, so
 * crashes mid-write never leave a torn file. Per upgrade-readiness #2.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { StateSnapshotResultSchema } from '../control-plane/protocol.js'
import { atomicWriteJson } from '../util/atomic-write.js'
import { emptyState, type SupervisorState } from './types.js'

const STATE_FILENAME = 'supervisor.json'

export function stateFilePath(stateDir: string): string {
  return join(stateDir, STATE_FILENAME)
}

/**
 * Load supervisor state from `<state-dir>/supervisor.json`. Returns an empty
 * state when the file does not exist (first boot). Throws if the file
 * exists but cannot be parsed or fails schema validation; recovery from
 * corruption is the caller's call.
 */
export async function loadState(stateDir: string): Promise<SupervisorState> {
  const path = stateFilePath(stateDir)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if (isNodeNotFoundError(err)) {
      return emptyState(stateDir)
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

  // Pin the state_dir to the current path; if the user moves the state dir,
  // the on-disk record is updated to match.
  return { ...result.data, state_dir: stateDir }
}

/**
 * Persist supervisor state to `<state-dir>/supervisor.json` atomically.
 * Creates `<state-dir>` if it does not exist.
 */
export async function saveState(state: SupervisorState): Promise<void> {
  await mkdir(state.state_dir, { recursive: true })
  await atomicWriteJson(stateFilePath(state.state_dir), state)
}

function isNodeNotFoundError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT'
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
