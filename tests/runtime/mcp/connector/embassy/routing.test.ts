import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCallingEmbassy } from '../../../../../src/runtime/mcp/connector/embassy/routing.js'
import { writeConduit } from '../../../../../src/runtime/mcp/connector/embassy/conduits.js'
import { buildConduitRecord } from '../../../../../src/runtime/mcp/connector/embassy/registration.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-routing-'))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('resolveCallingEmbassy', () => {
  it('returns null when callingClientId is null (static-bearer caller)', async () => {
    expect(await resolveCallingEmbassy(home, null)).toBeNull()
  })

  it('returns null when no conduit is registered for the client_id', async () => {
    expect(await resolveCallingEmbassy(home, 'grok-unknown')).toBeNull()
  })

  it('returns the embassy context when a non-retired conduit matches', async () => {
    await writeConduit(
      home,
      buildConduitRecord({
        clientId: 'grok-aaa',
        externalModel: 'grok',
        embassyAgent: 'grok-embassy',
        mode: 'dedicated',
        displayName: 'Grok',
        registeredAt: '2026-05-26T10:00:00.000Z',
        registeredBy: 'cli',
      }),
    )
    const result = await resolveCallingEmbassy(home, 'grok-aaa')
    expect(result?.embassyAgent).toBe('grok-embassy')
    expect(result?.conduit.client_id).toBe('grok-aaa')
  })

  it('returns null when the matching conduit is retired', async () => {
    const r = buildConduitRecord({
      clientId: 'grok-aaa',
      externalModel: 'grok',
      embassyAgent: 'grok-embassy',
      mode: 'dedicated',
      displayName: 'Grok',
      registeredAt: '2026-05-26T10:00:00.000Z',
      registeredBy: 'cli',
    })
    r.retired_at = '2026-05-26T11:00:00.000Z'
    await writeConduit(home, r)
    expect(await resolveCallingEmbassy(home, 'grok-aaa')).toBeNull()
  })

  it('records last_seen_at on the conduit when it matches', async () => {
    await writeConduit(
      home,
      buildConduitRecord({
        clientId: 'grok-aaa',
        externalModel: 'grok',
        embassyAgent: 'grok-embassy',
        mode: 'dedicated',
        displayName: 'Grok',
        registeredAt: '2026-05-26T10:00:00.000Z',
        registeredBy: 'cli',
      }),
    )
    const r = await resolveCallingEmbassy(home, 'grok-aaa')
    expect(r?.conduit.last_seen_at).toBeNull() // value captured BEFORE recordLastSeen wrote
    // Re-read: last_seen_at should now be set.
    const { readConduit } =
      await import('../../../../../src/runtime/mcp/connector/embassy/conduits.js')
    const fresh = await readConduit(home, 'grok-aaa')
    expect(fresh?.last_seen_at).not.toBeNull()
  })
})
