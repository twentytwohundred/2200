/**
 * Agent loop state machine.
 *
 * Mirrors the locked diagram in the Epic 2 spec
 * (wiki/epics/02-agent-runtime-minimum.md). At v1 we implement the minimum
 * set of transitions: spawn -> running, then external stop -> stopped, with
 * `errored` as a terminal-by-uncaught-exception transition. Other transitions
 * (waiting, blocked_*, detector trips) land as their corresponding subsystems
 * (scheduler, notifications, detectors) ship in subsequent PRs.
 *
 * The state machine is a pure data structure. The Agent process drives it;
 * the supervisor observes via heartbeats.
 */
import type { AgentState } from '../control-plane/protocol.js'

export interface StateTransition {
  from: AgentState
  to: AgentState
  reason: string
}

const TRANSITIONS: ReadonlySet<string> = new Set([
  'stopped->running',
  'running->stopped',
  'running->errored',
  'running->waiting',
  'running->blocked_on_user',
  'running->blocked_on_agent',
  'running->blocked_on_detector',
  'waiting->running',
  'blocked_on_user->running',
  'blocked_on_agent->running',
  'blocked_on_detector->running',
  'blocked_on_detector->stopped',
  'errored->running',
  'errored->stopped',
])

export class AgentStateMachine {
  private current: AgentState
  private readonly history: StateTransition[] = []

  constructor(initial: AgentState = 'stopped') {
    this.current = initial
  }

  get state(): AgentState {
    return this.current
  }

  /** Attempt a transition. Throws on invalid moves; the loop should never produce them. */
  transition(to: AgentState, reason: string): void {
    const key = `${this.current}->${to}`
    if (!TRANSITIONS.has(key)) {
      throw new Error(`invalid Agent state transition: ${key}`)
    }
    this.history.push({ from: this.current, to, reason })
    this.current = to
  }

  /** All transitions in order, oldest first. Useful for debugging. */
  getHistory(): readonly StateTransition[] {
    return this.history
  }
}
