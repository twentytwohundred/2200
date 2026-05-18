/**
 * Tests for the agent_control.* baseline tools.
 *
 * Covers the calling-agent-locked dispatch surface: the tool reads
 * ctx.callingAgent for the RPC's `name` parameter (no caller-
 * supplied target) so no Agent can use this surface to restart
 * another Agent.
 */
import { describe, expect, it, vi } from 'vitest'
import { makeRestartSelf } from '../../../../src/runtime/tools/baseline/agent-control.js'
import type { ToolContext } from '../../../../src/runtime/mcp/tool.js'
import type { JsonRpcClient } from '../../../../src/runtime/control-plane/client.js'

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    callingAgent: 'hobby',
    home: '/tmp/test',
    brainDir: '/tmp/test/agents/hobby/brain',
    projectDir: '/tmp/test/agents/hobby/project',
    taskId: 'task_test',
    callId: 'call_test',
    ...overrides,
  }
}

describe('restart_self tool: dispatch surface', () => {
  it('calls cli.agent.restart_self with name locked to ctx.callingAgent', async () => {
    const mockCall = vi.fn().mockResolvedValue({ ok: true, scheduled_at: '2026-05-18T00:00:00Z' })
    const client = { call: mockCall } as unknown as JsonRpcClient
    const tool = makeRestartSelf(() => client)
    const result = await tool.execute(
      { reason: 'wedged loop' },
      makeContext({ callingAgent: 'simon' }),
    )
    expect(mockCall).toHaveBeenCalledWith('cli.agent.restart_self', {
      name: 'simon',
      reason: 'wedged loop',
    })
    expect(result).toEqual({ ok: true, scheduled_at: '2026-05-18T00:00:00Z' })
  })

  it('throws when supervisor RPC is not yet connected', async () => {
    const tool = makeRestartSelf(() => undefined)
    await expect(tool.execute({ reason: 'x' }, makeContext())).rejects.toThrow(/supervisor RPC/)
  })
})

describe('restart_self tool: args schema (no cross-Agent attack surface)', () => {
  it('strips any caller-supplied `name` field from args (no target arg exists)', () => {
    const tool = makeRestartSelf(() => undefined)
    // Even if a malicious model emits {name: 'jodin', reason: 'attack'} the
    // dispatcher's Zod parse strips unknown fields. The tool then passes
    // ctx.callingAgent as the dispatch target, not whatever the args said.
    const parsed = tool.argsSchema.parse({ name: 'jodin', reason: 'attack' }) as {
      name?: string
      reason: string
    }
    expect(parsed.reason).toBe('attack')
    expect(parsed.name).toBeUndefined()
  })

  it('requires a non-empty reason', () => {
    const tool = makeRestartSelf(() => undefined)
    expect(() => tool.argsSchema.parse({ reason: '' })).toThrow()
  })

  it('caps the reason at 500 characters', () => {
    const tool = makeRestartSelf(() => undefined)
    const longReason = 'x'.repeat(501)
    expect(() => tool.argsSchema.parse({ reason: longReason })).toThrow()
  })

  it('accepts a short reason cleanly', () => {
    const tool = makeRestartSelf(() => undefined)
    expect(tool.argsSchema.parse({ reason: 'wedged' })).toEqual({ reason: 'wedged' })
  })
})

describe('restart_self tool: registration metadata', () => {
  it('declares destructive idempotency (process lifecycle)', () => {
    const tool = makeRestartSelf(() => undefined)
    expect(tool.idempotency).toBe('destructive')
  })

  it('declares the canonical name', () => {
    const tool = makeRestartSelf(() => undefined)
    expect(tool.name).toBe('restart_self')
  })
})
