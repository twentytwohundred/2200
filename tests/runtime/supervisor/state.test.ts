/**
 * Tests for supervisor state load/save round-trip.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadState, saveState, stateFilePath } from '../../../src/runtime/supervisor/state.js'
import { emptyState } from '../../../src/runtime/supervisor/types.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-supervisor-state-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('loadState', () => {
  it('returns an empty state when supervisor.json does not exist', async () => {
    const state = await loadState(home)
    expect(state.schema_version).toBe(1)
    expect(state.home).toBe(home)
    expect(state.state_dir).toBe(join(home, 'state'))
    expect(state.agents).toEqual({})
  })

  it('parses an existing supervisor.json round-tripped via saveState', async () => {
    const initial = emptyState(home)
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
    const loaded = await loadState(home)
    expect(loaded.agents['hobby']?.identity_path).toBe('/tmp/hobby.md')
    expect(loaded.agents['hobby']?.state).toBe('stopped')
  })

  it('throws on malformed JSON', async () => {
    await mkdir(join(home, 'state'), { recursive: true })
    await writeFile(stateFilePath(home), '{ not valid json')
    await expect(loadState(home)).rejects.toThrow(/not valid JSON/)
  })

  it('throws on schema mismatch', async () => {
    await mkdir(join(home, 'state'), { recursive: true })
    await writeFile(
      stateFilePath(home),
      JSON.stringify({
        schema_version: 1,
        home,
        state_dir: join(home, 'state'),
        agents: { bad: { wrong: true } },
      }),
    )
    await expect(loadState(home)).rejects.toThrow(/schema validation/)
  })

  it('updates home and state_dir to the current path on load', async () => {
    const otherHome = '/tmp/some-old-path'
    const initial = { ...emptyState(otherHome) }
    await saveState({ ...initial, home, state_dir: join(home, 'state') })
    const loaded = await loadState(home)
    expect(loaded.home).toBe(home)
    expect(loaded.state_dir).toBe(join(home, 'state'))
  })
})

describe('saveState', () => {
  it('creates the state subdirectory if missing', async () => {
    const subhome = join(home, 'nested')
    const state = emptyState(subhome)
    await saveState(state)
    const loaded = await loadState(subhome)
    expect(loaded.home).toBe(subhome)
    expect(loaded.state_dir).toBe(join(subhome, 'state'))
  })
})
