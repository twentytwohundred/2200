/**
 * Pulse emitter: per-Agent activity-state writer.
 *
 * Lives inside the Agent process. Keeps a sliding window of recent
 * cost-bearing events (model calls, tool calls), maps the rolling
 * intensity to a Pulse state band, applies hysteresis so brief spikes
 * do not jitter the dot, and writes `<agents>/<name>/pulse.json`
 * on a periodic tick.
 *
 * Activity model (v1):
 *   - intensity = clamp01(sum(weights over the last N seconds) / target)
 *   - weights:
 *       model_call_end  ... cost_usd ($-denominated, normalized via target)
 *       tool_call_end   ... 0.005 USD-equivalent (placeholder; tools have
 *                            no first-class cost yet, so we treat each as
 *                            a small fixed weight to keep the dot honest
 *                            during tool-heavy stretches)
 *   - target: $0.10 / minute by default. A redlined Agent is one that is
 *     spending $0.10/min sustained.
 *
 * Bands (intensity → state):
 *     0.00 .. 0.05  resting
 *     0.05 .. 0.25  working_light
 *     0.25 .. 0.50  working_medium
 *     0.50 .. 0.85  working_hard
 *     0.85 .. 1.00  redlined
 *
 * Hysteresis: a state change "down" requires the intensity to fall
 * below the lower band for >= dwellMs (default 2s). State changes
 * "up" are immediate. This matches the spec's intent (redline should
 * appear when work spikes; calm down quickly is honest).
 *
 * The emitter does NOT compete with the trip handler. The trip handler
 * sets state='redlined' + a non-null `detector_kind` directly; the
 * emitter respects that pin until `clearTrip()` is called (typically
 * on `agent resume`).
 */
import { writeFile } from 'node:fs/promises'
import type { Logger } from '../../util/logger.js'
import { agentPaths } from '../../storage/layout.js'
import { join } from 'node:path'
import type { LoopEvent } from '../detectors/types.js'
import { PULSE_SCHEMA_VERSION, type PulseState, type PulseStateName } from './types.js'

const DEFAULT_WINDOW_MS = 60_000
const DEFAULT_TARGET_USD_PER_MINUTE = 0.1
const DEFAULT_TICK_MS = 250
const DEFAULT_DWELL_MS = 2_000
const TOOL_CALL_WEIGHT_USD = 0.005

interface WeightedEvent {
  at: number
  weightUsd: number
}

export interface PulseEmitterOptions {
  home: string
  agentName: string
  /** Sliding window for activity averaging. Default 60s. */
  windowMs?: number
  /** USD/min that maps to intensity 1.0. Default $0.10/min. */
  targetUsdPerMinute?: number
  /** How often to recompute + write the pulse file. Default 250ms (4 Hz). */
  tickMs?: number
  /** How long intensity must dwell below a band before the state drops. */
  dwellMs?: number
  /** Inject for tests. Default Date.now. */
  now?: () => number
  /** Inject for tests. Default setInterval. */
  setTimer?: (cb: () => void, ms: number) => NodeJS.Timeout
  /** Inject for tests. Default clearInterval. */
  clearTimer?: (h: NodeJS.Timeout) => void
  logger?: Logger
}

export class PulseEmitter {
  private readonly home: string
  private readonly agentName: string
  private readonly windowMs: number
  private readonly targetUsdPerWindow: number
  private readonly tickMs: number
  private readonly dwellMs: number
  private readonly nowFn: () => number
  private readonly setTimer: (cb: () => void, ms: number) => NodeJS.Timeout
  private readonly clearTimer: (h: NodeJS.Timeout) => void
  private readonly log: Logger | undefined

  private readonly events: WeightedEvent[] = []
  private currentState: PulseStateName = 'resting'
  private candidateState: PulseStateName = 'resting'
  private candidateSince = 0
  private detectorKind: string | null = null
  private tripId: string | null = null
  private timer: NodeJS.Timeout | null = null
  private writeInFlight = false

  constructor(opts: PulseEmitterOptions) {
    this.home = opts.home
    this.agentName = opts.agentName
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
    const usdPerMin = opts.targetUsdPerMinute ?? DEFAULT_TARGET_USD_PER_MINUTE
    this.targetUsdPerWindow = (usdPerMin * this.windowMs) / 60_000
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS
    this.dwellMs = opts.dwellMs ?? DEFAULT_DWELL_MS
    this.nowFn = opts.now ?? (() => Date.now())
    this.setTimer = opts.setTimer ?? ((cb, ms) => setInterval(cb, ms))
    this.clearTimer =
      opts.clearTimer ??
      ((h) => {
        clearInterval(h)
      })
    this.log = opts.logger
  }

  /** Begin periodic ticks. Idempotent. */
  start(): void {
    if (this.timer) return
    this.candidateSince = this.nowFn()
    this.timer = this.setTimer(() => {
      void this.tick()
    }, this.tickMs)
  }

