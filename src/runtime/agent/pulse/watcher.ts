/**
 * Pulse file watcher.
 *
 * The supervisor uses one of these per running agent to surface
 * pulse.json updates as `pulse.changed` events on the WebSocket
 * substrate. The web app's useLiveSignal hook consumes those events
 * and updates the agent's pulse in the TanStack Query cache so the
 * Fleet view's PulseDot animates without polling the agents endpoint.
 *
 * Implementation: polling, not fs.watch. The platform-portability
 * tax of fs.watch (Linux/macOS recursive-watch differences, no
 * coalesced-event guarantees) is real and the gain is negligible
 * here ... pulse.json updates are O(1 second) cadence anyway, so
 * 500ms polling catches most updates with bounded overhead. Same
 * argument the notification waitForResponse path makes
 * ([[../../notifications/writer.ts]]).
 *
 * Coalescing: the watcher tracks the last `updated_at` it emitted
 * and skips re-emits when nothing changed. That way an agent that
 * is fully idle does not generate WS traffic.
 */
import { createLogger, type Logger } from '../../util/logger.js'
import { readPulse } from './reader.js'
import type { PulseState } from './types.js'

export const DEFAULT_POLL_INTERVAL_MS = 500

export interface PulseWatcherOptions {
  home: string
  agentName: string
  /** Called with the new pulse on each detected change. */
  onChange: (pulse: PulseState) => void
  /** Override polling cadence (testing). */
  pollIntervalMs?: number
  /** Inject a clock (testing). */
  setTimer?: (cb: () => void, ms: number) => NodeJS.Timeout
  /** Inject a clock (testing). */
  clearTimer?: (handle: NodeJS.Timeout) => void
  logger?: Logger
}

export class PulseWatcher {
  private readonly home: string
  private readonly agentName: string
  private readonly onChange: (pulse: PulseState) => void
  private readonly pollIntervalMs: number
  private readonly setTimer: (cb: () => void, ms: number) => NodeJS.Timeout
  private readonly clearTimer: (handle: NodeJS.Timeout) => void
  private readonly log: Logger

  private timer: NodeJS.Timeout | null = null
  private lastUpdatedAt: string | null = null
  private running = false

  constructor(opts: PulseWatcherOptions) {
    this.home = opts.home
    this.agentName = opts.agentName
    this.onChange = opts.onChange
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
    this.clearTimer =
      opts.clearTimer ??
      ((h) => {
        clearTimeout(h)
      })
    this.log = opts.logger ?? createLogger(`pulse/watcher/${opts.agentName}`)
  }

  /**
   * Begin polling. Idempotent ... calling start() on an already-
   * running watcher is a no-op. The first poll fires immediately so
   * subscribers see the current state without waiting one interval.
   */
  start(): void {
    if (this.running) return
    this.running = true
    void this.poll()
  }

  /**
   * Stop polling. Idempotent. Subsequent start() calls reset
   * `lastUpdatedAt` so the first emit after restart re-broadcasts
   * even when the file has not changed since stop.
   */
  stop(): void {
    this.running = false
    if (this.timer) {
      this.clearTimer(this.timer)
      this.timer = null
    }
    this.lastUpdatedAt = null
  }

  /** True between start() and stop(). Useful for supervisor health. */
  isRunning(): boolean {
    return this.running
  }

  private async poll(): Promise<void> {
    if (!this.isRunning()) return
    try {
      const pulse = await readPulse(this.home, this.agentName)
      if (pulse && pulse.updated_at !== this.lastUpdatedAt) {
        this.lastUpdatedAt = pulse.updated_at
        try {
          this.onChange(pulse)
        } catch (err) {
          // The onChange callback is owned by the supervisor; do not
          // let a callback error stop the watcher.
          this.log.warn('onChange callback threw', {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    } catch (err) {
      // Tolerate transient read errors (file mid-write, ENOENT during
      // agent startup, malformed JSON during a torn write). Re-poll
      // on the next tick.
      this.log.debug('pulse read failed; re-polling', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    // stop() may have been called during the await above; re-check
    // before scheduling the next poll. Use the isRunning() accessor
    // so type-narrowing does not fold the condition to a constant.
    if (!this.isRunning()) return
    this.timer = this.setTimer(() => {
      void this.poll()
    }, this.pollIntervalMs)
  }
}
