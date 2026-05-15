import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CredentialRequestStore,
  resolveRateCap,
  waitForResolution,
} from '../../../src/runtime/credentials/requests.js'
import {
  CredentialRequestError,
  CredentialRequestSchema,
  DEFAULT_RATE_PER_HOUR,
  toEnvelopeV1,
  type CredentialRequest,
} from '../../../src/runtime/credentials/request-types.js'
import { newCredentialRequestId } from '../../../src/runtime/util/id.js'
import { credentialRequestPath } from '../../../src/runtime/storage/layout.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-credreq-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function pendingRecord(overrides: Partial<CredentialRequest> = {}): CredentialRequest {
  const now = new Date('2026-05-15T12:00:00.000Z')
  const created = now.toISOString()
  const expires = new Date(now.getTime() + 5 * 60 * 1000).toISOString()
  return CredentialRequestSchema.parse({
    schema_version: 1,
    id: newCredentialRequestId(),
    agent: 'hobby',
    chat_id: 'chat_abc',
    credential_name: 'openpub--private-key',
    label: 'OpenPub Private Key',
    help: 'paste from dashboard',
    kind: 'secret',
    reason: 'authenticate to openpub',
    created_at: created,
    expires_at: expires,
    state: 'pending',
    fulfilled_at: null,
    declined_at: null,
    decline_reason: null,
    expired_at: null,
    expired_reason: null,
    ...overrides,
  })
}

