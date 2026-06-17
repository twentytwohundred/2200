/**
 * Pub member view: collapse the pub-server's registrations into the list the
 * UI should show.
 *
 * The bundled pub-server (0.3.3) keys agent uniqueness on display_name, has no
 * `GET /agents/me` and no delete route, so a re-registered Agent leaves a
 * SHADOW entry behind (same agent_name, a stale agent_id) that we cannot
 * remove from the store. This builder produces exactly ONE row per live Agent
 * at its CURRENT registered id (resolved from the Agent's cred), carries the
 * canonical `agent_name`, and drops the stale shadows ... plus the operator
 * and any non-Agent participant. Fail-open: a live Agent whose current id we
 * could not resolve (unreadable cred) keeps its roster rows, so a transient
 * read error never hides a live Agent.
 *
 * Pure + IO-free so the merge logic is unit-tested without a live pub.
 */

export interface MemberViewRosterEntry {
  agent_id: string
  agent_name: string
  display_name: string
}

export interface MemberViewPresent {
  agent_id: string
  display_name: string
  status: string
}

export interface MemberViewLiveAgent {
  /** Local Agent name (agent_name). */
  name: string
  running: boolean
  /** The Agent's current registered id for this pub, or null if unresolved. */
  currentId: string | null
}

export interface PubMemberView {
  agent_id: string
  /** Canonical Agent name, or null for the operator / a non-Agent guest. */
  agent_name: string | null
  display_name: string
  status: string
}

export interface MemberViewInput {
  roster: readonly MemberViewRosterEntry[]
  /** Live room participants, with the pub-server `house` greeter already removed. */
  present: readonly MemberViewPresent[]
  liveAgents: readonly MemberViewLiveAgent[]
}

export function buildPubMembers(input: MemberViewInput): PubMemberView[] {
  const currentIdByName = new Map<string, string>()
  const liveNames = new Set<string>()
  const runningNames = new Set<string>()
  for (const a of input.liveAgents) {
    liveNames.add(a.name)
    if (a.running) runningNames.add(a.name)
    if (a.currentId) currentIdByName.set(a.name, a.currentId)
  }

  const nameByRosterId = new Map<string, string>()
  const displayByRosterId = new Map<string, string>()
  for (const r of input.roster) {
    nameByRosterId.set(r.agent_id, r.agent_name)
    displayByRosterId.set(r.agent_id, r.display_name)
  }

  // Stale shadow ids: a roster id for a live Agent whose current id is known
  // but differs (the leftover the pub-server can't delete).
  const staleIds = new Set<string>()
  for (const r of input.roster) {
    const cur = currentIdByName.get(r.agent_name)
    if (cur && r.agent_id !== cur) staleIds.add(r.agent_id)
  }

  const presentById = new Map<string, MemberViewPresent>()
  for (const p of input.present) presentById.set(p.agent_id, p)

  const out = new Map<string, PubMemberView>()

  // 1. One canonical row per live Agent at its current registered id.
  for (const name of liveNames) {
    const id = currentIdByName.get(name)
    if (!id) continue // not yet registered in this pub
    const present = presentById.get(id)
    out.set(id, {
      agent_id: id,
      agent_name: name,
      display_name: displayByRosterId.get(id) ?? present?.display_name ?? name,
      status: present ? present.status : runningNames.has(name) ? 'idle' : 'offline',
    })
  }

  // 2. Present participants that aren't a live Agent's current row and aren't
  //    a stale shadow ... the operator and any genuine guest.
  for (const [id, p] of presentById) {
    if (out.has(id) || staleIds.has(id)) continue
    const agentName = nameByRosterId.get(id) ?? null
    if (agentName && currentIdByName.get(agentName) && currentIdByName.get(agentName) !== id) {
      continue // stale id for a live Agent
    }
    out.set(id, {
      agent_id: id,
      agent_name: agentName,
      display_name: p.display_name,
      status: p.status,
    })
  }

  // 3. Fail-open: a live Agent whose current id we couldn't resolve (unreadable
  //    cred) was skipped in (1); surface its roster rows so a transient read
  //    error never hides a live Agent.
  for (const r of input.roster) {
    if (out.has(r.agent_id) || staleIds.has(r.agent_id)) continue
    if (!liveNames.has(r.agent_name)) continue // deleted/archived Agent
    if (currentIdByName.has(r.agent_name)) continue // current id already emitted in (1)
    out.set(r.agent_id, {
      agent_id: r.agent_id,
      agent_name: r.agent_name,
      display_name: r.display_name,
      status: runningNames.has(r.agent_name) ? 'idle' : 'offline',
    })
  }

  return Array.from(out.values())
}
