/**
 * Supervisor state types.
 *
 * The supervisor's persisted state lives at `<state-dir>/supervisor.json` per
 * upgrade-readiness #2 (state on disk). The shape here mirrors the
 * `StateSnapshotResult` from the control-plane protocol so the same
 * vocabulary travels across the wire and onto disk.
 */
import type { AgentRecord, PubRecord, StateSnapshotResult } from '../control-plane/protocol.js'

/** The on-disk shape of `<state-dir>/supervisor.json`. */
export type SupervisorState = StateSnapshotResult

/** Re-exported for callers in this directory. */
export type { AgentRecord, PubRecord }

/**
 * Make a fresh `SupervisorState` rooted at the given 2200_HOME with no
 * Agents.
 *
 * `home` is the user-chosen 2200_HOME root per
 * https://github.com/twentytwohundred/wiki/blob/main/decisions/2026-04-26-commons-and-storage-root.md;
 * `state_dir` is its `state/` subdirectory.
 *
 * `schema_version` is an integer per
 * https://github.com/twentytwohundred/wiki/blob/main/decisions/2026-04-26-schema-version-format.md;
 * v1 is `1`. Future shape changes bump the integer and ship a migrator
 * at `src/runtime/supervisor/migrators/<from>-to-<to>.ts`.
 */
import { join } from 'node:path'

export function emptyState(home: string): SupervisorState {
  return {
    schema_version: 1,
    home,
    state_dir: join(home, 'state'),
    agents: {},
    pubs: {},
  }
}
