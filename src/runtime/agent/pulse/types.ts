/**
 * Pulse activity-state types (Epic 9 follow-on; Pulse v0.2 substrate).
 *
 * The pulse is the always-on visible UX layer for cost / behavior
 * awareness, per [[2026-04-24-cost-behavior-shape]] and [[pulse]].
 * The runtime emits a per-Agent state file at `<agents>/<name>/pulse.json`
 * that any UI surface (Studio, Office, mobile, menu bar, favicon) reads
 * to render the dot.
 *
 * Five active states + stopped, on a green-to-red gradient. The exact
 * UI rendering (color hex, animation curves) lives in the design spec;
 * the runtime contract is just the state enum + a numeric intensity in
 * [0, 1] so the UI can smooth between states without re-querying.
 *
 * Schema:
 *   v1 (Epic 2 trip handler) ... three states: 'green' | 'yellow' | 'redlined'.
 *   v2 (this PR) ... full Pulse-spec palette + intensity.
 *
 * The reader (`readPulse`) migrates v1 to v2 in-memory; existing on-disk
 * v1 records remain readable. Subsequent writes always emit v2.
 */
import { z } from 'zod'

export const PULSE_SCHEMA_VERSION = 2 as const

export const PulseStateName = z.enum([
  'resting',
  'working_light',
  'working_medium',
  'working_hard',
  'redlined',
  'stopped',
])
export type PulseStateName = z.infer<typeof PulseStateName>

/**
 * Persisted shape (v2). `intensity` is the smoothed activity metric in
 * [0, 1]; `state` is the band derived from intensity (with hysteresis
 * applied by the emitter so the dot does not jitter).
 *
 * `detector_kind` and `trip_id` are populated when the Agent is paused
 * by a detector trip; otherwise both null. When set, `state` is
 * `'redlined'` regardless of computed intensity.
 */
export const PulseStateSchema = z.object({
  schema_version: z.literal(PULSE_SCHEMA_VERSION),
  agent: z.string(),
  state: PulseStateName,
  intensity: z.number().min(0).max(1),
  detector_kind: z.string().nullable(),
  trip_id: z.string().nullable(),
  updated_at: z.string(),
})
export type PulseState = z.infer<typeof PulseStateSchema>

/**
 * v1 shape, kept for migration only. Newly-written records always use v2.
 */
export const PulseStateV1Schema = z.object({
  schema_version: z.literal(1),
  agent: z.string(),
  state: z.enum(['green', 'yellow', 'redlined']),
  detector_kind: z.string().nullable(),
  trip_id: z.string().nullable(),
  updated_at: z.string(),
})
export type PulseStateV1 = z.infer<typeof PulseStateV1Schema>

const V1_TO_V2_STATE: Record<PulseStateV1['state'], PulseStateName> = {
  green: 'resting',
  yellow: 'working_medium',
  redlined: 'redlined',
}

/**
 * Migrate a v1 record to v2 in-memory. Sets intensity to a sensible
 * default for the band (no historical telemetry to compute the real
 * value).
 */
export function migrateV1ToV2(v1: PulseStateV1): PulseState {
  const state = V1_TO_V2_STATE[v1.state]
  const intensity = state === 'resting' ? 0 : state === 'working_medium' ? 0.4 : 0.95
  return {
    schema_version: PULSE_SCHEMA_VERSION,
    agent: v1.agent,
    state,
    intensity,
    detector_kind: v1.detector_kind,
    trip_id: v1.trip_id,
    updated_at: v1.updated_at,
  }
}
