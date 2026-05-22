/**
 * Standing-brief reconciler (PR 3 / Phase 1 synthesis layer).
 *
 * Supervisor-side loop that detects research threads with pending
 * synthesis work and hands them off to the thread's primary Agent
 * as tasks. The Agent's own loop runs the actual LLM synthesis via
 * the `brain_write_research_brief` baseline tool; this reconciler
 * just orchestrates the lifecycle.
 *
 * Per Grok's 2026-05-23 design lock:
 *  - Supervisor owns the reconciler (not Agent self-poll). If the
 *    primary Agent is stopped, the operator sees a tier-normal Inbox
 *    event; briefs go stale but the lifecycle state is honest.
 *  - Synthesis is an Agent task (not a supervisor-side LLM call).
 *    Cost lives on the Agent's budget where it belongs.
 *  - Debounce window of 60s default. New contributions arriving in a
 *    burst coalesce into one synthesis when the dust settles.
 *  - Per-synthesis budget cap (default $0.10) baked into the task
 *    title so the Agent loop sees the cap and can self-throttle.
 *  - Global synthesis budget guard (stretch) caps total connector
 *    synthesis spend across the fleet over a rolling window.
 *
 * Failure semantics:
 *  - On task `errored` / `budget_exceeded` / unknown failure: the
 *    reconciler observes via the supervisor's task event stream,
 *    increments `synthesis_failure_count` on the anchor, emits a
 *    `connector.synthesis_failed` event. After 3 consecutive
 *    failures it sets `synthesis_blocked: true` (tier-important
 *    event); the operator clears via
 *    `2200 connector synthesis unblock <thread>`.
 *  - On task `done`: the `brain_write_research_brief` tool already
 *    reset the failure counter and advanced `synthesized_through`;
 *    the reconciler just emits the completion event.
 */
import type { Logger } from '../../util/logger.js'
import { createLogger } from '../../util/logger.js'
import type { ConnectorAuditEmitter } from './audit.js'
import {
  listSynthesisStates,
  updateAnchorFrontmatter,
  type ThreadSynthesisState,
} from './synthesis.js'

export const DEFAULT_DEBOUNCE_WINDOW_MS = 60_000
export const DEFAULT_POLL_INTERVAL_MS = 30_000
export const DEFAULT_PER_SYNTHESIS_BUDGET_USD = 0.1
export const FAILURE_BLOCK_THRESHOLD = 3

export interface SynthesisReconcilerDeps {
  home: string
  audit: ConnectorAuditEmitter
  /**
   * Whether the named Agent is currently `running`. The reconciler
   * skips threads whose primary is not running and emits a
   * `synthesis_primary_missing` event the first time it encounters
   * the gap.
   */
  isAgentRunning: (agentName: string) => boolean
  /**
   * Submit a synthesis task to the primary Agent. Returns the task
   * id on success. The reconciler treats a rejection here as a
   * recoverable failure (try again next tick).
   */
  submitSynthesisTask: (args: {
    agent: string
    threadSlug: string
    pendingSynthesisAt: string
    budgetUsd: number
  }) => Promise<{ taskId: string }>
  /** Injectable clock (tests). */
  now?: () => Date
  /** Override poll cadence (tests; smaller numbers run faster). */
  pollIntervalMs?: number
  /** Override debounce. */
  debounceWindowMs?: number
  /** Override per-synthesis budget cap. */
  perSynthesisBudgetUsd?: number
  /**
   * Optional global synthesis budget cap over a rolling window. When
   * set, the reconciler tracks total submissions over the window and
   * skips new submissions once the cap would be exceeded (the next
   * tick re-evaluates). Stretch goal per the locked design; safe to
   * leave undefined.
   */
  globalBudgetUsd?: number
  /** Rolling window for the global budget. Default 1 hour. */
  globalBudgetWindowMs?: number
  /** Logger override. */
  logger?: Logger
}

interface TrackedSubmission {
  threadSlug: string
  taskId: string
  submittedAtMs: number
  budgetUsd: number
}

/**
 * Single-instance per supervisor. Owns its own setInterval.
 *
 * This class only KICKS OFF synthesis work; observing task outcomes
 * (`done` / `errored`) is wired separately via the supervisor's task
 * event path. See `observeTaskOutcome` for the call the supervisor
 * makes when a tracked task transitions.
 */
