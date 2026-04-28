/**
 * Per-Agent BudgetTracker (Epic 4.5).
 *
 * Lives in the Agent process alongside the AgentLoop. Tracks cumulative
 * model-call spend for the current UTC day, fires threshold
 * notifications, and exposes a block flag the loop checks before
 * starting a new task.
 *
 * Two thresholds:
 *
 *   - `warn_at_pct` (default 80): tier-2 (Important) notification fires
 *     once on first crossing.
 *   - 100% (the cap itself): tier-1 (Critical) notification fires; the
 *     `blocked` flag is set; the loop refuses to start the next task.
 *
 * State persistence:
 *
 *   <home>/state/budget/<agent_name>/YYYY-MM-DD.json
 *
 * Replay on init: the tracker scans today's telemetry JSONL and
 * recomputes cumulative spend. This makes the tracker restart-safe per
 * [[upgrade-readiness]] discipline 3... a process restart resumes
 * mid-day without losing or double-counting.
 *
 * The currently-running task continues mid-call after the cap is
 * crossed (per spec: no mid-call interruption). The block fires on the
 * next `loop.run(task)` invocation. PR E (override / reset) lifts the
 * block manually; midnight UTC reset clears it automatically by writing
 * a fresh state file for the new day.
 */
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { agentBudgetDir, agentTelemetryDir, homePaths } from '../storage/layout.js'
import { atomicWriteFile, atomicWriteJson } from '../util/atomic-write.js'
import { newNotificationId } from '../util/id.js'
import { createLogger, type Logger } from '../util/logger.js'
import { stringify } from 'yaml'

function readFileSyncSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export const BUDGET_STATE_SCHEMA_VERSION = 1
export const BUDGET_OVERRIDE_SCHEMA_VERSION = 1
export const BUDGET_NOTIFICATION_KIND_WARN = 'budget_warn' as const
export const BUDGET_NOTIFICATION_KIND_BLOCK = 'budget_block' as const

/** Persisted per-day budget state. */
export interface BudgetState {
  schema_version: 1
  /** UTC day, "YYYY-MM-DD" */
  day: string
  agent: string
  cumulative_usd: number
  cap_usd: number
  warn_at_pct: number
  warned_today: boolean
  blocked: boolean
  /** ISO timestamp of the most recent record, useful for the dashboard. */
  last_recorded_at: string | null
}

/**
 * Persisted budget override (PR E). When present and unexpired, the
 * BudgetTracker's `isBlocked()` returns false even if the cap has been
 * crossed. Lifts the block manually for a user-chosen window without
 * resetting the cumulative... the spend keeps accumulating, but new
 * tasks are not refused until the override expires.
 */
export interface BudgetOverride {
  schema_version: 1
  /** When the override was set. */
  set_at: string
  /** ISO timestamp at which the override expires. */
  until: string
  /** Free-form note for audit. */
  reason: string
}

export interface BudgetTrackerOptions {
  agentName: string
  home: string
  capUsd: number
  warnAtPct?: number
  /** Injected for tests. */
  now?: () => Date
  logger?: Logger
}

const FRONTMATTER_DELIM = '---'

export class BudgetTracker {
  private readonly agentName: string
  private readonly home: string
  private readonly capUsd: number
  private readonly warnAtPct: number
  private readonly nowFn: () => Date
  private readonly log: Logger

  private cumulative = 0
  private warnedToday = false
  private blocked = false
  private lastRecordedAt: string | null = null
  private inited = false

  constructor(opts: BudgetTrackerOptions) {
    this.agentName = opts.agentName
    this.home = opts.home
    this.capUsd = opts.capUsd
    this.warnAtPct = opts.warnAtPct ?? 80
    this.nowFn = opts.now ?? (() => new Date())
    this.log = opts.logger ?? createLogger(`agent/budget-tracker/${opts.agentName}`)
  }

  /**
   * Replay today's telemetry JSONL to compute cumulative spend, then
   * load any existing state file (for `warned_today` continuity across
   * restarts). Idempotent... safe to call multiple times.
   */
  async init(): Promise<void> {
    if (this.inited) return
    const day = this.todayString()
    const replayed = await this.replayTelemetry(day)
    this.cumulative = replayed
    this.lastRecordedAt = null

    // Load prior state file to recover warned_today; it's the only
    // field the JSONL replay can't reconstruct (the JSONL doesn't
    // record whether a notification fired, only the spend).
    const existing = await this.loadStateFile(day)
    if (existing?.day === day) {
      this.warnedToday = existing.warned_today
      // Trust replay over the stored cumulative (telemetry is the source
      // of truth). But if they disagree by more than a cent, log it.
      if (Math.abs(existing.cumulative_usd - this.cumulative) > 0.01) {
        this.log.warn('budget state cumulative disagrees with telemetry replay', {
          stored: existing.cumulative_usd,
          replayed: this.cumulative,
        })
      }
      this.lastRecordedAt = existing.last_recorded_at
    }

    // Set blocked flag based on replayed cumulative.
    this.blocked = this.cumulative >= this.capUsd

    await this.persist()
    this.inited = true
  }

