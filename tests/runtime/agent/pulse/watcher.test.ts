import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PulseWatcher } from '../../../../src/runtime/agent/pulse/watcher.js'
import { agentPaths } from '../../../../src/runtime/storage/layout.js'
import type { PulseState } from '../../../../src/runtime/agent/pulse/types.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-pulse-watch-'))
  await mkdir(agentPaths(home, 'hobby').root, { recursive: true })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

async function writePulse(name: string, value: Partial<PulseState>): Promise<void> {
  const path = join(agentPaths(home, name).root, 'pulse.json')
  const full: PulseState = {
    schema_version: 2,
    agent: name,
    state: 'resting',
    intensity: 0,
    detector_kind: null,
    trip_id: null,
    updated_at: new Date().toISOString(),
    ...value,
  }
  await writeFile(path, JSON.stringify(full), 'utf8')
}

async function settle(): Promise<void> {
  // Yield once for promise microtasks to drain after start() / writePulse.
  await new Promise<void>((r) => setTimeout(r, 0))
}

describe('PulseWatcher', () => {
  it('emits the current pulse on first poll after start', async () => {
    await writePulse('hobby', { state: 'working_medium', intensity: 0.4 })
    const events: PulseState[] = []
    const watcher = new PulseWatcher({
      home,
      agentName: 'hobby',
      onChange: (p) => events.push(p),
    })
    watcher.start()
    await settle()
    // The first poll runs synchronously off the start() call (not on
    // the timer); a microtask yield is enough.
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events[0]?.state).toBe('working_medium')
    expect(events[0]?.intensity).toBe(0.4)
    watcher.stop()
  })

  it('emits a fresh event when updated_at changes', async () => {
    await writePulse('hobby', { state: 'resting', updated_at: '2026-05-06T00:00:00.000Z' })
    const events: PulseState[] = []
    const watcher = new PulseWatcher({
      home,
      agentName: 'hobby',
      onChange: (p) => events.push(p),
      pollIntervalMs: 30,
    })
    watcher.start()
    await new Promise<void>((r) => setTimeout(r, 60))
    const initialCount = events.length
    expect(initialCount).toBeGreaterThanOrEqual(1)

    await writePulse('hobby', {
      state: 'working_hard',
      intensity: 0.8,
      updated_at: '2026-05-06T00:00:01.000Z',
    })
    await new Promise<void>((r) => setTimeout(r, 100))
    const newEvents = events.slice(initialCount)
    expect(newEvents.length).toBeGreaterThanOrEqual(1)
    expect(newEvents[0]?.state).toBe('working_hard')
    watcher.stop()
  })

  it('does NOT re-emit when updated_at is unchanged', async () => {
    const fixed = '2026-05-06T00:00:00.000Z'
    await writePulse('hobby', { state: 'resting', updated_at: fixed })
    const events: PulseState[] = []
    const watcher = new PulseWatcher({
      home,
      agentName: 'hobby',
      onChange: (p) => events.push(p),
      pollIntervalMs: 20,
    })
    watcher.start()
    // Several polls with no change to updated_at; should emit once.
    await new Promise<void>((r) => setTimeout(r, 200))
    watcher.stop()
    expect(events.length).toBe(1)
  })

  it('tolerates a missing pulse.json without throwing', async () => {
    // No pulse file written; readPulse returns null.
    const events: PulseState[] = []
    const watcher = new PulseWatcher({
      home,
      agentName: 'never-pulsed',
      onChange: (p) => events.push(p),
      pollIntervalMs: 30,
    })
    await mkdir(agentPaths(home, 'never-pulsed').root, { recursive: true })
    watcher.start()
    await new Promise<void>((r) => setTimeout(r, 100))
    expect(events.length).toBe(0)
    watcher.stop()
  })

  it('tolerates a malformed pulse.json without throwing', async () => {
    const path = join(agentPaths(home, 'hobby').root, 'pulse.json')
    await writeFile(path, 'not json', 'utf8')
    const events: PulseState[] = []
    const watcher = new PulseWatcher({
      home,
      agentName: 'hobby',
      onChange: (p) => events.push(p),
      pollIntervalMs: 30,
    })
    watcher.start()
    await new Promise<void>((r) => setTimeout(r, 100))
    // Write a valid pulse and confirm the watcher recovered.
    await writePulse('hobby', { state: 'working_light', intensity: 0.2 })
    await new Promise<void>((r) => setTimeout(r, 100))
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events[events.length - 1]?.state).toBe('working_light')
    watcher.stop()
  })

  it('isRunning reflects start / stop transitions', () => {
    const watcher = new PulseWatcher({
      home,
      agentName: 'hobby',
      onChange: () => undefined,
    })
    expect(watcher.isRunning()).toBe(false)
    watcher.start()
    expect(watcher.isRunning()).toBe(true)
    watcher.stop()
    expect(watcher.isRunning()).toBe(false)
  })

  it('stop() makes start() emit again on the next change even when updated_at matches the prior emit', async () => {
    const fixed = '2026-05-06T00:00:00.000Z'
    await writePulse('hobby', { state: 'resting', updated_at: fixed })
    const events: PulseState[] = []
    const watcher = new PulseWatcher({
      home,
      agentName: 'hobby',
      onChange: (p) => events.push(p),
      pollIntervalMs: 20,
    })
    watcher.start()
    await new Promise<void>((r) => setTimeout(r, 80))
    expect(events.length).toBe(1)
    watcher.stop()
    // Restart without changing the file ... the watcher should
    // re-broadcast because lastUpdatedAt was reset.
    watcher.start()
    await new Promise<void>((r) => setTimeout(r, 80))
    expect(events.length).toBeGreaterThanOrEqual(2)
    watcher.stop()
  })

  it('isolates onChange exceptions from the polling loop', async () => {
    await writePulse('hobby', { state: 'resting', updated_at: '2026-05-06T00:00:00.000Z' })
    const onChange = vi.fn(() => {
      throw new Error('callback boom')
    })
    const watcher = new PulseWatcher({
      home,
      agentName: 'hobby',
      onChange,
      pollIntervalMs: 20,
    })
    watcher.start()
    // Bump updated_at twice so the callback is invoked twice; if the
    // first throw stopped the loop, the second invocation never
    // happens.
    await new Promise<void>((r) => setTimeout(r, 60))
    await writePulse('hobby', { state: 'working_medium', updated_at: '2026-05-06T00:00:01.000Z' })
    await new Promise<void>((r) => setTimeout(r, 100))
    expect(onChange.mock.calls.length).toBeGreaterThanOrEqual(2)
    watcher.stop()
  })
})