export class SynthesisReconciler {
  private readonly deps: Required<
    Omit<SynthesisReconcilerDeps, 'globalBudgetUsd' | 'globalBudgetWindowMs' | 'logger'>
  > & {
    globalBudgetUsd: number | undefined
    globalBudgetWindowMs: number
    logger: Logger
  }
  private timer: ReturnType<typeof setInterval> | undefined
  /** Threads with synthesis-primary-missing already announced; cleared when re-resolved. */
  private readonly primaryMissingNotified = new Set<string>()
  /** Submissions whose outcome we are still waiting on. */
  private readonly inflight = new Map<string, TrackedSubmission>()
  /** Sliding-window submission log for the global budget. */
  private readonly globalBudgetLog: { atMs: number; usd: number }[] = []

  constructor(deps: SynthesisReconcilerDeps) {
    this.deps = {
      home: deps.home,
      audit: deps.audit,
      isAgentRunning: deps.isAgentRunning,
      submitSynthesisTask: deps.submitSynthesisTask,
      now: deps.now ?? ((): Date => new Date()),
      pollIntervalMs: deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      debounceWindowMs: deps.debounceWindowMs ?? DEFAULT_DEBOUNCE_WINDOW_MS,
      perSynthesisBudgetUsd: deps.perSynthesisBudgetUsd ?? DEFAULT_PER_SYNTHESIS_BUDGET_USD,
      globalBudgetUsd: deps.globalBudgetUsd,
      globalBudgetWindowMs: deps.globalBudgetWindowMs ?? 60 * 60 * 1000,
      logger: deps.logger ?? createLogger('connector/synthesis-reconciler'),
    }
  }

