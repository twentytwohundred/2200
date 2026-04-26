/**
 * Detector trip record writer.
 *
 * Per the Epic 2 spec, every detector trip writes:
 *   1. A trip record at `<brain>/.records/detector-trips/<trip_id>.md`
 *      with frontmatter (kind, triggers, agent_state, threshold, resolution)
 *      and a markdown body summarizing the trip.
 *   2. A passive-tier notification record at
 *      `<state>/notifications/<notif_id>.md` (file-based stub at v1; full
 *      notification routing is Epic 7).
 *   3. An update to `<agents>/<name>/pulse.json` flipping the state to
 *      `redlined` with the trip kind. The Pulse / Behavior dashboard
 *      (Epics 15, 16) reads this; Epic 2 just emits it.
 *
 * Resolution is recorded by mutating the trip record's frontmatter when the
 * user resumes or stops the Agent (separate writer in `resolve-trip.ts`).
 */
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { stringify } from 'yaml'
import { atomicWriteFile, atomicWriteJson } from '../../util/atomic-write.js'
import { newDetectorTripId, newNotificationId } from '../../util/id.js'
import { agentPaths, homePaths } from '../../storage/layout.js'
import type { AgentStateSnapshot, DetectorThresholds, TripVerdict } from './types.js'

export interface TripRecordPersisted {
  trip_id: string
  notification_id: string
  trip_path: string
  notification_path: string
  pulse_path: string
}

export interface PulseState {
  schema_version: 1
  agent: string
  state: 'green' | 'yellow' | 'redlined'
  detector_kind: string | null
  trip_id: string | null
  /** ISO 8601 UTC. */
  updated_at: string
}

export interface WriteTripArgs {
  home: string
  agentName: string
  brainDir: string
  verdict: TripVerdict
  agentSnapshot: AgentStateSnapshot
  thresholds: DetectorThresholds
  now?: () => Date
}

const TRIP_FRONTMATTER_DELIM = '---'

export async function writeDetectorTrip(args: WriteTripArgs): Promise<TripRecordPersisted> {
  const now = args.now ?? (() => new Date())
  const tripId = newDetectorTripId()
  const notifId = newNotificationId()
  const ts = now().toISOString()

  const tripPath = join(args.brainDir, '.records', 'detector-trips', `${tripId}.md`)
  await mkdir(dirname(tripPath), { recursive: true })

  const tripFrontmatter = {
    schema_version: 1,
    id: tripId,
    ts,
    agent: args.agentName,
    kind: args.verdict.kind,
    task_id: args.agentSnapshot.current_task_id,
    triggers: args.verdict.triggers,
    threshold: args.thresholds,
    threshold_used: args.verdict.threshold_used,
    agent_state: args.agentSnapshot,
    resolution: null,
    notification_id: notifId,
  }
  const tripBody = `# Detector trip: ${args.verdict.kind}\n\n${args.verdict.detail}\n`
  const tripContent = `${TRIP_FRONTMATTER_DELIM}\n${stringify(tripFrontmatter, { lineWidth: 0 }).trimEnd()}\n${TRIP_FRONTMATTER_DELIM}\n${tripBody}`
  await atomicWriteFile(tripPath, tripContent)

  const paths = homePaths(args.home)
  const notifPath = join(paths.stateNotifications, `${notifId}.md`)
  await mkdir(dirname(notifPath), { recursive: true })
  const notifFrontmatter = {
    schema_version: 1,
    id: notifId,
    ts,
    tier: 'passive',
    agent: args.agentName,
    kind: 'detector_trip',
    detector_kind: args.verdict.kind,
    trip_id: tripId,
    task_id: args.agentSnapshot.current_task_id,
    state: 'pending',
  }
  const notifBody = `Agent **${args.agentName}** paused on **${args.verdict.kind}**.\n\n${args.verdict.detail}\n\nResume with: \`2200 agent resume ${args.agentName}\`\nStop with: \`2200 agent stop ${args.agentName}\`\n`
  const notifContent = `${TRIP_FRONTMATTER_DELIM}\n${stringify(notifFrontmatter, { lineWidth: 0 }).trimEnd()}\n${TRIP_FRONTMATTER_DELIM}\n${notifBody}`
  await atomicWriteFile(notifPath, notifContent)

  const pulsePath = join(agentPaths(args.home, args.agentName).root, 'pulse.json')
  await mkdir(dirname(pulsePath), { recursive: true })
  const pulse: PulseState = {
    schema_version: 1,
    agent: args.agentName,
    state: 'redlined',
    detector_kind: args.verdict.kind,
    trip_id: tripId,
    updated_at: ts,
  }
  await atomicWriteJson(pulsePath, pulse)

  return {
    trip_id: tripId,
    notification_id: notifId,
    trip_path: tripPath,
    notification_path: notifPath,
    pulse_path: pulsePath,
  }
}

/**
 * Reset pulse to green when the user resumes a paused Agent. Called from the
 * `cli.agent.resume` handler. The trip record itself is updated by a separate
 * writer that records the resolution {action, ts, by}.
 */
export async function resetPulseToGreen(args: {
  home: string
  agentName: string
  now?: () => Date
}): Promise<void> {
  const now = args.now ?? (() => new Date())
  const pulsePath = join(agentPaths(args.home, args.agentName).root, 'pulse.json')
  await mkdir(dirname(pulsePath), { recursive: true })
  const pulse: PulseState = {
    schema_version: 1,
    agent: args.agentName,
    state: 'green',
    detector_kind: null,
    trip_id: null,
    updated_at: now().toISOString(),
  }
  await atomicWriteJson(pulsePath, pulse)
}
