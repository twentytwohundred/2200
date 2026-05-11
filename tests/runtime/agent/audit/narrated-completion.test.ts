/**
 * Audit: narrated_completion_without_tool_call.
 *
 * Verifies the heuristic at the function boundary. Wiring into the loop
 * and notification emit is covered by the agent end-to-end suite.
 */
import { describe, expect, it } from 'vitest'
import { auditNarratedCompletion } from '../../../../src/runtime/agent/audit/narrated-completion.js'
import type { LoopEvent } from '../../../../src/runtime/agent/detectors/types.js'

function toolCall(ok: boolean, name = 'spotify_api'): LoopEvent {
  return {
    kind: 'tool_call_end',
    at: Date.now(),
    call_id: 'c1',
    tool: name,
    args_hash: 'h',
    iteration: 1,
    ok,
    duration_ms: 10,
  }
}

function modelCall(): LoopEvent {
  return {
    kind: 'model_call_end',
    at: Date.now(),
    model: 'xai/grok-4-fast',
    iteration: 1,
    cost_usd: 0.001,
    finish_reason: 'stop',
  }
}

describe('auditNarratedCompletion', () => {
  it('returns null for a pure task even with zero tool calls', () => {
    const result = auditNarratedCompletion({
      events: [modelCall()],
      idempotency: 'pure',
    })
    expect(result).toBeNull()
  })

  it('returns null for a checkpointed task even with zero tool calls', () => {
    const result = auditNarratedCompletion({
      events: [modelCall()],
      idempotency: 'checkpointed',
    })
    expect(result).toBeNull()
  })

  it('returns null for a destructive task that had at least one ok tool call', () => {
    const result = auditNarratedCompletion({
      events: [modelCall(), toolCall(true), modelCall()],
      idempotency: 'destructive',
    })
    expect(result).toBeNull()
  })

  it('flags a destructive task with zero tool calls', () => {
    const result = auditNarratedCompletion({
      events: [modelCall(), modelCall()],
      idempotency: 'destructive',
    })
    expect(result).not.toBeNull()
    expect(result?.kind).toBe('narrated_completion_without_tool_call')
    expect(result?.attempted).toBe(0)
    expect(result?.succeeded).toBe(0)
    expect(result?.detail).toMatch(/without any tool calls/)
  })

  it('flags a destructive task where every tool call failed', () => {
    const result = auditNarratedCompletion({
      events: [
        modelCall(),
        toolCall(false, 'spotify_api'),
        toolCall(false, 'spotify_api'),
        toolCall(false, 'spotify_api'),
        modelCall(),
      ],
      idempotency: 'destructive',
    })
    expect(result).not.toBeNull()
    expect(result?.kind).toBe('narrated_completion_without_tool_call')
    expect(result?.attempted).toBe(3)
    expect(result?.succeeded).toBe(0)
    expect(result?.detail).toMatch(/3 attempted/)
  })

  it('does not flag when even one of many attempts succeeded', () => {
    const result = auditNarratedCompletion({
      events: [
        modelCall(),
        toolCall(false),
        toolCall(false),
        toolCall(true),
        toolCall(false),
        modelCall(),
      ],
      idempotency: 'destructive',
    })
    expect(result).toBeNull()
  })
})
