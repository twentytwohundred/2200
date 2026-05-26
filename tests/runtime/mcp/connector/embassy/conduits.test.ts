import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deleteConduit,
  ensureConduitsDir,
  listConduits,
  markRetired,
  readConduit,
  recordLastSeen,
  regenerateConduitsIndex,
  writeConduit,
} from '../../../../../src/runtime/mcp/connector/embassy/conduits.js'
import { buildConduitRecord } from '../../../../../src/runtime/mcp/connector/embassy/registration.js'
import type { ConduitRecord } from '../../../../../src/runtime/mcp/connector/embassy/types.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-conduits-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function fixture(overrides: Partial<ConduitRecord> = {}): ConduitRecord {
  return buildConduitRecord({
    clientId: overrides.client_id ?? 'grok-aaa',
    externalModel: overrides.external_model ?? 'grok',
    embassyAgent: overrides.embassy_agent ?? 'grok-embassy',
    mode: overrides.mode ?? 'dedicated',
    displayName: overrides.display_name ?? 'Grok (test)',
    registeredAt: overrides.registered_at ?? '2026-05-26T10:00:00.000Z',
    registeredBy: overrides.registered_by ?? 'cli',
  })
}

describe('writeConduit / readConduit', () => {
  it('round-trips a record', async () => {
    const r = fixture()
    await writeConduit(home, r)
    const got = await readConduit(home, r.client_id)
    expect(got).toEqual(r)
  })

  it('readConduit returns null for unknown client_id', async () => {
    expect(await readConduit(home, 'grok-nope')).toBeNull()
  })
})

describe('listConduits', () => {
  it('returns an empty array when the dir does not exist', async () => {
    expect(await listConduits(home)).toEqual([])
  })

  it('returns an empty array when the dir exists but is empty', async () => {
    await ensureConduitsDir(home)
    expect(await listConduits(home)).toEqual([])
  })

  it('lists conduits sorted by registered_at descending', async () => {
    await writeConduit(
      home,
      fixture({ client_id: 'grok-older', registered_at: '2026-05-26T09:00:00.000Z' }),
    )
    await writeConduit(
      home,
      fixture({ client_id: 'grok-newer', registered_at: '2026-05-26T11:00:00.000Z' }),
    )
    const items = await listConduits(home)
    expect(items.map((c) => c.client_id)).toEqual(['grok-newer', 'grok-older'])
  })
})

describe('deleteConduit', () => {
  it('is idempotent', async () => {
    await writeConduit(home, fixture())
    expect(await deleteConduit(home, 'grok-aaa')).toBe(true)
    expect(await deleteConduit(home, 'grok-aaa')).toBe(false)
  })
})

describe('recordLastSeen', () => {
  it('patches last_seen_at without disturbing other fields', async () => {
    await writeConduit(home, fixture())
    await recordLastSeen(home, 'grok-aaa', new Date('2026-05-26T12:00:00Z'))
    const got = await readConduit(home, 'grok-aaa')
    expect(got?.last_seen_at).toBe('2026-05-26T12:00:00.000Z')
    expect(got?.display_name).toBe('Grok (test)')
  })

  it('is a no-op on unknown client_id', async () => {
    await recordLastSeen(home, 'grok-nope', new Date()) // does not throw
  })
})

describe('markRetired', () => {
  it('sets retired_at on the record', async () => {
    await writeConduit(home, fixture())
    await markRetired(home, 'grok-aaa', new Date('2026-05-26T13:00:00Z'))
    const got = await readConduit(home, 'grok-aaa')
    expect(got?.retired_at).toBe('2026-05-26T13:00:00.000Z')
  })

  it('throws on unknown client_id', async () => {
    await expect(markRetired(home, 'grok-nope', new Date())).rejects.toThrow(/unknown client_id/)
  })
})

describe('regenerateConduitsIndex', () => {
  it('writes a fresh <shared>/brain/conduits.md mirroring the registry', async () => {
    await writeConduit(home, fixture({ client_id: 'grok-a', display_name: 'Active Grok' }))
    const retired = fixture({
      client_id: 'grok-r',
      display_name: 'Retired Grok',
      registered_at: '2026-05-26T09:00:00.000Z',
    })
    retired.retired_at = '2026-05-26T10:00:00.000Z'
    await writeConduit(home, retired)
    await regenerateConduitsIndex(home)
    const path = join(home, 'shared', 'brain', 'conduits.md')
    const body = await readFile(path, 'utf-8')
    expect(body).toContain('Active Grok')
    expect(body).toContain('Retired Grok')
    expect(body).toContain('## Active')
    expect(body).toContain('## Retired')
  })

  it('handles an empty registry without crashing', async () => {
    await regenerateConduitsIndex(home)
    const path = join(home, 'shared', 'brain', 'conduits.md')
    const body = await readFile(path, 'utf-8')
    expect(body).toContain('No conduits registered')
  })
})

describe('file does not contain the OAuth client_secret', () => {
  it('client_secret is NOT a field on ConduitRecord, ever', async () => {
    // Defensive: even if a future refactor leaks the secret into the
    // ConduitRecord type, this test catches it at write time.
    const r = fixture() as unknown as Record<string, unknown>
    expect('client_secret' in r).toBe(false)
    await writeConduit(home, r as unknown as ConduitRecord)
    const path = join(home, 'state', 'connector', 'conduits', 'grok-aaa.json')
    const raw = await readFile(path, 'utf-8')
    expect(raw).not.toMatch(/client_secret/i)
  })
})
