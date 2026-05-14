/**
 * Tiny in-memory store for live ToolStream events.
 *
 * The supervisor broadcasts `agent.tool_event` over WS each time an
 * AgentLoop opens or closes a tool call. This store collects them
 * keyed by (agent, task_id) so the chat surface can render the
 * canonical "what is the agent doing right now" chips without
 * polling.
 *
 * It's intentionally external to React Query: the events are push-
 * driven, ephemeral, and not server state. We expose a Zustand-shaped
 * `subscribe`/`getSnapshot`/`getServerSnapshot` so consumers can use
 * `useSyncExternalStore` for the standard concurrent-mode safety net.
 *
 * The store self-evicts after `END_EVICT_MS` once a task transitions
 * out of the streaming/done phase ... we don't want stale chips
 * lingering in memory for the life of the tab.
 */

export interface ToolStreamStep {
  call_id: string
  tool: string
  arg_summary: string | null
  state: 'active' | 'done' | 'errored'
  started_at: number
  ended_at?: number
  duration_ms?: number
  error_class?: string
}

export interface ToolStreamState {
  agent: string
  task_id: string
  steps: ToolStreamStep[]
  /** Set when the stream stops receiving events; the caller may evict. */
  finished_at?: number
}

type Listener = () => void

const TASK_TTL_MS = 5 * 60_000 // hard cap; covers a model latency outlier

class ToolStreamStoreImpl {
  private readonly byTask = new Map<string, ToolStreamState>()
  private readonly listeners = new Set<Listener>()
  /**
   * task_id → chat_id mapping. Set by the chat send path so any
   * subsequent tool_event WS payload that references the task can be
   * routed back to the originating chat for cross-chat pulse UX.
   * Cleared on `evict(taskId)` along with the per-task state.
   */
  private readonly chatByTask = new Map<string, string>()

  /** External-store subscribe contract for useSyncExternalStore. */
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Snapshot for a given task ... returns the SAME reference until a real change. */
  getForTask = (taskId: string): ToolStreamState | null => {
    return this.byTask.get(taskId) ?? null
  }

  /** Register that this task originated from a specific chat. */
  noteTaskChat = (taskId: string, chatId: string): void => {
    if (this.chatByTask.get(taskId) === chatId) return
    this.chatByTask.set(taskId, chatId)
    this.emit()
  }

  /**
   * Snapshot of "is this chat actively working" — true if any task tied
   * to the chat has an in-flight tool step OR has not finished yet.
   * Used by the cross-chat avatar pulse on the chat sidebar.
   */
  isChatActive = (agent: string, chatId: string): boolean => {
    for (const [taskId, mappedChat] of this.chatByTask) {
      if (mappedChat !== chatId) continue
      const state = this.byTask.get(taskId)
      if (!state) continue
      if (state.agent !== agent) continue
      if (state.finished_at !== undefined) continue
      // Active if any step is still active OR if no end-event has marked
      // the run finished. The "no steps yet" case is the early-thinking
      // window before the first tool fires; that still counts.
      return true
    }
    return false
  }

  ingestStart(params: {
    agent: string
    task_id: string
    call_id: string
    tool: string
    arg_summary: string | null
    at: number
  }): void {
    const existing = this.byTask.get(params.task_id)
    const nextStep: ToolStreamStep = {
      call_id: params.call_id,
      tool: params.tool,
      arg_summary: params.arg_summary,
      state: 'active',
      started_at: params.at,
    }
    // If a prior step is still 'active', mark it done as a defensive
    // fallback; the runtime fires `end` events but we shouldn't render
    // two spinners if something raced.
    const baseSteps =
      existing?.steps.map((s) => (s.state === 'active' ? { ...s, state: 'done' as const } : s)) ??
      []
    const next: ToolStreamState = {
      agent: params.agent,
      task_id: params.task_id,
      steps: [...baseSteps, nextStep],
    }
    this.byTask.set(params.task_id, next)
    this.evictStale()
    this.emit()
  }

  ingestEnd(params: {
    agent: string
    task_id: string
    call_id: string
    tool: string
    ok: boolean | null
    error_class: string | null
    duration_ms: number | null
    at: number
  }): void {
    const existing = this.byTask.get(params.task_id)
    if (!existing) return
    // Resolve the matching step ... prefer call_id (real), fall back
    // to "the most recent active step for this tool" since the start
    // event is emitted before the dispatcher allocates the call_id.
    let resolved = false
    const nextSteps: ToolStreamStep[] = existing.steps.map((s): ToolStreamStep => {
      if (resolved) return s
      const callIdMatches = s.call_id !== 'pending' && s.call_id === params.call_id
      const fallback = s.call_id === 'pending' && s.tool === params.tool && s.state === 'active'
      if (callIdMatches || fallback) {
        resolved = true
        const nextState: ToolStreamStep['state'] = params.ok === false ? 'errored' : 'done'
        return {
          ...s,
          call_id: params.call_id,
          state: nextState,
          ...(params.duration_ms !== null ? { duration_ms: params.duration_ms } : {}),
          ...(params.error_class !== null ? { error_class: params.error_class } : {}),
          ended_at: params.at,
        }
      }
      return s
    })
    this.byTask.set(params.task_id, {
      ...existing,
      steps: nextSteps,
    })
    this.emit()
  }

  /**
   * Mark a task as finished (the assistant reply arrived or the task
   * errored). Caller eventually evicts; we keep the snapshot for a
   * brief window so the streaming-phase transition can show the
   * faded-out chip set.
   */
  markFinished(taskId: string, at: number): void {
    const existing = this.byTask.get(taskId)
    if (!existing) return
    this.byTask.set(taskId, { ...existing, finished_at: at })
    this.emit()
  }

  /** Drop the state for a task. Called after the streaming-phase fade. */
  evict(taskId: string): void {
    let changed = false
    if (this.byTask.delete(taskId)) changed = true
    if (this.chatByTask.delete(taskId)) changed = true
    if (changed) this.emit()
  }

  private evictStale(): void {
    const now = Date.now()
    for (const [k, v] of this.byTask) {
      if (v.steps.length === 0) continue
      const oldest = v.steps[0]?.started_at ?? now
      if (now - oldest > TASK_TTL_MS) this.byTask.delete(k)
    }
  }

  private emit(): void {
    for (const l of this.listeners) l()
  }
}

export const toolStreamStore = new ToolStreamStoreImpl()
