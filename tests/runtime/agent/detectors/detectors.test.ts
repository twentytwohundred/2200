/**
 * Tests for the five detectors and the evaluator's first-wins ordering.
 *
 * Each detector test builds a synthetic LoopEvent stream and asserts the
 * verdict shape. The evaluator test asserts that when multiple detectors would
 * fire on the same stream, the first in [[ACTIVE_DETECTORS]] wins.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_THRESHOLDS,
  type AgentStateSnapshot,
  type DetectorContext,
  type LoopEvent,
} from '../../../../src/runtime/agent/detectors/types.js'
import { toolRepetition } from '../../../../src/runtime/agent/detectors/tool-repetition.js'
import { noProgress } from '../../../../src/runtime/agent/detectors/no-progress.js'
import { toolTimeout } from '../../../../src/runtime/agent/detectors/tool-timeout.js'
import { costBurst } from '../../../../src/runtime/agent/detectors/cost-burst.js'
import { errorStorm } from '../../../../src/runtime/agent/detectors/error-storm.js'
import {
  ACTIVE_DETECTORS,
  evaluateDetectors,
} from '../../../../src/runtime/agent/detectors/evaluator.js'

const NOW = 1_700_000_000_000

const baseAgent: AgentStateSnapshot = {
  agent_name: 'hobby',
  current_task_id: 'task_abc',
  task_idempotency: 'pure',
  iteration: 1,
  recent_state: 'running',
}

function ctx(events: LoopEvent[], now: number = NOW): DetectorContext {
  return {
    events,
    agent: baseAgent,
    thresholds: DEFAULT_THRESHOLDS,
    now: () => now,
  }
}

function toolEnd(args: {
  call_id: string
  tool: string
  args_hash?: string
  iteration?: number
  ok?: boolean
  duration_ms?: number
  error_class?: string
  at?: number
}): LoopEvent {
  return {
    kind: 'tool_call_end',
    at: args.at ?? NOW,
    call_id: args.call_id,
    tool: args.tool,
    args_hash: args.args_hash ?? 'h',
    iteration: args.iteration ?? 1,
    ok: args.ok ?? true,
    duration_ms: args.duration_ms ?? 10,
    ...(args.error_class !== undefined ? { error_class: args.error_class } : {}),
  }
}

describe('tool_repetition', () => {
  it('fires when N consecutive ends share the same (tool, args_hash)', () => {
    const events: LoopEvent[] = []
    for (let i = 0; i < 5; i++) {
      events.push(toolEnd({ call_id: `c${String(i)}`, tool: 'fs.read', args_hash: 'same' }))
    }
    const v = toolRepetition.evaluate(ctx(events))
    expect(v?.kind).toBe('tool_repetition')
    expect(v?.triggers.length).toBe(5)
  })

  it('does not fire on fewer than N', () => {
    const events: LoopEvent[] = []
    for (let i = 0; i < 4; i++) {
      events.push(toolEnd({ call_id: `c${String(i)}`, tool: 'fs.read', args_hash: 'same' }))
    }
    expect(toolRepetition.evaluate(ctx(events))).toBeNull()
  })

  it('does not fire when args_hash differs', () => {
    const events: LoopEvent[] = []
    for (let i = 0; i < 5; i++) {
      events.push(
        toolEnd({ call_id: `c${String(i)}`, tool: 'fs.read', args_hash: `h${String(i)}` }),
      )
    }
    expect(toolRepetition.evaluate(ctx(events))).toBeNull()
  })

  it('does not fire when tool differs', () => {
    const tools = ['fs.read', 'fs.write', 'fs.read', 'fs.read', 'fs.read']
    const events = tools.map((t, i) => toolEnd({ call_id: `c${String(i)}`, tool: t }))
    expect(toolRepetition.evaluate(ctx(events))).toBeNull()
  })

  it('considers only the last N (sliding window)', () => {
    const events: LoopEvent[] = []
    events.push(toolEnd({ call_id: 'a', tool: 'fs.read', args_hash: 'other' }))
    for (let i = 0; i < 5; i++) {
      events.push(toolEnd({ call_id: `c${String(i)}`, tool: 'fs.read', args_hash: 'same' }))
    }
    const v = toolRepetition.evaluate(ctx(events))
    expect(v?.kind).toBe('tool_repetition')
  })
})

describe('no_progress', () => {
  it('fires when iterations since last brain_write exceed threshold', () => {
    const events: LoopEvent[] = [
      { kind: 'brain_write', at: NOW, path: '/brain/note.md', iteration: 0 },
    ]
    for (let i = 1; i <= 60; i++) {
      events.push(toolEnd({ call_id: `c${String(i)}`, tool: 'fs.read', iteration: i }))
    }
    const v = noProgress.evaluate(ctx(events))
    expect(v?.kind).toBe('no_progress')
  })

  it('resets on a state_transition that is not a self-loop', () => {
    const events: LoopEvent[] = []
    for (let i = 0; i < 30; i++) {
      events.push(toolEnd({ call_id: `c${String(i)}`, tool: 'fs.read', iteration: i }))
    }
    events.push({
      kind: 'state_transition',
      at: NOW,
      from: 'running',
      to: 'waiting',
      iteration: 30,
    })
    for (let i = 31; i < 60; i++) {
      events.push(toolEnd({ call_id: `c${String(i)}`, tool: 'fs.read', iteration: i }))
    }
    expect(noProgress.evaluate(ctx(events))).toBeNull()
  })

  it('does not fire when iteration count below threshold', () => {
    const events: LoopEvent[] = [toolEnd({ call_id: 'c', tool: 'fs.read', iteration: 5 })]
    expect(noProgress.evaluate(ctx(events))).toBeNull()
  })

  it('returns null on empty event stream', () => {
    expect(noProgress.evaluate(ctx([]))).toBeNull()
  })
})

describe('tool_timeout', () => {
  it('fires when most recent tool_call_end exceeds threshold', () => {
    const events: LoopEvent[] = [toolEnd({ call_id: 'c', tool: 'shell.run', duration_ms: 130_000 })]
    const v = toolTimeout.evaluate(ctx(events))
    expect(v?.kind).toBe('tool_timeout')
    expect(v?.triggers).toEqual(['c'])
  })

  it('does not fire when most recent end is under threshold', () => {
    const events: LoopEvent[] = [toolEnd({ call_id: 'c', tool: 'shell.run', duration_ms: 1000 })]
    expect(toolTimeout.evaluate(ctx(events))).toBeNull()
  })

  it('only checks the most recent tool_call_end', () => {
    const events: LoopEvent[] = [
      toolEnd({ call_id: 'old', tool: 'shell.run', duration_ms: 200_000, at: NOW - 1000 }),
      toolEnd({ call_id: 'fresh', tool: 'fs.read', duration_ms: 5, at: NOW }),
    ]
    expect(toolTimeout.evaluate(ctx(events))).toBeNull()
  })
})

describe('cost_burst', () => {
  it('fires when cumulative cost in window exceeds threshold', () => {
    const events: LoopEvent[] = []
    for (let i = 0; i < 10; i++) {
      events.push({
        kind: 'model_call_end',
        at: NOW - i * 10_000,
        model: 'anthropic/claude-opus-4-7',
        iteration: i,
        cost_usd: 0.6,
        finish_reason: 'stop',
      })
    }
    const v = costBurst.evaluate(ctx(events))
    expect(v?.kind).toBe('cost_burst')
  })

  it('does not fire when total under threshold', () => {
    const events: LoopEvent[] = [
      {
        kind: 'model_call_end',
        at: NOW,
        model: 'anthropic/claude-opus-4-7',
        iteration: 0,
        cost_usd: 0.5,
        finish_reason: 'stop',
      },
    ]
    expect(costBurst.evaluate(ctx(events))).toBeNull()
  })

  it('ignores events outside the window', () => {
    const events: LoopEvent[] = [
      {
        kind: 'model_call_end',
        at: NOW - DEFAULT_THRESHOLDS.cost_burst_window_ms - 1000,
        model: 'm',
        iteration: 0,
        cost_usd: 100,
        finish_reason: 'stop',
      },
    ]
    expect(costBurst.evaluate(ctx(events))).toBeNull()
  })
})

describe('error_storm', () => {
  it('fires on N consecutive failed calls with same error_class', () => {
    const events: LoopEvent[] = []
    for (let i = 0; i < 5; i++) {
      events.push(
        toolEnd({ call_id: `c${String(i)}`, tool: 'fs.read', ok: false, error_class: 'ENOENT' }),
      )
    }
    const v = errorStorm.evaluate(ctx(events))
    expect(v?.kind).toBe('error_storm')
    expect(v?.triggers.length).toBe(5)
  })

  it('resets streak on a successful call between failures', () => {
    const events: LoopEvent[] = [
      toolEnd({ call_id: 'a', tool: 'fs.read', ok: false, error_class: 'ENOENT' }),
      toolEnd({ call_id: 'b', tool: 'fs.read', ok: false, error_class: 'ENOENT' }),
      toolEnd({ call_id: 'c', tool: 'fs.read', ok: true }),
      toolEnd({ call_id: 'd', tool: 'fs.read', ok: false, error_class: 'ENOENT' }),
      toolEnd({ call_id: 'e', tool: 'fs.read', ok: false, error_class: 'ENOENT' }),
    ]
    expect(errorStorm.evaluate(ctx(events))).toBeNull()
  })

  it('resets streak when error_class changes', () => {
    const events: LoopEvent[] = [
      toolEnd({ call_id: 'a', tool: 'fs.read', ok: false, error_class: 'ENOENT' }),
      toolEnd({ call_id: 'b', tool: 'fs.read', ok: false, error_class: 'ENOENT' }),
      toolEnd({ call_id: 'c', tool: 'fs.read', ok: false, error_class: 'EACCES' }),
      toolEnd({ call_id: 'd', tool: 'fs.read', ok: false, error_class: 'EACCES' }),
    ]
    expect(errorStorm.evaluate(ctx(events))).toBeNull()
  })
})

describe('evaluator', () => {
  it('first-firing detector wins', () => {
    const events: LoopEvent[] = []
    for (let i = 0; i < 5; i++) {
      events.push(
        toolEnd({
          call_id: `c${String(i)}`,
          tool: 'fs.read',
          args_hash: 'same',
          ok: false,
          error_class: 'ENOENT',
          duration_ms: 130_000,
        }),
      )
    }
    const v = evaluateDetectors(ctx(events))
    // tool_repetition is first in ACTIVE_DETECTORS, so it wins over error_storm and tool_timeout
    expect(v?.kind).toBe('tool_repetition')
  })

  it('returns null when no detector fires', () => {
    expect(evaluateDetectors(ctx([]))).toBeNull()
  })

  it('ACTIVE_DETECTORS includes all five kinds', () => {
    const kinds = ACTIVE_DETECTORS.map((d) => d.kind).sort()
    expect(kinds).toEqual([
      'cost_burst',
      'error_storm',
      'no_progress',
      'tool_repetition',
      'tool_timeout',
    ])
  })
})
