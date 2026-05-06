import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BUDGET_STATE_SCHEMA_VERSION,
  listBudgetHistory,
  readBudgetOverride,
  readBudgetStateForDay,
  readBudgetStateToday,
  utcDay,
  type BudgetState,
} from '../../../src/runtime/agent/budget-reader.js'
import { agentBudgetDir } from '../../../src/runtime/storage/layout.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-budget-rd-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

async function writeDay(name: string, state: BudgetState): Promise<void> {
  const dir = agentBudgetDir(home, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${state.day}.json`), JSON.stringify(state), 'utf8')
}

function makeState(day: string, overrides: Partial<BudgetState> = {}): BudgetState {
  return {
    schema_version: BUDGET_STATE_SCHEMA_VERSION,
    day,
    agent: 'hobby',
    cumulative_usd: 0,
    cap_usd: 25,
    warn_at_pct: 80,
    warned_today: false,
    blocked: false,
    last_recorded_at: null,
    ...overrides,
  }
}

describe('utcDay', () => {
  it('formats a UTC date as YYYY-MM-DD', () => {
    expect(utcDay(new Date('2026-05-06T18:30:00Z'))).toBe('2026-05-06')
  })
})

describe('readBudgetStateForDay', () => {
  it('returns null when no file for that day', async () => {
    expect(await readBudgetStateForDay(home, 'hobby', '2026-05-06')).toBeNull()
  })

  it('round-trips a written state', async () => {
    const state = makeState('2026-05-06', {
      cumulative_usd: 12.34,
      last_recorded_at: '2026-05-06T18:00:00.000Z',
    })
    await writeDay('hobby', state)
    const rd = await readBudgetStateForDay(home, 'hobby', '2026-05-06')
    expect(rd).toEqual(state)
  })

  it('throws on malformed JSON', async () => {
    const dir = agentBudgetDir(home, 'hobby')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '2026-05-06.json'), 'not json', 'utf8')
    await expect(readBudgetStateForDay(home, 'hobby', '2026-05-06')).rejects.toThrow()
  })

  it('throws on schema mismatch', async () => {
    const dir = agentBudgetDir(home, 'hobby')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '2026-05-06.json'), JSON.stringify({ foo: 'bar' }), 'utf8')
    await expect(readBudgetStateForDay(home, 'hobby', '2026-05-06')).rejects.toThrow()
  })
})

describe('readBudgetStateToday', () => {
  it('reads the file for the current UTC day', async () => {
    const fixed = new Date('2026-05-06T12:00:00Z')
    const state = makeState('2026-05-06', { cumulative_usd: 5 })
    await writeDay('hobby', state)
    const rd = await readBudgetStateToday(home, 'hobby', () => fixed)
    expect(rd?.cumulative_usd).toBe(5)
  })
})

describe('readBudgetOverride', () => {
  it('returns null when no override file', async () => {
    expect(await readBudgetOverride(home, 'hobby')).toBeNull()
  })

  it('reads a valid override', async () => {
    const dir = agentBudgetDir(home, 'hobby')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'override.json'),
      JSON.stringify({ schema_version: 1, until: '2026-05-07T00:00:00Z', reason: 'investigating' }),
      'utf8',
    )
    const o = await readBudgetOverride(home, 'hobby')
    expect(o?.until).toBe('2026-05-07T00:00:00Z')
    expect(o?.reason).toBe('investigating')
  })
})

describe('listBudgetHistory', () => {
  it('returns [] for an Agent with no budget dir', async () => {
    expect(await listBudgetHistory(home, 'never-spent')).toEqual([])
  })

  it('returns days oldest-first and skips override.json', async () => {
    await writeDay('hobby', makeState('2026-05-04', { cumulative_usd: 1 }))
    await writeDay('hobby', makeState('2026-05-06', { cumulative_usd: 3 }))
    await writeDay('hobby', makeState('2026-05-05', { cumulative_usd: 2 }))
    const dir = agentBudgetDir(home, 'hobby')
    await writeFile(
      join(dir, 'override.json'),
      JSON.stringify({ schema_version: 1, until: '2026-05-07T00:00:00Z' }),
      'utf8',
    )
    const list = await listBudgetHistory(home, 'hobby')
    expect(list.map((s) => s.day)).toEqual(['2026-05-04', '2026-05-05', '2026-05-06'])
    expect(list.map((s) => s.cumulative_usd)).toEqual([1, 2, 3])
  })

  it('skips entries that fail to parse', async () => {
    await writeDay('hobby', makeState('2026-05-06', { cumulative_usd: 5 }))
    const dir = agentBudgetDir(home, 'hobby')
    await writeFile(join(dir, '2026-05-05.json'), 'not json', 'utf8')
    const list = await listBudgetHistory(home, 'hobby')
    expect(list.map((s) => s.day)).toEqual(['2026-05-06'])
  })

  it('ignores files whose names are not YYYY-MM-DD', async () => {
    const dir = agentBudgetDir(home, 'hobby')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'random.json'), JSON.stringify(makeState('2026-05-06')), 'utf8')
    expect(await listBudgetHistory(home, 'hobby')).toEqual([])
  })
})
