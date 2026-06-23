/**
 * Pub-server port disposition ... decide what to do with a pub's port before
 * (re)starting its server.
 *
 * The bug this prevents: a pub-server can outlive the supervisor that spawned
 * it (a `2200 update` restart, a SIGHUP self-upgrade, a crash that left the
 * child detached). On the next boot the fresh supervisor would launch a NEW
 * pub-server on the same recorded port, which dies immediately on EADDRINUSE
 * ... and the pub record flips to `errored`, so the Studio shows
 * `pub_not_running` (HTTP 409 on send) even though a perfectly healthy
 * pub-server is sitting right there on the port. (Observed live on valkyrie
 * after the 2026.623.1612 update: a Jun-17 pub-server held the port and every
 * relaunch collided.)
 *
 * The fix: before launching, look at the port.
 *   - A healthy pub-server is already listening  -> ADOPT it (no relaunch, no
 *     flap of the agents' WebSockets, no collision). The pub-bridge talks to
 *     the port over HTTP and does not care who spawned the server.
 *   - A listener is there but not responding (wedged/half-dead) -> RECLAIM
 *     (kill those pids) and launch fresh.
 *   - Nothing is on the port -> just LAUNCH.
 *
 * Pure + injectable (probe is passed in) so the branching is unit-tested
 * without real sockets or a real pub-server.
 */

export interface PubPortProbe {
  /** True if something answers HTTP on the port (a live pub-server ... a 404 still counts as "alive"). */
  isHealthy(port: number): Promise<boolean>
  /** PIDs currently LISTENing on the port (empty when none). */
  listeners(port: number): Promise<number[]>
}

export type PubPortPlan =
  | { action: 'adopt'; pid: number | null }
  | { action: 'reclaim-then-launch'; killPids: number[] }
  | { action: 'launch' }

/**
 * Decide how to bring up a pub-server on `port`. See module docs for the why.
 */
export async function planPubPort(port: number, probe: PubPortProbe): Promise<PubPortPlan> {
  if (await probe.isHealthy(port)) {
    // A live pub-server already serves this port. Adopt it rather than
    // launching a second one that would collide. Capture its pid (if we can
    // see it) so the supervisor can still stop it later.
    const pids = await probe.listeners(port)
    return { action: 'adopt', pid: pids[0] ?? null }
  }
  // Not responding. If a listener is still bound (wedged/dying), it must be
  // cleared or the imminent launch hits EADDRINUSE; otherwise the port is free.
  const pids = await probe.listeners(port)
  if (pids.length > 0) return { action: 'reclaim-then-launch', killPids: pids }
  return { action: 'launch' }
}