  /**
   * Record one model call's cost. No-op when costUsd is null
   * (unknown-pricing case) or zero. Crosses the warn threshold at most
   * once per day; sets the block flag on first crossing of the cap.
   * Threshold notifications fire inline.
   */
  async record(costUsd: number | null): Promise<void> {
    if (!this.inited) {
      throw new Error('BudgetTracker.record() called before init()')
    }
    if (costUsd === null || costUsd <= 0) return

    const dayBefore = this.todayString()
    const prev = this.cumulative

    // Day rollover: if we crossed UTC midnight since the last record,
    // reset cumulative to zero before adding the new charge. The
    // previous day's state file stays where it is for `2200 usage` to
    // read.
    if (this.lastRecordedAt !== null) {
      const lastDay = this.lastRecordedAt.slice(0, 10)
      if (lastDay !== dayBefore) {
        this.cumulative = 0
        this.warnedToday = false
        this.blocked = false
      }
    }

    this.cumulative += costUsd
    this.lastRecordedAt = this.nowFn().toISOString()

    const warnThreshold = (this.capUsd * this.warnAtPct) / 100
    const justCrossedWarn =
      !this.warnedToday && prev < warnThreshold && this.cumulative >= warnThreshold
    const justCrossedCap = !this.blocked && this.cumulative >= this.capUsd

    if (justCrossedWarn) {
      this.warnedToday = true
    }
    if (justCrossedCap) {
      this.blocked = true
    }

    await this.persist()

    if (justCrossedWarn) {
      await this.fireNotification('warn')
    }
    if (justCrossedCap) {
      await this.fireNotification('block')
    }
  }

  /**
   * The loop calls this before starting a new task. Returns true when
   * the agent is over its daily cap and there is no unexpired
   * override. The override file is read each call so a CLI-set override
   * takes effect immediately without a process restart.
   */
  isBlocked(): boolean {
    if (!this.blocked) return false
    const override = this.loadOverrideSync()
    if (override === null) return true
    const now = this.nowFn().getTime()
    const until = Date.parse(override.until)
    if (Number.isNaN(until)) return true
    return until <= now
  }

  /**
   * Read the override file for the current Agent if present. Returns
   * null when the file does not exist, is malformed, or has the wrong
   * schema_version. Synchronous (uses readFileSync) because
   * `isBlocked()` is on the hot path of the loop and must not be
   * async-tainted upstream.
   */
  private loadOverrideSync(): BudgetOverride | null {
    try {
      const raw = readFileSyncSafe(this.overridePath())
      if (raw === null) return null
      const parsed = JSON.parse(raw) as Partial<BudgetOverride>
      if (
        parsed.schema_version !== BUDGET_OVERRIDE_SCHEMA_VERSION ||
        typeof parsed.until !== 'string'
      ) {
        return null
      }
      return parsed as BudgetOverride
    } catch {
      return null
    }
  }

  overridePath(): string {
    return join(agentBudgetDir(this.home, this.agentName), 'override.json')
  }

  /** Current cumulative spend for today, USD. */
  getCumulative(): number {
    return this.cumulative
  }

  getCap(): number {
    return this.capUsd
  }

  /** State snapshot, useful for tests and the dashboard. */
  snapshot(): BudgetState {
    return {
      schema_version: BUDGET_STATE_SCHEMA_VERSION,
      day: this.todayString(),
      agent: this.agentName,
      cumulative_usd: this.cumulative,
      cap_usd: this.capUsd,
      warn_at_pct: this.warnAtPct,
      warned_today: this.warnedToday,
      blocked: this.blocked,
      last_recorded_at: this.lastRecordedAt,
    }
  }

  // --- internals -----------------------------------------------------------

  private todayString(): string {
    return this.nowFn().toISOString().slice(0, 10)
  }

  private stateFilePath(day: string): string {
    return join(agentBudgetDir(this.home, this.agentName), `${day}.json`)
  }

  private async loadStateFile(day: string): Promise<BudgetState | null> {
    try {
      const raw = await readFile(this.stateFilePath(day), 'utf8')
      return JSON.parse(raw) as BudgetState
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  private async persist(): Promise<void> {
    const day = this.todayString()
    const path = this.stateFilePath(day)
    await mkdir(dirname(path), { recursive: true })
    await atomicWriteJson(path, this.snapshot())
  }

  /**
   * Sum cost_usd across today's telemetry JSONL file. Lines with
   * cost_usd === null (unknown pricing) are ignored... they can't
   * contribute to a budget the user sees in dollar terms.
   */
  private async replayTelemetry(day: string): Promise<number> {
    const dir = agentTelemetryDir(this.home, this.agentName)
    const path = join(dir, `${day}.jsonl`)
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw err
    }
    let total = 0
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue
      try {
        const rec = JSON.parse(line) as { cost_usd?: number | null; status?: string }
        if (typeof rec.cost_usd === 'number') {
          total += rec.cost_usd
        }
      } catch {
        // Tolerate a torn final line from a crash mid-write.
        this.log.warn('skipping malformed telemetry line during replay')
      }
    }
    return total
  }

