/**
 * Unit tests for TaskBlockerRegistry.
 *
 * The registry's load-bearing property is that `hasActive('human_gate')`
 * and `hasActive('awaiting_completion')` are distinct ... the AgentLoop's
 * top-of-iteration check uses the former to gate new model calls while
 * letting `awaiting_completion` blockers pass through (the model still
 * needs to be called so it can produce the final reply). Conflating the
 * two is the exact bug that caused the post-credential_has stall.
 */
import { describe, expect, it } from 'vitest'
import { TaskBlockerRegistry } from '../../../src/runtime/agent/blockers.js'

describe('TaskBlockerRegistry', () => {
  it('register + getActive round-trip', () => {
    const r = new TaskBlockerRegistry()
    r.register({
      id: 'b1',
      kind: 'human_gate',
      description: 'waiting for paste',
    })
    const active = r.getActive()
    expect(active).toHaveLength(1)
    expect(active[0]?.id).toBe('b1')
    expect(active[0]?.kind).toBe('human_gate')
    expect(active[0]?.createdAt).toBeTypeOf('string')
  })

  it('hasActive(kind) filters by kind so the loop can gate on intent', () => {
    const r = new TaskBlockerRegistry()
    r.register({ id: 'h1', kind: 'human_gate', description: 'paste' })
    r.register({ id: 'a1', kind: 'awaiting_completion', description: 'speak' })

    expect(r.hasActive()).toBe(true)
    expect(r.hasActive('human_gate')).toBe(true)
    expect(r.hasActive('awaiting_completion')).toBe(true)

    r.resolve('h1')

    // The load-bearing case: only `awaiting_completion` is left. The
    // loop's top-of-iteration check (hasActive('human_gate')) must
    // return false so the next model call can happen and the model
    // can produce the final reply.
    expect(r.hasActive('human_gate')).toBe(false)
    expect(r.hasActive('awaiting_completion')).toBe(true)
    expect(r.hasActive()).toBe(true)
  })

  it('getActive(kind) returns only matching blockers', () => {
    const r = new TaskBlockerRegistry()
    r.register({ id: 'h1', kind: 'human_gate', description: 'paste' })
    r.register({ id: 'a1', kind: 'awaiting_completion', description: 'speak' })

    const humanOnly = r.getActive('human_gate')
    expect(humanOnly).toHaveLength(1)
    expect(humanOnly[0]?.id).toBe('h1')

    const awaitingOnly = r.getActive('awaiting_completion')
    expect(awaitingOnly).toHaveLength(1)
    expect(awaitingOnly[0]?.id).toBe('a1')
  })

  it('register with existing id replaces (last-writer-wins) so kind transitions work', () => {
    // The credential lifecycle re-registers a blocker to flip it from
    // `human_gate` (waiting on operator) to `awaiting_completion`
    // (waiting on agent to speak). Same id; the registry must take
    // the new kind rather than keep the old one.
    const r = new TaskBlockerRegistry()
    r.register({ id: 'b1', kind: 'human_gate', description: 'before' })
    r.register({ id: 'b1', kind: 'awaiting_completion', description: 'after' })

    expect(r.getActive()).toHaveLength(1)
    expect(r.hasActive('human_gate')).toBe(false)
    expect(r.hasActive('awaiting_completion')).toBe(true)
  })

  it('resolve returns true on hit, false on miss', () => {
    const r = new TaskBlockerRegistry()
    r.register({ id: 'b1', kind: 'human_gate', description: 'x' })
    expect(r.resolve('b1')).toBe(true)
    expect(r.resolve('b1')).toBe(false)
    expect(r.hasActive()).toBe(false)
  })

  it('clear removes everything', () => {
    const r = new TaskBlockerRegistry()
    r.register({ id: 'b1', kind: 'human_gate', description: 'a' })
    r.register({ id: 'b2', kind: 'awaiting_completion', description: 'b' })
    r.clear()
    expect(r.hasActive()).toBe(false)
    expect(r.getActive()).toEqual([])
  })
})