  start(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => {
      void this.runOnce().catch((err: unknown) => {
        this.deps.logger.warn('synthesis reconciler tick failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }, this.deps.pollIntervalMs)
    // Don't keep the process alive purely for the reconciler.
    this.timer.unref()
    this.deps.logger.info('synthesis reconciler started', {
      poll_interval_ms: this.deps.pollIntervalMs,
      debounce_window_ms: this.deps.debounceWindowMs,
      per_synthesis_budget_usd: this.deps.perSynthesisBudgetUsd,
      global_budget_usd: this.deps.globalBudgetUsd ?? null,
    })
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /**
   * Public for testing — one reconciler pass. Production code goes
   * through `start()`'s interval.
   */
  async runOnce(): Promise<void> {
    const now = this.deps.now().getTime()
    this.trimGlobalBudgetLog(now)
    const states = await listSynthesisStates(this.deps.home)
    for (const state of states) {
      try {
        await this.evaluate(state, now)
      } catch (err) {
        this.deps.logger.warn('synthesis reconciler evaluate failed', {
          thread: state.threadSlug,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  /**
   * Called by the supervisor when a tracked synthesis task transitions
   * to a terminal state. Emits the appropriate audit event and
   * patches the thread anchor's failure counter / blocked flag.
   *
   * The `brain_write_research_brief` tool already advances
   * `synthesized_through` and resets the failure counter on the
   * successful path — so on `done` this method only emits the
   * completion event. On failure, this method is where the counter
   * and `synthesis_blocked` flag are written.
   */
  async observeTaskOutcome(args: {
    taskId: string
    status: 'done' | 'errored'
    errorSummary?: string
    /** Optional duration if the supervisor measured it. */
    durationMs?: number
    /** Optional contribution count from the tool result. */
    contributionCount?: number
  }): Promise<void> {
    const submission = this.inflight.get(args.taskId)
    if (submission === undefined) return // not ours
    this.inflight.delete(args.taskId)
    if (args.status === 'done') {
      const states = await listSynthesisStates(this.deps.home)
      const state = states.find((s) => s.threadSlug === submission.threadSlug)
      await this.deps.audit
        .emitSynthesisCompleted({
          threadSlug: submission.threadSlug,
          primaryAgent: state?.primaryAgent ?? '<unknown>',
          contributionCount: args.contributionCount ?? 0,
          briefSlug: `research-${submission.threadSlug}-brief`,
          ...(args.durationMs !== undefined ? { durationMs: args.durationMs } : {}),
        })
        .catch(() => undefined)
      return
    }
    // Failure path.
    const states = await listSynthesisStates(this.deps.home)
    const state = states.find((s) => s.threadSlug === submission.threadSlug)
    const nextFailureCount = (state?.failureCount ?? 0) + 1
    const blocked = nextFailureCount >= FAILURE_BLOCK_THRESHOLD
    const errorClass = classifyError(args.errorSummary)
    await updateAnchorFrontmatter({
      home: this.deps.home,
      threadSlug: submission.threadSlug,
      updates: {
        synthesis_failure_count: nextFailureCount,
        synthesis_blocked: blocked,
      },
    })
    await this.deps.audit
      .emitSynthesisFailed({
        threadSlug: submission.threadSlug,
        primaryAgent: state?.primaryAgent ?? '<unknown>',
        errorClass,
        errorSummary: args.errorSummary ?? '(no detail)',
        failureCount: nextFailureCount,
        blocked,
      })
      .catch(() => undefined)
  }

  private async evaluate(state: ThreadSynthesisState, nowMs: number): Promise<void> {
    if (state.blocked) return
    if (state.pendingSynthesisAt === null) return
    if (state.synthesizedThrough !== null && state.synthesizedThrough >= state.pendingSynthesisAt) {
      return
    }
    const pendingMs = Date.parse(state.pendingSynthesisAt)
    if (Number.isNaN(pendingMs)) return
    if (nowMs - pendingMs < this.deps.debounceWindowMs) return
    // Primary Agent check.
    if (state.primaryAgent === null || !this.deps.isAgentRunning(state.primaryAgent)) {
      if (!this.primaryMissingNotified.has(state.threadSlug)) {
        this.primaryMissingNotified.add(state.threadSlug)
        await this.deps.audit
          .emitSynthesisPrimaryMissing({
            threadSlug: state.threadSlug,
            expectedAgent: state.primaryAgent,
          })
          .catch(() => undefined)
      }
      return
    }
    this.primaryMissingNotified.delete(state.threadSlug)

    // Skip if we already have a synthesis task in flight for this
    // thread (avoid double-submit while we wait for the outcome).
    for (const submission of this.inflight.values()) {
      if (submission.threadSlug === state.threadSlug) return
    }

    // Global budget guard.
    if (this.deps.globalBudgetUsd !== undefined) {
      const spent = this.globalBudgetLog.reduce((sum, entry) => sum + entry.usd, 0)
      if (spent + this.deps.perSynthesisBudgetUsd > this.deps.globalBudgetUsd) {
        this.deps.logger.info('synthesis skipped: global budget cap', {
          thread: state.threadSlug,
          spent_window_usd: spent,
          cap_usd: this.deps.globalBudgetUsd,
        })
        return
      }
    }

    let task: { taskId: string }
    try {
      task = await this.deps.submitSynthesisTask({
        agent: state.primaryAgent,
        threadSlug: state.threadSlug,
        pendingSynthesisAt: state.pendingSynthesisAt,
        budgetUsd: this.deps.perSynthesisBudgetUsd,
      })
    } catch (err) {
      this.deps.logger.warn('synthesis task submission failed', {
        thread: state.threadSlug,
        agent: state.primaryAgent,
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }
    this.inflight.set(task.taskId, {
      threadSlug: state.threadSlug,
      taskId: task.taskId,
      submittedAtMs: nowMs,
      budgetUsd: this.deps.perSynthesisBudgetUsd,
    })
    this.globalBudgetLog.push({ atMs: nowMs, usd: this.deps.perSynthesisBudgetUsd })
    await this.deps.audit
      .emitSynthesisStarted({
        threadSlug: state.threadSlug,
        primaryAgent: state.primaryAgent,
      })
      .catch(() => undefined)
  }

  private trimGlobalBudgetLog(nowMs: number): void {
    const cutoff = nowMs - this.deps.globalBudgetWindowMs
    while (this.globalBudgetLog.length > 0) {
      const head = this.globalBudgetLog[0]
      if (head === undefined || head.atMs >= cutoff) break
      this.globalBudgetLog.shift()
    }
  }
}

function classifyError(
  summary?: string,
): 'task_errored' | 'budget_exceeded' | 'tool_failure' | 'unknown' {
  if (summary === undefined) return 'unknown'
  const lower = summary.toLowerCase()
  if (lower.includes('budget')) return 'budget_exceeded'
  if (lower.includes('tool')) return 'tool_failure'
  if (lower.includes('errored')) return 'task_errored'
  return 'unknown'
}
