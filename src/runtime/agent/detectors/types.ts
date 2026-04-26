/**
 * Detector framework types.
 *
 * Per the Epic 2 spec ([[02-agent-runtime-minimum]]), detectors guard the
 * Agent loop against the worst-case failure modes (tool loops, no progress,
 * single-call timeouts, cost runaway, error storms). They emit a stream of
 * detector trips that Pulse and the Behavior dashboard consume; v1 ships the
 * data substrate, the UI epics surface it.
 *
 * The detector substrate is a stream of `LoopEvent`s (model calls, tool
 * dispatches, brain writes, state transitions). Each detector is a pure
 * function over a recent slice of that stream plus the configured thresholds.
 *
 * Placement: detectors are co-located with the Agent loop (in-process). The
 * spec leaves placement as an implementation call ("supervisor or a small
 * detector co-located with the Agent loop"); in-process keeps the latency
 * tight and gives detectors access to the full event stream without a copy
 * across the UDS.
 *
 * Determinism: detectors run in a fixed order ([[ACTIVE_DETECTORS]] below).
 * The first to fire wins. The trip record carries the kind, so consumers can
 * still tell which detector matched.
 */
import type { DetectorKind, TaskIdempotency } from '../../control-plane/protocol.js'

/** Stable hash of tool args, used by the tool_repetition detector. */
export type ArgsHash = string

/**
 * Atomic event the loop emits as it runs. The detector evaluator reads a
 * bounded ring buffer of these to make its trip decisions.
 *
 * `at` on every event is unix epoch ms (number, not ISO string) so windowed
 * detectors (cost_burst) can subtract timestamps without parsing.
 */
export type LoopEvent =
  | {
      kind: 'model_call_start'
      at: number
      model: string
      iteration: number
    }
  | {
      kind: 'model_call_end'
      at: number
      model: string
      iteration: number
      /** Estimated USD cost of this call. */
      cost_usd: number
      finish_reason: string
    }
  | {
      kind: 'tool_call_start'
      at: number
      call_id: string
      tool: string
      args_hash: ArgsHash
      iteration: number
    }
  | {
      kind: 'tool_call_end'
      at: number
      call_id: string
      tool: string
      args_hash: ArgsHash
      iteration: number
      ok: boolean
      /** Wall-clock duration in ms. */
      duration_ms: number
      /** When `ok = false`, the error class name. */
      error_class?: string
    }
  | {
      kind: 'brain_write'
      at: number
      path: string
      iteration: number
    }
  | {
      kind: 'state_transition'
      at: number
      from: string
      to: string
      iteration: number
    }

/** Snapshot of the Agent's runtime state at trip time. */
export interface AgentStateSnapshot {
  agent_name: string
  current_task_id: string | null
  task_idempotency: TaskIdempotency | null
  iteration: number
  /** Most recent state transitions. */
  recent_state: string
}

/**
 * Configurable thresholds. Defaults per the spec; per-Agent overrides via
 * Identity (a future PR threads thresholds from Identity into the loop).
 */
export interface DetectorThresholds {
  tool_repetition_n: number
  no_progress_iterations: number
  tool_timeout_ms: number
  cost_burst_window_ms: number
  cost_burst_usd: number
  error_storm_n: number
}

export const DEFAULT_THRESHOLDS: DetectorThresholds = {
  tool_repetition_n: 5,
  no_progress_iterations: 50,
  tool_timeout_ms: 120_000,
  cost_burst_window_ms: 10 * 60 * 1000,
  cost_burst_usd: 5,
  error_storm_n: 5,
}

/**
 * A trip verdict from a detector. `triggers` references the LoopEvent ids that
 * supported the match; v1 uses call_ids and a synthetic event index for
 * model/state-transition events. `detail` is a human-readable explanation.
 */
export interface TripVerdict {
  kind: DetectorKind
  detail: string
  triggers: string[]
  threshold_used: Partial<DetectorThresholds>
}

export interface DetectorContext {
  events: readonly LoopEvent[]
  agent: AgentStateSnapshot
  thresholds: DetectorThresholds
  now: () => number
}

export interface Detector {
  kind: DetectorKind
  evaluate(ctx: DetectorContext): TripVerdict | null
}
