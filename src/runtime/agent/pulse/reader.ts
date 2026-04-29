/**
 * Pulse reader (UI-side). Loads `<agents>/<name>/pulse.json` and
 * migrates v1 records to v2 in-memory. Newly-written records by the
 * emitter are always v2.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentPaths } from '../../storage/layout.js'
import { migrateV1ToV2, PulseStateSchema, PulseStateV1Schema, type PulseState } from './types.js'

/**
 * Read the current pulse state for an Agent. Returns null when no
 * pulse.json exists yet (Agent has never run on this home). Throws on
 * malformed JSON or unknown schema version.
 */
export async function readPulse(home: string, agentName: string): Promise<PulseState | null> {
  const path = join(agentPaths(home, agentName).root, 'pulse.json')
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `pulse.json at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  // Try v2 first.
  const v2 = PulseStateSchema.safeParse(parsed)
  if (v2.success) return v2.data
  const v1 = PulseStateV1Schema.safeParse(parsed)
  if (v1.success) return migrateV1ToV2(v1.data)
  throw new Error(`pulse.json at ${path} has an unrecognized shape`)
}
