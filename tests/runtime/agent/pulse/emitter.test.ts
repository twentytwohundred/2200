import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bandFor, PulseEmitter } from '../../../../src/runtime/agent/pulse/emitter.js'
import {
  PULSE_SCHEMA_VERSION,
  PulseStateSchema,
} from '../../../../src/runtime/agent/pulse/types.js'
import { agentPaths } from '../../../../src/runtime/storage/layout.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-pulse-'))
  await mkdir(agentPaths(home, 'hobby').root, { recursive: true })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

async function readPulseFile(): Promise<unknown> {
  const path = join(agentPaths(home, 'hobby').root, 'pulse.json')
  const raw = await readFile(path, 'utf8')
  return JSON.parse(raw)
}

describe('bandFor', () => {
  it.each([
    [0, 'resting'],
    [0.04, 'resting'],
    [0.05, 'working_light'],
    [0.24, 'working_light'],
    [0.25, 'working_medium'],
    [0.49, 'working_medium'],
    [0.5, 'working_hard'],
    [0.84, 'working_hard'],
    [0.85, 'redlined'],
    [1.0, 'redlined'],
  ])('intensity %s ⇒ %s', (intensity, expected) => {
    expect(bandFor(intensity)).toBe(expected)
  })
})

describe('PulseEmitter', () => {
  it('writes a v2 record on tick with state=resting + intensity=0 when idle', async () => {
    const t0 = 1_000_000
    const emitter = new PulseEmitter({
      home,
      agentName: 'hobby',
      now: () => t0,
    })
    await emitter.tick()
    const parsed = PulseStateSchema.parse(await readPulseFile())
    expect(parsed.schema_version).toBe(PULSE_SCHEMA_VERSION)
    expect(parsed.state).toBe('resting')
    expect(parsed.intensity).toBe(0)
    expect(parsed.detector_kind).toBeNull()
    expect(parsed.trip_id).toBeNull()
  })

  it('escalates upward immediately when activity spikes', async () => {
    const now = 1_000_000
    const emitter = new PulseEmitter({
      home,
      agentName: 'hobby',
      now: () => now,
      // Target $0.10/min over 60s window = $0.10 worth of cost in window = intensity 1.0
      windowMs: 60_000,
      targetUsdPerMinute: 0.1,
    })
    // Drop $0.09 of cost across recent events ⇒ intensity ~ 0.9 ⇒ redlined
    emitter.record({
      kind: 'model_call_end',
      at: now - 1_000,
      model: 'test/m',
      iteration: 1,
      cost_usd: 0.09,
      finish_reason: 'stop',
    })
    await emitter.tick()
    const parsed = PulseStateSchema.parse(await readPulseFile())
    expect(parsed.state).toBe('redlined')
    expect(parsed.intensity).toBeGreaterThanOrEqual(0.85)
  })

  it('decays only after the dwell window when activity falls', async () => {
    let now = 1_000_000
    const emitter = new PulseEmitter({
      home,
      agentName: 'hobby',
      now: () => now,
      windowMs: 60_000,
      targetUsdPerMinute: 0.1,
      dwellMs: 2_000,
    })
    // Spike to redlined.
    emitter.record({
      kind: 'model_call_end',
      at: now - 1_000,
      model: 't',
      iteration: 1,
      cost_usd: 0.09,
      finish_reason: 'stop',
    })
    await emitter.tick()
    expect(emitter.snapshot().state).toBe('redlined')

    // Activity stops; advance 1s (less than dwell) ... still redlined.
    now += 1_000
    await emitter.tick()
    expect(emitter.snapshot().state).toBe('redlined')

    // Advance past the 60s window so the spike falls out and intensity
    // returns to 0. First tick records the new candidate; second tick
    // (after dwellMs) commits the downward state change.
    now += 60_000
    await emitter.tick()
    expect(emitter.snapshot().state).toBe('redlined')
    now += 3_000
    await emitter.tick()
    expect(emitter.snapshot().state).toBe('resting')
  })

  it('respects a detector trip pin until cleared', async () => {
    const emitter = new PulseEmitter({
      home,
      agentName: 'hobby',
      now: () => 1_000_000,
    })
    emitter.setTrip('tool_repetition', 'trip-abc')
    await emitter.tick()
    const tripped = PulseStateSchema.parse(await readPulseFile())
    expect(tripped.state).toBe('redlined')
    expect(tripped.detector_kind).toBe('tool_repetition')
    expect(tripped.trip_id).toBe('trip-abc')

    // Clear the trip; without activity the dot drops to resting.
    emitter.clearTrip()
    await emitter.tick()
    const resting = PulseStateSchema.parse(await readPulseFile())
    expect(resting.state).toBe('resting')
    expect(resting.detector_kind).toBeNull()
    expect(resting.trip_id).toBeNull()
  })

  it('writes state=stopped on stop() and clears trip pin', async () => {
    const emitter = new PulseEmitter({
      home,
      agentName: 'hobby',
      now: () => 1_000_000,
    })
    emitter.setTrip('error_storm', 'trip-x')
    await emitter.stop()
    const parsed = PulseStateSchema.parse(await readPulseFile())
    expect(parsed.state).toBe('stopped')
    expect(parsed.intensity).toBe(0)
    expect(parsed.detector_kind).toBeNull()
    expect(parsed.trip_id).toBeNull()
  })

  it('weights tool calls toward intensity', async () => {
    const emitter = new PulseEmitter({
      home,
      agentName: 'hobby',
      now: () => 1_000_000,
      windowMs: 60_000,
      targetUsdPerMinute: 0.06, // smaller target so each tool call counts more
    })
    // 20 tool calls in window @ $0.005 each = $0.10 ⇒ intensity > 1.0
    for (let i = 0; i < 20; i++) {
      emitter.record({
        kind: 'tool_call_end',
        at: 999_000 + i * 100,
        call_id: `c${String(i)}`,
        tool: 'fs.read',
        args_hash: 'h',
        iteration: 1,
        ok: true,
        duration_ms: 5,
      })
    }
    await emitter.tick()
    expect(emitter.snapshot().state).toBe('redlined')
  })

  it('discards events older than the window', async () => {
    const now = 1_000_000
    const emitter = new PulseEmitter({
      home,
      agentName: 'hobby',
      now: () => now,
      windowMs: 60_000,
      targetUsdPerMinute: 0.1,
    })
    emitter.record({
      kind: 'model_call_end',
      at: now - 90_000, // outside window
      model: 't',
      iteration: 1,
      cost_usd: 0.5,
      finish_reason: 'stop',
    })
    await emitter.tick()
    expect(emitter.snapshot().state).toBe('resting')
    expect(emitter.snapshot().intensity).toBe(0)
  })
})
