/**
 * Tests for supervisor state load/save round-trip.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadState, saveState, stateFilePath } from '../../../src/runtime/supervisor/state.js'
import { emptyState } from '../../../src/runtime/supervisor/types.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), '2200-supervisor-state-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('loadState', () => {
  it('returns an empty state when supervisor.json does not exist', async () => {
    const state = await loadState(dir)
    expect(state.schema_version).toBe('0.1')
    expect(state.state_dir).toBe(dir)
    expect(state.agents).toEqual({})
  })

  it('parses an existing supervisor.json round-tripped via saveState', async () => {
    const initial = emptyState(dir)
    initial.agents['hobby'] = {
      name: 'hobby',
      identity_path: '/tmp/hobby.md',
      state: 'stopped',
      pid: null,
      spawned_at: null,
      last_heartbeat: null,
      errored_at: null,
      errored_reason: null,
      current_task_id: null,
    }
    await saveState(initial)
    const loaded = await loadState(dir)
    expect(loaded.agents['hobby']?.identity_path).toBe('/tmp/hobby.md')
    expect(loaded.agents['hobby']?.state).toBe('stopped')
  })

  it('throws on malformed JSON', async () => {
    await writeFile(stateFilePath(dir), '{ not valid json')
    await expect(loadState(dir)).rejects.toThrow(/not valid JSON/)
  })

  it('throws on schema mismatch', async () => {
    await writeFile(
      stateFilePath(dir),
      JSON.stringify({ schema_version: '0.1', state_dir: dir, agents: { bad: { wrong: true } } }),
    )
    await expect(loadState(dir)).rejects.toThrow(/schema validation/)
  })

  it('updates state_dir to the current path on load', async () => {
    const otherDir = '/tmp/some-old-path'
    const initial = { ...emptyState(otherDir), state_dir: otherDir }
    await saveState({ ...initial, state_dir: dir })
    const loaded = await loadState(dir)
    expect(loaded.state_dir).toBe(dir)
  })
})

describe('saveState', () => {
  it('creates the state directory if missing', async () => {
    const subdir = join(dir, 'nested')
    const state = emptyState(subdir)
    await saveState(state)
    const loaded = await loadState(subdir)
    expect(loaded.state_dir).toBe(subdir)
  })
})
