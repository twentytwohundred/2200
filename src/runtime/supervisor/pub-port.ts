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
 *
 * ──────────────────────────────────────────────────────────────────────────
 * THE PUB ADOPTION / ORPHAN / OVERLAY STORY (read this before touching any of
 * the pieces below ... they interlock, and getting one wrong reintroduces the
 * "Studio 409 / agents dropped after restart" class of bug):
 *
 *  1. PATCH OVERLAY ... the bundled OpenPub pub-server must carry 2200's
 *     keepalive + Bartender-off patch. `scripts/bundle-pub-server-patch.mjs`
 *     ships it into the tarball (and FAILS the build if the marker is absent);
 *     `ensurePubServerPatched` (pub-lifecycle.ts) overlays it onto the
 *     installed copy at launch, probing bundle depths. Tested in
 *     tests/runtime/supervisor/pub-server-patch.test.ts.
 *  2. STARTING A PUB ... `Supervisor.startPub` (supervisor.ts) calls
 *     `planPubPort` (here) BEFORE launching: adopt a healthy server already on
 *     the port, reclaim a wedged one, or launch fresh. This is what stops a
 *     relaunch from colliding with an orphan (EADDRINUSE -> errored -> 409).
 *  3. RECLAIMING A PORT ... `killOrphanOnPort` / `listenersOnPort`
 *     (supervisor.ts) SIGKILL whatever LISTENs on a port. Used by the
 *     'reclaim-then-launch' branch.
 *  4. BOOT REVIVAL ... `recoverFromState` (supervisor.ts) adopts a still-alive
 *     pub-server by recorded pid, else reclaims + restarts. `ensureStudioPub`
 *     then runs `startPub('studio')` every boot (idempotent via step 2).
 *  5. GATEWAY ORPHANS ... connector gateways have their OWN sweep,
 *     `sweepOrphanGateways` (http/server.ts), pid/port from each gateway.json.
 *
 * Residual risk (known, lower severity): the reaping in (3) and (5) is
 * best-effort SIGTERM/SIGKILL with no process-tree reaping ... a child that
 * ignores signals can linger. The from-tarball install smoke
 * (scripts/smoke-install.sh) is the end-to-end guard over (1)(2)(4).
 * ──────────────────────────────────────────────────────────────────────────
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
