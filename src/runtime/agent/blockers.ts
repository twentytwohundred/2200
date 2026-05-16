/**
 * TaskBlocker subsystem
 *
 * Provides a first-class way for long-running human-gated or external
 * operations (credential_request, future notification_ask, voice confirmations,
 * etc.) to pause the AgentLoop.
 *
 * Two kinds of blocker (intent-named, not behavior-named):
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
 * This is the structural mechanism chosen in the 2026-05-15 decision record
 * instead of continuing to layer more defensive guards and prompt text.
 */

export type TaskBlockerKind = 'human_gate' | 'awaiting_completion'

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
}
