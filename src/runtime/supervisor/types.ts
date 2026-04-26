/**
 * Supervisor state types.
 *
 * The supervisor's persisted state lives at `<state-dir>/supervisor.json` per
 * upgrade-readiness #2 (state on disk). The shape here mirrors the
 * `StateSnapshotResult` from the control-plane protocol so the same
 * vocabulary travels across the wire and onto disk.
 */
import type { AgentRecord, StateSnapshotResult } from '../control-plane/protocol.js'

/** The on-disk shape of `<state-dir>/supervisor.json`. */
export type SupervisorState = StateSnapshotResult

/** Re-exported for callers in this directory. */
export type { AgentRecord }

/**
 * Make a fresh `SupervisorState` rooted at `stateDir` with no Agents.
 *
 * `schema_version` is an integer per
 * https://github.com/twentytwohundred/.github/wiki/2026-04-26-schema-version-format;
 * v1 is `1`. Future shape changes bump the integer and ship a migrator
 * at `src/runtime/supervisor/migrators/<from>-to-<to>.ts`.
 */
export function emptyState(stateDir: string): SupervisorState {
  return {
    schema_version: 1,
    state_dir: stateDir,
    agents: {},
  }
}
