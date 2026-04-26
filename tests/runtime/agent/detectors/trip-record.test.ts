/**
 * Tests for the detector trip writer: trip record on disk, passive
 * notification, pulse-state file flip.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import {
  resetPulseToGreen,
  writeDetectorTrip,
} from '../../../../src/runtime/agent/detectors/trip-record.js'
import { DEFAULT_THRESHOLDS } from '../../../../src/runtime/agent/detectors/types.js'
import { agentPaths, homePaths } from '../../../../src/runtime/storage/layout.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-trip-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('writeDetectorTrip', () => {
  it('writes trip record, notification, and pulse all in one call', async () => {
    const ap = agentPaths(home, 'hobby')
    const result = await writeDetectorTrip({
      home,
      agentName: 'hobby',
      brainDir: ap.brain,
      verdict: {
        kind: 'tool_repetition',
        detail: 'fs.read called 5 times',
        triggers: ['call_a', 'call_b', 'call_c', 'call_d', 'call_e'],
        threshold_used: { tool_repetition_n: 5 },
      },
      agentSnapshot: {
        agent_name: 'hobby',
        current_task_id: 'task_x',
        task_idempotency: 'pure',
        iteration: 7,
        recent_state: 'running',
      },
      thresholds: DEFAULT_THRESHOLDS,
    })

    expect(result.trip_id).toMatch(/^trip_/)
    expect(result.notification_id).toMatch(/^notif_/)

    const tripRaw = await readFile(result.trip_path, 'utf8')
    expect(tripRaw).toContain('schema_version: 1')
    expect(tripRaw).toContain('kind: tool_repetition')
    expect(tripRaw).toContain('# Detector trip: tool_repetition')
    const tripFm = parse(tripRaw.split('---')[1] ?? '') as Record<string, unknown>
    expect(tripFm['id']).toBe(result.trip_id)
    expect(tripFm['notification_id']).toBe(result.notification_id)
    expect((tripFm['triggers'] as string[]).length).toBe(5)
    expect(tripFm['resolution']).toBeNull()

    const notifRaw = await readFile(result.notification_path, 'utf8')
    expect(notifRaw).toContain('tier: passive')
    expect(notifRaw).toContain('detector_kind: tool_repetition')
    const notifFm = parse(notifRaw.split('---')[1] ?? '') as Record<string, unknown>
    expect(notifFm['id']).toBe(result.notification_id)
    expect(notifFm['trip_id']).toBe(result.trip_id)

    const pulseRaw = await readFile(result.pulse_path, 'utf8')
    const pulse = JSON.parse(pulseRaw) as Record<string, unknown>
    expect(pulse['state']).toBe('redlined')
    expect(pulse['detector_kind']).toBe('tool_repetition')
    expect(pulse['trip_id']).toBe(result.trip_id)
    expect(pulse['schema_version']).toBe(1)
  })

  it('writes notification under <home>/state/notifications/', async () => {
    const ap = agentPaths(home, 'hobby')
    const result = await writeDetectorTrip({
      home,
      agentName: 'hobby',
      brainDir: ap.brain,
      verdict: {
        kind: 'no_progress',
        detail: '60 iterations without brain write',
        triggers: [],
        threshold_used: { no_progress_iterations: 50 },
      },
      agentSnapshot: {
        agent_name: 'hobby',
        current_task_id: null,
        task_idempotency: null,
        iteration: 60,
        recent_state: 'running',
      },
      thresholds: DEFAULT_THRESHOLDS,
    })
    expect(result.notification_path.startsWith(homePaths(home).stateNotifications)).toBe(true)
  })

  it('writes pulse under <home>/agents/<name>/pulse.json', async () => {
    const ap = agentPaths(home, 'hobby')
    const result = await writeDetectorTrip({
      home,
      agentName: 'hobby',
      brainDir: ap.brain,
      verdict: {
        kind: 'cost_burst',
        detail: 'cost over $5',
        triggers: [],
        threshold_used: {},
      },
      agentSnapshot: {
        agent_name: 'hobby',
        current_task_id: null,
        task_idempotency: null,
        iteration: 1,
        recent_state: 'running',
      },
      thresholds: DEFAULT_THRESHOLDS,
    })
    expect(result.pulse_path).toBe(join(ap.root, 'pulse.json'))
  })
})

describe('resetPulseToGreen', () => {
  it('writes a green pulse', async () => {
    await resetPulseToGreen({ home, agentName: 'hobby' })
    const pulse = JSON.parse(
      await readFile(join(agentPaths(home, 'hobby').root, 'pulse.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(pulse['state']).toBe('green')
    expect(pulse['detector_kind']).toBeNull()
    expect(pulse['trip_id']).toBeNull()
    expect(pulse['schema_version']).toBe(1)
  })
})
