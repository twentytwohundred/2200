/**
 * Identity migrator chain.
 *
 * Per [[upgrade-readiness]] discipline 1, persisted artifacts carry an
 * integer `schema_version` and the loader tolerates older versions by
 * running the registered migrators in sequence. Each migrator is a pure
 * function `(prev) => next` named `<from>-to-<to>.ts`.
 *
 * The current version is `2`.
 *  - `0-to-1.ts` is a stub from the original schema; no real v0 ever shipped.
 *  - `1-to-2.ts` introduces the `cost_caps` block (Epic 4.5).
 *
 * When v3 lands, register `2-to-3.ts` here. Likely v3 lands when Epic 4
 * Phase A (SCUT identity at spawn) ships; that adds the `scut` block.
 */
import { migrate0To1 } from './0-to-1.js'
import { migrate1To2 } from './1-to-2.js'

const CURRENT_VERSION = 2

/** Pull a `schema_version` from a parsed YAML object, defaulting to 0. */
function detectVersion(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0
  const v = (value as Record<string, unknown>)['schema_version']
  if (typeof v === 'number' && Number.isInteger(v)) return v
  // Tolerate string versions on read for the historical-document case.
  if (typeof v === 'string') {
    const parsed = Number.parseFloat(v)
    if (Number.isFinite(parsed)) return Math.floor(parsed)
  }
  return 0
}

/**
 * Run the migrator chain to bring a parsed Identity frontmatter from
 * whatever version it carries up to the current version. Throws if the
 * source version is newer than CURRENT_VERSION (loader was built against
 * an older spec; refuse to read future shapes).
 */
export function migrateToCurrent(value: unknown): unknown {
  const fromVersion = detectVersion(value)
  if (fromVersion > CURRENT_VERSION) {
    throw new Error(
      `Identity schema_version ${String(fromVersion)} is newer than this loader supports (${String(CURRENT_VERSION)}). Upgrade the runtime to read this Identity.`,
    )
  }

  let current = value
  let v = fromVersion
  while (v < CURRENT_VERSION) {
    if (v === 0) {
      current = migrate0To1(current)
      v = 1
      continue
    }
    if (v === 1) {
      current = migrate1To2(current)
      v = 2
      continue
    }
    throw new Error(`no migrator registered for Identity v${String(v)} -> v${String(v + 1)}`)
  }
  return current
}