describe('CredentialRequestStore.create + get', () => {
  it('round-trips a pending record without ever storing a value field', async () => {
    const store = new CredentialRequestStore(home)
    const rec = pendingRecord()
    await store.create(rec)
    const raw = await readFile(credentialRequestPath(home, rec.id), 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(parsed['state']).toBe('pending')
    expect('value' in parsed).toBe(false)
    const got = await store.get(rec.id)
    expect(got.credential_name).toBe('openpub--private-key')
    expect(got.expired_reason).toBeNull()
  })

  it('throws NOT_FOUND for an unknown id', async () => {
    const store = new CredentialRequestStore(home)
    await expect(store.get('credreq_deadbeef')).rejects.toBeInstanceOf(CredentialRequestError)
    await expect(store.get('credreq_deadbeef')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('rejects schema-invalid records on load', async () => {
    const store = new CredentialRequestStore(home)
    const rec = pendingRecord()
    await store.create(rec)
    const path = credentialRequestPath(home, rec.id)
    const raw = await readFile(path, 'utf-8')
    const obj = JSON.parse(raw) as Record<string, unknown>
    obj['state'] = 'not-a-real-state'
    await rm(path)
    const { atomicWriteJson } = await import('../../../src/runtime/util/atomic-write.js')
    await atomicWriteJson(path, obj)
    await expect(store.get(rec.id)).rejects.toMatchObject({ code: 'CORRUPT' })
  })
})

describe('CredentialRequestStore.list', () => {
  it('filters by agent + state + chat_id, sorted by id', async () => {
    const store = new CredentialRequestStore(home)
    const a = pendingRecord({ agent: 'hobby', chat_id: 'chat_a' })
    const b = pendingRecord({ agent: 'hobby', chat_id: 'chat_b' })
    const c = pendingRecord({ agent: 'simon', chat_id: 'chat_a' })
    await store.create(a)
    await store.create(b)
    await store.create(c)
    const hobbyList = await store.list({ agent: 'hobby' })
    expect(hobbyList).toHaveLength(2)
    const inChatA = await store.list({ chat_id: 'chat_a' })
    expect(inChatA.map((r) => r.agent).sort()).toEqual(['hobby', 'simon'])
    const empty = await store.list({ state: 'fulfilled' })
    expect(empty).toEqual([])
  })

  it('skips the rate-cap state files', async () => {
    const store = new CredentialRequestStore(home)
    await store.checkAndIncrementRate({
      agent: 'hobby',
      cap: 15,
      now: new Date('2026-05-15T12:00:00.000Z'),
    })
    const list = await store.list({})
    expect(list).toEqual([])
  })

  it('returns empty when the directory does not exist', async () => {
    const store = new CredentialRequestStore(home)
    expect(await store.list()).toEqual([])
  })
})

describe('CredentialRequestStore.transition', () => {
  it('moves pending → fulfilled with timestamps', async () => {
    const store = new CredentialRequestStore(home)
    const rec = pendingRecord()
    await store.create(rec)
    const updated = await store.transition(rec.id, 'fulfilled', {
      now: '2026-05-15T12:01:00.000Z',
    })
    expect(updated.state).toBe('fulfilled')
    expect(updated.fulfilled_at).toBe('2026-05-15T12:01:00.000Z')
    expect(updated.declined_at).toBeNull()
    expect(updated.expired_at).toBeNull()
  })

  it('moves pending → declined with the operator reason', async () => {
    const store = new CredentialRequestStore(home)
    const rec = pendingRecord()
    await store.create(rec)
    const updated = await store.transition(rec.id, 'declined', {
      now: '2026-05-15T12:02:00.000Z',
      decline_reason: 'not now, ask later',
    })
    expect(updated.state).toBe('declined')
    expect(updated.decline_reason).toBe('not now, ask later')
  })

  it('moves pending → expired with expired_reason defaulting to timeout', async () => {
    const store = new CredentialRequestStore(home)
    const rec = pendingRecord()
    await store.create(rec)
    const updated = await store.transition(rec.id, 'expired', {
      now: '2026-05-15T12:05:00.000Z',
    })
    expect(updated.state).toBe('expired')
    expect(updated.expired_reason).toBe('timeout')
  })

  it('records agent_crashed when supervisor sweeps a dead agent', async () => {
    const store = new CredentialRequestStore(home)
    const rec = pendingRecord()
    await store.create(rec)
    const updated = await store.transition(rec.id, 'expired', {
      now: '2026-05-15T12:02:00.000Z',
      expired_reason: 'agent_crashed',
    })
    expect(updated.expired_reason).toBe('agent_crashed')
  })

  it('refuses to transition from a terminal state', async () => {
    const store = new CredentialRequestStore(home)
    const rec = pendingRecord()
    await store.create(rec)
    await store.transition(rec.id, 'fulfilled', { now: '2026-05-15T12:01:00.000Z' })
    await expect(
      store.transition(rec.id, 'declined', { now: '2026-05-15T12:02:00.000Z' }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' })
  })
})

describe('CredentialRequestStore rate cap', () => {
  it('opens a fresh window when none exists', async () => {
    const store = new CredentialRequestStore(home)
    const now = new Date('2026-05-15T12:00:00.000Z')
    const res = await store.checkAndIncrementRate({ agent: 'hobby', cap: 15, now })
    expect(res).toMatchObject({ ok: true, count: 1, cap: 15 })
  })

  it('increments within the same window up to the cap, then refuses', async () => {
    const store = new CredentialRequestStore(home)
    const now = new Date('2026-05-15T12:00:00.000Z')
    for (let i = 0; i < 3; i++) {
      const r = await store.checkAndIncrementRate({ agent: 'hobby', cap: 3, now })
      expect(r.ok).toBe(true)
      expect(r.count).toBe(i + 1)
    }
    const denied = await store.checkAndIncrementRate({ agent: 'hobby', cap: 3, now })
    expect(denied).toMatchObject({ ok: false, count: 3, cap: 3 })
    // Denied call did NOT increment.
    const state = await store.readRateState('hobby')
    expect(state?.count).toBe(3)
  })

  it('opens a new window after 1 hour, resetting the count', async () => {
    const store = new CredentialRequestStore(home)
    const start = new Date('2026-05-15T12:00:00.000Z')
    await store.checkAndIncrementRate({ agent: 'hobby', cap: 3, now: start })
    await store.checkAndIncrementRate({ agent: 'hobby', cap: 3, now: start })
    const later = new Date(start.getTime() + 60 * 60 * 1000 + 1)
    const r = await store.checkAndIncrementRate({ agent: 'hobby', cap: 3, now: later })
    expect(r).toMatchObject({ ok: true, count: 1, cap: 3, window_start: later.toISOString() })
  })

  it('isolates per-Agent rate state', async () => {
    const store = new CredentialRequestStore(home)
    const now = new Date('2026-05-15T12:00:00.000Z')
    for (let i = 0; i < 3; i++) {
      await store.checkAndIncrementRate({ agent: 'hobby', cap: 3, now })
    }
    const simonOk = await store.checkAndIncrementRate({ agent: 'simon', cap: 3, now })
    expect(simonOk.ok).toBe(true)
  })

  it('returns null rate state for an Agent with no requests yet', async () => {
    const store = new CredentialRequestStore(home)
    expect(await store.readRateState('hobby')).toBeNull()
  })
})

describe('resolveRateCap', () => {
  it('returns the identity override when set', () => {
    expect(resolveRateCap({ identityOverride: 30, globalDefault: 15 })).toBe(30)
  })

  it('falls through to the global default when no override', () => {
    expect(resolveRateCap({ globalDefault: 25 })).toBe(25)
  })

  it('uses DEFAULT_RATE_PER_HOUR when nothing is configured', () => {
    expect(resolveRateCap({})).toBe(DEFAULT_RATE_PER_HOUR)
  })

  it('clamps to at least 1', () => {
    expect(resolveRateCap({ identityOverride: 0 })).toBe(1)
    expect(resolveRateCap({ globalDefault: -5 })).toBe(1)
  })

  it('ignores a null identity override', () => {
    expect(resolveRateCap({ identityOverride: null, globalDefault: 10 })).toBe(10)
  })
})

describe('waitForResolution', () => {
  it('returns immediately when the record is already terminal', async () => {
    const store = new CredentialRequestStore(home)
    const rec = pendingRecord()
    await store.create(rec)
    await store.transition(rec.id, 'fulfilled', { now: '2026-05-15T12:01:00.000Z' })
    const result = await waitForResolution(store, rec.id, { pollIntervalMs: 10 })
    expect(result.state).toBe('fulfilled')
  })

  it('polls until the record transitions', async () => {
    const store = new CredentialRequestStore(home)
    const rec = pendingRecord()
    await store.create(rec)
    const wait = waitForResolution(store, rec.id, { pollIntervalMs: 20 })
    // Flip after a short delay.
    setTimeout(() => {
      void store.transition(rec.id, 'declined', {
        now: '2026-05-15T12:01:00.000Z',
        decline_reason: 'no',
      })
    }, 60)
    const result = await wait
    expect(result.state).toBe('declined')
    expect(result.decline_reason).toBe('no')
  })

  it('honors timeoutMs without transitioning state on its own', async () => {
    const store = new CredentialRequestStore(home)
    const rec = pendingRecord()
    await store.create(rec)
    const result = await waitForResolution(store, rec.id, {
      pollIntervalMs: 10,
      timeoutMs: 50,
    })
    expect(result.state).toBe('pending')
  })

  it('throws when the abort signal fires', async () => {
    const store = new CredentialRequestStore(home)
    const rec = pendingRecord()
    await store.create(rec)
    const controller = new AbortController()
    const wait = waitForResolution(store, rec.id, {
      pollIntervalMs: 10,
      signal: controller.signal,
    })
    setTimeout(() => {
      controller.abort()
    }, 30)
    await expect(wait).rejects.toThrow(/aborted/)
  })
})

describe('envelope', () => {
  it('omits sensitive fields and includes the locked v1 shape', () => {
    const rec = pendingRecord()
    const env = toEnvelopeV1(rec)
    expect(env.envelope).toBe('credential_request_v1')
    expect(env.destination_credential_name).toBe(rec.credential_name)
    expect('value' in env).toBe(false)
    expect('agent' in env).toBe(false)
    expect('chat_id' in env).toBe(false)
    expect(env.state).toBe('pending')
  })
})
