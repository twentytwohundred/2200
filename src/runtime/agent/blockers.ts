/**
 * TaskBlocker subsystem
 *
 * Provides a first-class way for long-running human-gated or external
 * operations (credential_request, future notification_ask, voice confirmations,
 * etc.) to pause the AgentLoop.
 *
 * Three kinds of blocker (intent-named, not behavior-named):
 *
 *   - `human_gate`: The Agent is waiting on an external human/system event
 *     before either a new model call OR a new tool dispatch can happen.
 *     The operator hasn't pasted yet; the voice call hasn't been confirmed;
 *     the external system hasn't responded. Block the loop hard.
 *
 *   - `awaiting_completion`: The Agent has finished the work and is required
 *     to produce a final assistant reply. New model calls are allowed (we
 *     want the model to speak), but new tool dispatches are dropped and the
 *     model is re-prompted with a forcing message via the incomplete-turn
 *     budget pattern.
 *
 *   - `external_response`: The Agent has called `await_response` and is
 *     parked waiting on an inbound event from another conversational party
 *     (another Agent in a pub, a user in a connector channel). Task is
 *     persisted as `blocked_on_agent` on disk; the loop exits cleanly and
 *     the agent process goes idle for this task. Resume is driven by the
 *     supervisor's router matching an inbound event against the
 *     `wait_for` block on the task. See decision:
 *     2026-05-16-task-continuation-primitive.
 *
 * This is the structural mechanism chosen in the 2026-05-15 decision record
 * instead of continuing to layer more defensive guards and prompt text.
 */

export type TaskBlockerKind = 'human_gate' | 'awaiting_completion' | 'external_response'

export interface TaskBlocker {
  /** Unique identifier for this blocker (e.g. the credential request id). */
  id: string

  /**
   * Intent of the blocker. See module doc for semantics ... `human_gate`
   * blocks both new model calls and new tool dispatches; `awaiting_completion`
   * blocks only new tool dispatches and forces the model to speak.
   */
  kind: TaskBlockerKind

  /** Human-readable description for logs and future observability. */
  description: string

  /** Optional metadata (e.g. credential_name, request_id). */
  metadata?: Record<string, unknown>

  /** When the blocker was created. */
  createdAt: string

  /** Optional hard timeout (ISO string). The sweeper can resolve on timeout. */
  timeoutAt?: string
}

export class TaskBlockerRegistry {
  private readonly blockers = new Map<string, TaskBlocker>()

  /**
   * Register a new blocker. Returns the full blocker object (with createdAt).
   * If a blocker with the same id already exists it is replaced (last writer wins).
   */
  register(blocker: Omit<TaskBlocker, 'createdAt'>): TaskBlocker {
    const full: TaskBlocker = {
      ...blocker,
      createdAt: new Date().toISOString(),
    }
    this.blockers.set(full.id, full)
    return full
  }

  /** Returns all currently active blockers. Optionally filtered by kind. */
  getActive(kind?: TaskBlockerKind): TaskBlocker[] {
    const all = Array.from(this.blockers.values())
    return kind ? all.filter((b) => b.kind === kind) : all
  }

  /**
   * True if the task currently has one or more active blockers, optionally
   * filtered by kind. `hasActive('human_gate')` is the load-bearing
   * pre-model-call check; `hasActive('awaiting_completion')` is the
   * pre-dispatch check.
   */
  hasActive(kind?: TaskBlockerKind): boolean {
    if (kind === undefined) return this.blockers.size > 0
    for (const b of this.blockers.values()) {
      if (b.kind === kind) return true
    }
    return false
  }

  /**
   * Resolve (remove) a blocker by id.
   * Returns true if a blocker was actually removed.
   */
  resolve(id: string): boolean {
    return this.blockers.delete(id)
  }

  /** Clear all blockers (called when a task ends or the loop resets). */
  clear(): void {
    this.blockers.clear()
  }

  /**
   * Drop every blocker of the given kind. Used at the start of a task
   * run to clear `external_response` blockers from a prior task ...
   * those blockers parked the prior task on `wait_for`; the supervisor
   * cleared the on-disk wait when it resumed the task, but the
   * in-memory blocker survived because the registry is process-scoped.
   * Without this, the first iteration of the resumed task hits the
   * pre-iteration blocker check and exits as still-parked.
   */
  clearByKind(kind: TaskBlockerKind): number {
    let removed = 0
    for (const [id, b] of this.blockers.entries()) {
      if (b.kind === kind) {
        this.blockers.delete(id)
        removed += 1
      }
    }
    return removed
  }
}
