/**
 * Embassy routing helpers (Phase 2 / PR-B3).
 *
 * The connector tools (`contribute_to_thread`, `propose_work_package`,
 * `get_research_brief`, `get_fleet_context`) route their reads + writes
 * through the embassy that owns the conduit for the calling OAuth
 * `client_id`. This module is the single lookup surface.
 *
 * Backward-compat note (transitional, B3-only): when the caller
 * authenticated via static bearer (no client_id) OR no conduit is
 * registered for the client_id, the helpers return null and the
 * calling tool falls back to legacy ownerless-note behavior. The
 * `embassy-not-registered → legacy fallback` path is documented
 * inline at each call site; the long-term direction (after the
 * one-time migration runs) is embassy-required.
 */
import { listConduits, recordLastSeen } from './conduits.js'
import type { ConduitRecord } from './types.js'

export interface EmbassyContext {
  conduit: ConduitRecord
  /** Convenience: the embassy Agent name (where the brain lives). */
  embassyAgent: string
}

/**
 * Resolve the embassy for the calling OAuth client. Returns null
 * iff (a) the caller authenticated via static bearer (clientId
 * null), (b) no conduit is registered for the clientId, or (c) the
 * conduit is retired. Tools fall back to legacy behavior on null.
 */
export async function resolveCallingEmbassy(
  home: string,
  callingClientId: string | null,
): Promise<EmbassyContext | null> {
  if (callingClientId === null) return null
  const items = await listConduits(home)
  const match = items.find((c) => c.client_id === callingClientId && c.retired_at === null)
  if (match === undefined) return null
  // Touch last_seen so the conduits index reflects activity. Best-effort.
  await recordLastSeen(home, callingClientId, new Date()).catch(() => undefined)
  return { conduit: match, embassyAgent: match.embassy_agent }
}
