/**
 * Scheduler service (Epic 6 PR B).
 *
 * Lives in the supervisor process. On start: scans every Agent's
 * <home>/state/agents/<name>/schedules/*.json, computes next-fire
 * times for every enabled entry, and arms a setTimeout per entry.
 * On fire: enqueues a synthetic task into the Agent's TaskStore,
 * records the fire (which recomputes next_fire_at), and re-arms the
 * timer.
 *
 * `reload(home)` re-scans the disk state, replacing all timers
 * cleanly. The CLI calls this RPC after `2200 schedule add /
 * remove / enable / disable` so a running supervisor picks up
 * changes without a restart.
 *
 * Catch-up policy: SKIP missed firings. If next_fire_at is in the
 * past at scan time, the Scheduler computes a fresh next_fire_at
 * forward from now() and arms the timer for that. This means a
 * supervisor that was offline for 6 hours doesn't fire 6 hourly
 * schedules in a burst when it comes back; it fires the next
 * scheduled time and continues.
 */
import { readdir } from 'node:fs/promises'
import { TaskStore } from '../agent/task/store.js'
import { newPendingTask } from '../agent/task/types.js'
import { newTaskId } from '../util/id.js'
import { createLogger, type Logger } from '../util/logger.js'
import { homePaths } from '../storage/layout.js'
import {
  listSchedules,
  nextFireTime,
  recordFired,
  readSchedule,
  type ScheduleEntry,
} from './schedule.js'
import {
  listAllExtensionSchedules,
  readExtensionSchedule,
  recordExtensionScheduleFired,
  nextExtensionFireTime,
  extensionScheduleJobKey,
  type ExtensionScheduleEntry,
} from '../extensions/schedules.js'
import { readExtension } from '../extensions/registry.js'
import { readGrants, hasGrant } from '../extensions/grants.js'
import { runHook, type HookExecResult } from '../extensions/hooks.js'

export interface SchedulerOptions {
  home: string
  /** Injected for tests. Defaults to () => new Date(). */
  now?: () => Date
  /** Injected for tests. Defaults to setTimeout. */
  setTimer?: (cb: () => void, ms: number) => NodeJS.Timeout
  /** Injected for tests. Defaults to clearTimeout. */
  clearTimer?: (handle: NodeJS.Timeout) => void
  logger?: Logger
}

export class Scheduler {
  private readonly home: string
  private readonly nowFn: () => Date
  private readonly setTimer: (cb: () => void, ms: number) => NodeJS.Timeout
  private readonly clearTimer: (handle: NodeJS.Timeout) => void
  private readonly log: Logger

  /** Per-Agent schedule id → timer handle. Cleared and rebuilt on reload. */
  private readonly timers = new Map<string, NodeJS.Timeout>()
  /**
   * Per-Extension schedule timers, keyed by `extension:<name>:<id>`
   * to disambiguate from Agent schedule ids in the same logical pool.
   * Cleared and rebuilt on reload.
   */
  private readonly extensionTimers = new Map<string, NodeJS.Timeout>()
  private started = false

  constructor(opts: SchedulerOptions) {
    this.home = opts.home
    this.nowFn = opts.now ?? (() => new Date())
    this.setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
    this.clearTimer =
      opts.clearTimer ??
      ((h) => {
        clearTimeout(h)
      })
    this.log = opts.logger ?? createLogger('scheduler')
  }

  /**
   * Scan disk and arm timers for every enabled schedule. Idempotent;
   * subsequent calls clear and re-arm. Returns the number of armed
   * schedules so the supervisor can log it.
   */
  async start(): Promise<number> {
    this.stop()
    const agentEntries = await this.scanAll()
    const extensionEntries = await listAllExtensionSchedules(this.home)
    let armed = 0
    for (const entry of agentEntries) {
      if (!entry.enabled) continue
      this.arm(entry)
      armed += 1
    }
    for (const entry of extensionEntries) {
      if (!entry.enabled) continue
      this.armExtension(entry)
      armed += 1
    }
    this.started = true
    this.log.info('scheduler started', { armed })
    return armed
  }

  /** Clear all timers. Safe to call before start(). */
  stop(): void {
    for (const t of this.timers.values()) this.clearTimer(t)
    this.timers.clear()
    for (const t of this.extensionTimers.values()) this.clearTimer(t)
    this.extensionTimers.clear()
    this.started = false
  }

