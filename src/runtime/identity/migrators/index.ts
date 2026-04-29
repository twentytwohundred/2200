/**
 * Identity migrator chain.
 *
 * Per [[upgrade-readiness]] discipline 1, persisted artifacts carry an
 * integer `schema_version` and the loader tolerates older versions by
 * running the registered migrators in sequence. Each migrator is a pure
 * function `(prev) => next` named `<from>-to-<to>.ts`.
 *
 * The current version is `5`.
 *  - `0-to-1.ts` is a stub from the original schema; no real v0 ever shipped.
 *  - `1-to-2.ts` introduces the `cost_caps` block (Epic 4.5).
 *  - `2-to-3.ts` introduces the optional `scut` block (Epic 4 Phase A).
 *  - `3-to-4.ts` introduces the `notification_policy` block (Epic 7).
 *  - `4-to-5.ts` introduces the `mcp_servers` block (Epic 9 Phase A).
 */
import { migrate0To1 } from './0-to-1.js'
import { migrate1To2 } from './1-to-2.js'
import { migrate2To3 } from './2-to-3.js'
import { migrate3To4 } from './3-to-4.js'
import { migrate4To5 } from './4-to-5.js'

const CURRENT_VERSION = 5

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
    if (v === 2) {
      current = migrate2To3(current)
      v = 3
      continue
    }
    if (v === 3) {
      current = migrate3To4(current)
      v = 4
      continue
    }
    if (v === 4) {
      current = migrate4To5(current)
      v = 5
      continue
    }
    throw new Error(`no migrator registered for Identity v${String(v)} -> v${String(v + 1)}`)
  }
  return current
}