  /** Has telemetry directory been touched at all today? */
  async hasReplayedTelemetry(): Promise<boolean> {
    const dir = agentTelemetryDir(this.home, this.agentName)
    try {
      const entries = await readdir(dir)
      return entries.some((e) => e.endsWith('.jsonl'))
    } catch {
      return false
    }
  }

  private async fireNotification(kind: 'warn' | 'block'): Promise<void> {
    const ts = this.nowFn().toISOString()
    const id = newNotificationId()
    const tier = kind === 'warn' ? 'important' : 'critical'
    const notifKind =
      kind === 'warn' ? BUDGET_NOTIFICATION_KIND_WARN : BUDGET_NOTIFICATION_KIND_BLOCK
    const fm = {
      schema_version: 1,
      id,
      ts,
      tier,
      agent: this.agentName,
      kind: notifKind,
      cap_usd: this.capUsd,
      cumulative_usd: this.cumulative,
      warn_at_pct: this.warnAtPct,
      state: 'pending',
    }
    const body = kind === 'warn' ? this.buildWarnBody() : this.buildBlockBody()
    const content = `${FRONTMATTER_DELIM}\n${stringify(fm, { lineWidth: 0 }).trimEnd()}\n${FRONTMATTER_DELIM}\n${body}`
    const path = join(homePaths(this.home).stateNotifications, `${id}.md`)
    await mkdir(dirname(path), { recursive: true })
    await atomicWriteFile(path, content)
  }

  private buildWarnBody(): string {
    const used = this.cumulative.toFixed(2)
    const cap = this.capUsd.toFixed(2)
    const remaining = (this.capUsd - this.cumulative).toFixed(2)
    return [
      `Agent **${this.agentName}** has used ${String(this.warnAtPct)}% of today's $${cap} cap ($${used}).`,
      ``,
      `Remaining: $${remaining} before new tasks are blocked at midnight UTC.`,
      ``,
      `Adjust the cap with: \`2200 agent identity edit ${this.agentName} cost_caps.daily_usd\``,
      ``,
    ].join('\n')
  }

  private buildBlockBody(): string {
    const used = this.cumulative.toFixed(2)
    const cap = this.capUsd.toFixed(2)
    return [
      `Agent **${this.agentName}** has reached today's $${cap} cap ($${used}).`,
      ``,
      `New tasks are blocked until 00:00 UTC.`,
      ``,
      `Override with: \`2200 agent budget override ${this.agentName} [--for-today]\``,
      `Adjust permanently with: \`2200 agent identity edit ${this.agentName} cost_caps.daily_usd\``,
      ``,
    ].join('\n')
  }
}

/**
 * Helper for the CLI's `2200 agent budget override <name>` command
 * (Epic 4.5 PR E). Writes the override file atomically so the next
 * `BudgetTracker.isBlocked()` call observes it immediately. The
 * caller resolves `until` against `now()` and the user-chosen
 * duration.
 */
export async function writeBudgetOverride(
  home: string,
  agentName: string,
  override: { until: string; reason: string; setAt?: string },
): Promise<string> {
  const dir = agentBudgetDir(home, agentName)
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'override.json')
  const payload: BudgetOverride = {
    schema_version: BUDGET_OVERRIDE_SCHEMA_VERSION,
    set_at: override.setAt ?? new Date().toISOString(),
    until: override.until,
    reason: override.reason,
  }
  await atomicWriteJson(path, payload)
  return path
}

/**
 * Helper for `2200 agent budget override <name> --clear`. Removes the
 * override file if present; no-op if absent.
 */
export async function clearBudgetOverride(home: string, agentName: string): Promise<void> {
  const path = join(agentBudgetDir(home, agentName), 'override.json')
  try {
    await unlink(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

/**
 * Read the current override (sync) for inspection by CLI status
 * commands. Returns null when no override is set or when the file is
 * malformed.
 */
export function readBudgetOverrideSync(home: string, agentName: string): BudgetOverride | null {
  const path = join(agentBudgetDir(home, agentName), 'override.json')
  const raw = readFileSyncSafe(path)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as Partial<BudgetOverride>
    if (
      parsed.schema_version !== BUDGET_OVERRIDE_SCHEMA_VERSION ||
      typeof parsed.until !== 'string'
    ) {
      return null
    }
    return parsed as BudgetOverride
  } catch {
    return null
  }
}