  /**
   * Stop ticks and write a final 'stopped' state. The trip pin is
   * cleared so a future Agent restart resumes from a clean slate.
   */
  async stop(): Promise<void> {
    if (this.timer) {
      this.clearTimer(this.timer)
      this.timer = null
    }
    this.events.length = 0
    this.currentState = 'stopped'
    this.candidateState = 'stopped'
    this.detectorKind = null
    this.tripId = null
    await this.write()
  }

  /**
   * Record a loop event. Cost-bearing events advance the intensity;
   * other events are ignored. Safe to call from any code path that
   * already has a LoopEvent.
   */
  record(event: LoopEvent): void {
    if (event.kind === 'model_call_end') {
      this.events.push({ at: event.at, weightUsd: event.cost_usd })
    } else if (event.kind === 'tool_call_end') {
      this.events.push({ at: event.at, weightUsd: TOOL_CALL_WEIGHT_USD })
    }
  }

  /**
   * Pin the dot to redlined with a detector trip. Called by the
   * trip handler. Subsequent intensity computation is ignored until
   * `clearTrip()`.
   */
  setTrip(detectorKind: string, tripId: string): void {
    this.detectorKind = detectorKind
    this.tripId = tripId
    this.currentState = 'redlined'
    this.candidateState = 'redlined'
  }

  /**
   * Clear the trip pin (called on `agent resume`). The dot snaps
   * synchronously to the band implied by current intensity ... a
   * trip clear is a discrete event and should not need to wait
   * out the normal downward-dwell window.
   */
  clearTrip(): void {
    this.detectorKind = null
    this.tripId = null
    const intensity = this.computeIntensity()
    const banded = bandFor(intensity)
    this.currentState = banded
    this.candidateState = banded
    this.candidateSince = this.nowFn()
  }

  /** Public for tests; one-cycle compute + write. */
  async tick(): Promise<void> {
    this.compute()
    await this.write()
  }

  /** Read the current state without persisting. Exposed for tests. */
  snapshot(): { state: PulseStateName; intensity: number } {
    return {
      state: this.currentState,
      intensity: this.computeIntensity(),
    }
  }

  // -------------------------------------------------------------------------

  private compute(): void {
    if (this.detectorKind !== null) {
      // Trip pin: dot stays redlined regardless of intensity.
      this.currentState = 'redlined'
      this.candidateState = 'redlined'
      return
    }
    const intensity = this.computeIntensity()
    const banded = bandFor(intensity)
    const now = this.nowFn()
    if (banded === this.currentState) {
      this.candidateState = banded
      this.candidateSince = now
      return
    }
    if (rankOf(banded) > rankOf(this.currentState)) {
      // Upward transitions are immediate.
      this.currentState = banded
      this.candidateState = banded
      this.candidateSince = now
      return
    }
    // Downward: wait for dwell.
    if (banded !== this.candidateState) {
      this.candidateState = banded
      this.candidateSince = now
      return
    }
    if (now - this.candidateSince >= this.dwellMs) {
      this.currentState = banded
    }
  }

  private computeIntensity(): number {
    const cutoff = this.nowFn() - this.windowMs
    while (this.events.length > 0 && (this.events[0]?.at ?? 0) < cutoff) {
      this.events.shift()
    }
    const total = this.events.reduce((sum, e) => sum + e.weightUsd, 0)
    if (this.targetUsdPerWindow <= 0) return 0
    return Math.min(1, Math.max(0, total / this.targetUsdPerWindow))
  }

  private async write(): Promise<void> {
    if (this.writeInFlight) return
    this.writeInFlight = true
    try {
      const path = join(agentPaths(this.home, this.agentName).root, 'pulse.json')
      const state: PulseState = {
        schema_version: PULSE_SCHEMA_VERSION,
        agent: this.agentName,
        state: this.currentState,
        intensity: roundTo(this.computeIntensity(), 4),
        detector_kind: this.detectorKind,
        trip_id: this.tripId,
        updated_at: new Date(this.nowFn()).toISOString(),
      }
      await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    } catch (err) {
      this.log?.warn('pulse write failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      this.writeInFlight = false
    }
  }
}

const BAND_RANKS: Record<PulseStateName, number> = {
  stopped: -1,
  resting: 0,
  working_light: 1,
  working_medium: 2,
  working_hard: 3,
  redlined: 4,
}

function rankOf(state: PulseStateName): number {
  return BAND_RANKS[state]
}

export function bandFor(intensity: number): PulseStateName {
  if (intensity < 0.05) return 'resting'
  if (intensity < 0.25) return 'working_light'
  if (intensity < 0.5) return 'working_medium'
  if (intensity < 0.85) return 'working_hard'
  return 'redlined'
}

function roundTo(n: number, places: number): number {
  const f = 10 ** places
  return Math.round(n * f) / f
}
