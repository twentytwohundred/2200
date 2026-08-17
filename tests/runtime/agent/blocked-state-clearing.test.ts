/**
 * Tests for clearing a blocked_* state when the Agent resumes work.
 *
 * The field failure these come from: the operator asked Skippy to ask
 * Jodin a question. Skippy parked on `task_await_response`, Jodin
 * replied, the task resumed and **completed successfully** ... and
 * Skippy went on reporting `blocked_on_agent` indefinitely. Healthy,
 * idle, answering nothing, showing as dark in the fleet view. Only an
 * explicit stop+start cleared it.
 *
 * Two independent defects produced that:
 *
 *   1. The resume path cleared `blocked_on_detector` and nothing else,
 *      so `blocked_on_agent` survived a full task lifecycle.
 *   2. `blocked_on_agent->stopped` was not a legal transition, so even
 *      a clean shutdown could not correct the record (the throw is
 *      swallowed, making it silent rather than loud).
 *
 * The invariant worth defending is broader than either bug: **a state
 * an Agent can enter must be one it can leave**, both forward into
 * work and sideways into shutdown. A future state added without both
 * edges reintroduces this class, so the last test here enumerates
 * rather than spot-checks.
 */
import { describe, expect, it } from 'vitest'
import { AgentStateMachine } from '../../../src/runtime/agent/state-machine.js'
import type { AgentState } from '../../../src/runtime/control-plane/protocol.js'

/** Every state that represents "parked, waiting on something external". */
const BLOCKED_STATES: AgentState[] = ['blocked_on_user', 'blocked_on_agent', 'blocked_on_detector']

/** Drive a fresh machine into `target` via legal moves. */
function machineIn(target: AgentState): AgentStateMachine {
  const m = new AgentStateMachine('stopped')
  m.transition('running', 'boot')
  if (target === 'running') return m
  m.transition(target, 'test setup')
  return m
}

describe('leaving a blocked state', () => {
  it.each(BLOCKED_STATES)('%s can return to running when the block resolves', (state) => {
    const m = machineIn(state)
    expect(() => {
      m.transition('running', 'task picked up; block resolved')
    }).not.toThrow()
    expect(m.state).toBe('running')
  })

  it.each(BLOCKED_STATES)('%s can be stopped by the operator', (state) => {
    // The Agent an operator most wants to stop is the one that looks
    // stuck. Shutdown must not depend on what it was doing.
    const m = machineIn(state)
    expect(() => {
      m.transition('stopped', 'user_requested')
    }).not.toThrow()
    expect(m.state).toBe('stopped')
  })

  it('waiting can also be stopped', () => {
    const m = machineIn('waiting')
    expect(() => {
      m.transition('stopped', 'user_requested')
    }).not.toThrow()
  })

  it('every non-terminal state can reach stopped', () => {
    // Enumerated rather than spot-checked: a new state added with a
    // way in and no way out is the exact shape of the bug this fixes.
    const reachable: AgentState[] = [
      'running',
      'waiting',
      'blocked_on_user',
      'blocked_on_agent',
      'blocked_on_detector',
    ]
    for (const state of reachable) {
      const m = machineIn(state)
      expect(() => {
        m.transition('stopped', 'shutdown')
      }, `${state} must be stoppable`).not.toThrow()
    }
  })

  it('still rejects a genuinely nonsensical move', () => {
    // The relaxation above must not turn the machine into a free-for-all.
    const m = machineIn('blocked_on_agent')
    expect(() => {
      m.transition('blocked_on_detector', 'nonsense')
    }).toThrow(/invalid Agent state transition/)
  })

  it('records the resolving transition in history for debugging', () => {
    const m = machineIn('blocked_on_agent')
    m.transition('running', 'task picked up; block resolved')
    const last = m.getHistory().at(-1)
    expect(last).toMatchObject({ from: 'blocked_on_agent', to: 'running' })
  })
})
