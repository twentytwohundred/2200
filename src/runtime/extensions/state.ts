/**
 * Per-Extension state bag (Epic 12 Phase B).
 *
 * Every installed Extension gets a small JSON key-value bag at:
 *
 *   <home>/state/extensions/<name>/state.json
 *
 * The bag is a place for the install hook to leave config the
 * uninstall and update hooks can read back (e.g., "I created cron
 * job X with handle Y"; "I cached this OAuth client id"; "I
 * remember the user said yes to the optional secondary integration").
 * The runtime does not interpret the contents; this is the
 * Extension's private working space.
 *
 * Constraints (deliberate at v1):
 *   - Top-level shape is a flat string→json object. Nested objects are
 *     fine inside values; the top-level key set is just stringly-keyed.
 *   - Total file size capped at 1 MiB. Anything heavier wants its own
 *     storage (database, file under scratch/).
 *   - Atomic writes via temp-and-rename so a crash mid-write cannot
 *     leave a torn file.
 *
 * Hooks read/write this bag through the `EXTENSION_STATE_FILE` env
 * var the executor exposes. A hook that wants to keep a fact across
 * lifecycle events does so by reading + merging + writing this file.
 *
 * State persists across `install → update → uninstall`. The
 * `uninstall` hook gets a final read; the supervisor wipes the file
 * after the hook returns successfully.
 */
import { readFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { atomicWriteJson } from '../util/atomic-write.js'
import { extensionStatePaths } from '../storage/layout.js'

/** Maximum on-disk size for an Extension's state.json. */
export const EXTENSION_STATE_MAX_BYTES = 1 << 20 // 1 MiB

export type ExtensionStateValue =
  | string
  | number
  | boolean
  | null
  | ExtensionStateValue[]
  | { [key: string]: ExtensionStateValue }

export type ExtensionState = Record<string, ExtensionStateValue>

export class ExtensionStateError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`Extension state at ${path}: ${message}`)
    this.name = 'ExtensionStateError'
  }
}

function statePath(home: string, name: string): string {
  return extensionStatePaths(home, name).state
}

/**
 * Read the Extension's state bag. A missing file resolves to an
 * empty object. Malformed JSON throws. Files larger than the cap
 * throw without parsing; this prevents a malicious or buggy hook
 * from blowing up memory by writing a multi-GB blob.
 */
export async function readExtensionState(home: string, name: string): Promise<ExtensionState> {
  const path = statePath(home, name)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
  if (raw.length > EXTENSION_STATE_MAX_BYTES) {
    throw new ExtensionStateError(
      path,
      `state file is ${String(raw.length)} bytes, exceeds ${String(EXTENSION_STATE_MAX_BYTES)}`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new ExtensionStateError(
      path,
      `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ExtensionStateError(path, 'top-level value must be a JSON object')
  }
  return parsed as ExtensionState
}

/**
 * Write the Extension's state bag atomically. Creates the parent
 * directory if absent. Caps the serialized payload at the size limit;
 * an oversized write throws without touching disk.
 */
export async function writeExtensionState(
  home: string,
  name: string,
  state: ExtensionState,
): Promise<void> {
  const path = statePath(home, name)
  const serialized = JSON.stringify(state, null, 2) + '\n'
  if (serialized.length > EXTENSION_STATE_MAX_BYTES) {
    throw new ExtensionStateError(
      path,
      `serialized state is ${String(serialized.length)} bytes, exceeds ${String(EXTENSION_STATE_MAX_BYTES)}`,
    )
  }
  await mkdir(dirname(path), { recursive: true })
  await atomicWriteJson(path, state)
}