  /**
   * Re-scan disk and re-arm. The CLI's `2200 schedule add/remove/
   * enable` RPCs into here so a running supervisor picks up changes
   * without restart.
   */
  async reload(): Promise<number> {
    return this.start()
  }

  /** True after start() until stop(). Useful for supervisor health. */
  isRunning(): boolean {
    return this.started
  }

  /** Number of currently-armed timers (Agent + Extension schedules). */
  armedCount(): number {
    return this.timers.size + this.extensionTimers.size
  }

  /**
   * Manually trigger a schedule's firing right now. Reads the entry,
   * enqueues a synthetic task into the Agent's TaskStore, and returns
   * the new task's id. Does NOT update `last_fired_at` or
   * `next_fire_at`: a manual run-once is independent of the schedule
   * cadence (the next automatic firing happens at its originally
   * computed time).
   *
   * Used by `2200 schedule run-once` (PR C) for testing/debug.
   */
  async runOnce(agentName: string, scheduleId: string): Promise<string> {
    const entry = await readSchedule(this.home, agentName, scheduleId)
    return this.enqueueSyntheticTask(entry)
  }

  // --- internals -----------------------------------------------------------

  private async scanAll(): Promise<ScheduleEntry[]> {
    const agentsDir = homePaths(this.home).agents
    let agentNames: string[]
    try {
      agentNames = await readdir(agentsDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const out: ScheduleEntry[] = []
    for (const name of agentNames) {
      const list = await listSchedules(this.home, name)
      out.push(...list)
    }
    return out
  }

  /**
   * Arm the timer for a single schedule. Computes the firing delay
   * relative to nowFn() and the entry's next_fire_at; if the next
   * fire is in the past (e.g., supervisor was offline), recomputes
   * forward and arms for that.
   */
  private arm(entry: ScheduleEntry): void {
    const now = this.nowFn()
    let nextIso = entry.next_fire_at
    if (nextIso === null || Date.parse(nextIso) <= now.getTime()) {
      nextIso = nextFireTime(entry.timing, now)
      if (nextIso === null) {
        this.log.warn('schedule has no future fire time; not arming', {
          id: entry.id,
          agent: entry.agent,
        })
        return
      }
    }
    const delayMs = Math.max(0, Date.parse(nextIso) - now.getTime())
    const handle = this.setTimer(() => {
      void this.fire(entry.id, entry.agent)
    }, delayMs)
    this.timers.set(entry.id, handle)
    this.log.info('schedule armed', {
      id: entry.id,
      agent: entry.agent,
      next_fire_at: nextIso,
      delay_ms: delayMs,
    })
  }

  /**
   * Timer callback: re-read the entry (it may have been disabled
   * since we armed), enqueue a synthetic task, recordFired, and
   * arm the next timer.
   */
  private async fire(scheduleId: string, agentName: string): Promise<void> {
    this.timers.delete(scheduleId)
    let entry: ScheduleEntry
    try {
      entry = await readSchedule(this.home, agentName, scheduleId)
    } catch (err) {
      this.log.warn('schedule disappeared between arm and fire; skipping', {
        id: scheduleId,
        agent: agentName,
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }
    if (!entry.enabled) {
      this.log.info('schedule disabled before fire; skipping', {
        id: scheduleId,
        agent: agentName,
      })
      return
    }

    try {
      await this.enqueueSyntheticTask(entry)
      const updated = await recordFired(this.home, agentName, scheduleId, this.nowFn)
      // Arm the next firing.
      if (updated.enabled && updated.next_fire_at !== null) {
        this.arm(updated)
      }
    } catch (err) {
      this.log.error('schedule fire failed', {
        id: scheduleId,
        agent: agentName,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** Write a synthetic task into the Agent's TaskStore; returns its id. */
  private async enqueueSyntheticTask(entry: ScheduleEntry): Promise<string> {
    const store = new TaskStore(this.home, entry.agent)
    const taskId = newTaskId()
    const title = entry.description.length > 0 ? entry.description : `scheduled: ${entry.id}`
    const task = newPendingTask({
      id: taskId,
      agent: entry.agent,
      title,
      body: entry.prompt,
      // Scheduled tasks default to `pure` idempotency: if the agent
      // restarts mid-task, the body is re-prompted and the model
      // recomputes. Operators who need checkpointed behavior (long-
      // running scheduled work) can override per task in a future
      // PR; v1 keeps it simple.
      idempotency: 'pure',
      priority: 0,
      now: this.nowFn,
    })
    await store.save(task)
    this.log.info('schedule fired; synthetic task enqueued', {
      id: entry.id,
      agent: entry.agent,
      task_id: taskId,
    })
    return taskId
  }

  // --- extension-schedule plumbing ---------------------------------------

  /**
   * Arm the timer for one extension schedule. The job key is the
   * composite `extension:<name>:<id>` so the timer pool stays
   * disambiguated from per-Agent schedules.
   */
  private armExtension(entry: ExtensionScheduleEntry): void {
    const now = this.nowFn()
    let nextIso = entry.next_fire_at
    if (nextIso === null || Date.parse(nextIso) <= now.getTime()) {
      nextIso = nextExtensionFireTime(entry.cron, now)
      if (nextIso === null) {
        this.log.warn('extension schedule has no future fire time; not arming', {
          extension: entry.extension_name,
          id: entry.id,
        })
        return
      }
    }
    const delayMs = Math.max(0, Date.parse(nextIso) - now.getTime())
    const key = extensionScheduleJobKey(entry.extension_name, entry.id)
    const handle = this.setTimer(() => {
      void this.fireExtension(entry.extension_name, entry.id)
    }, delayMs)
    this.extensionTimers.set(key, handle)
    this.log.info('extension schedule armed', {
      extension: entry.extension_name,
      id: entry.id,
      next_fire_at: nextIso,
      delay_ms: delayMs,
    })
  }

  /**
   * Timer callback for an extension schedule. Re-reads the entry,
   * runs the Extension's tick hook, records the fire, arms next.
   *
   * Hook failure (non-zero exit / timeout / launch error) is logged
   * but does NOT disable the schedule. Operators disable misbehaving
   * extension schedules explicitly via the CLI; the runtime never
   * silently turns them off.
   */
  private async fireExtension(extensionName: string, scheduleId: string): Promise<void> {
    const key = extensionScheduleJobKey(extensionName, scheduleId)
    this.extensionTimers.delete(key)
    let entry: ExtensionScheduleEntry
    try {
      entry = await readExtensionSchedule(this.home, extensionName, scheduleId)
    } catch (err) {
      this.log.warn('extension schedule disappeared between arm and fire; skipping', {
        extension: extensionName,
        id: scheduleId,
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }
    if (!entry.enabled) {
      this.log.info('extension schedule disabled before fire; skipping', {
        extension: extensionName,
        id: scheduleId,
      })
      return
    }

    // `hookResult` is set below ONLY on the runHook() path; both error
    // paths (no tick hook, permission missing) bail without assigning.
    // Declared without an initializer per @eslint/js v10's
    // no-useless-assignment.
    let hookResult: HookExecResult | null
    try {
      const ext = await readExtension(this.home, extensionName)
      const tickPath = ext.manifest.hooks.tick
      if (!tickPath) {
        this.log.warn(
          'extension schedule fired but manifest declares no tick hook; nothing to run',
          { extension: extensionName, id: scheduleId },
        )
      } else {
        const grants = await readGrants(this.home, extensionName)
        if (!hasGrant(grants, 'schedule')) {
          this.log.warn(
            'extension schedule fired but `schedule` permission is not granted; skipping tick',
            { extension: extensionName, id: scheduleId },
          )
        } else {
          hookResult = await runHook({
            home: this.home,
            name: extensionName,
            version: entry.extension_version,
            hook: 'tick',
            scriptRelative: tickPath,
            grants,
            scheduleId,
          })
          if (hookResult.exitCode !== 0 || hookResult.timedOut) {
            this.log.error('extension tick hook failed', {
              extension: extensionName,
              id: scheduleId,
              exit_code: hookResult.exitCode,
              timed_out: hookResult.timedOut,
              log_path: hookResult.logPath,
            })
          } else {
            this.log.info('extension tick hook ran', {
              extension: extensionName,
              id: scheduleId,
              duration_ms: hookResult.durationMs,
            })
          }
        }
      }
    } catch (err) {
      this.log.error('extension schedule fire failed', {
        extension: extensionName,
        id: scheduleId,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    try {
      const updated = await recordExtensionScheduleFired(
        this.home,
        extensionName,
        scheduleId,
        this.nowFn,
      )
      if (updated.enabled && updated.next_fire_at !== null) {
        this.armExtension(updated)
      }
    } catch (err) {
      this.log.error('extension schedule recordFired failed', {
        extension: extensionName,
        id: scheduleId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
