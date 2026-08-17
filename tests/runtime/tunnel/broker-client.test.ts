/**
 * Tunnel broker client tests (Epic 19).
 *
 * The load-bearing assertion is the signature vector: the box's HMAC must match
 * the broker's `signInstallToken` byte-for-byte or every provision 401s. The
 * canonical string and the HMAC below are pinned constants ... Simon can run his
 * broker's `signInstallToken` with the SAME inputs (see the "SHARED VECTOR"
 * block) and confirm it produces the same HMAC. If this test and his reference
 * ever disagree, the canonicalization drifted and that's the bug.
 */
import { describe, expect, it } from 'vitest'
import {
  brokerCanonicalString,
  signBrokerRequest,
  provisionTunnel,
  revokeTunnel,
} from '../../../src/runtime/tunnel/broker-client.js'

// --- SHARED VECTOR (must match the broker's signInstallToken) ---------------
const SECRET = 'test-shared-secret'
const IDENTITY = 'scut://8453/0x1c1a1e0b7f8b3d5a4c2e9f0a6b8d7c5e4f3a2b1c/42'
const TIMESTAMP = '1719900000'
const BODY = JSON.stringify({ desired_name: 'alice', web_port: 2200, scut_uri: IDENTITY })
const EXPECTED_BODY_HASH = '13ce730e45cbb4d0a6eecd8f753d3c2b64825e800543b84974add51fea76ac25'
const EXPECTED_HMAC = 'ff384099afa09e05bd83f7e32414829a7028d44eed89818539edd8e4729eaf1b'
// ----------------------------------------------------------------------------

describe('broker request signing (byte-compat with the broker)', () => {
  it('produces the exact canonical string', () => {
    const canonical = brokerCanonicalString({
      method: 'POST',
      path: '/v1/tunnel/provision',
      timestamp: TIMESTAMP,
      identity: IDENTITY,
      body: BODY,
    })
    expect(canonical).toBe(
      `v1\nPOST\n/v1/tunnel/provision\n${TIMESTAMP}\n${IDENTITY}\n${EXPECTED_BODY_HASH}`,
    )
  })

  it('produces the pinned HMAC for the shared vector', () => {
    const sig = signBrokerRequest({
      secret: SECRET,
      method: 'POST',
      path: '/v1/tunnel/provision',
      timestamp: TIMESTAMP,
      identity: IDENTITY,
      body: BODY,
    })
    expect(sig).toBe(EXPECTED_HMAC)
  })

  it('uppercases the method in the canonical string', () => {
    const lower = brokerCanonicalString({
      method: 'post',
      path: '/v1/tunnel/provision',
      timestamp: TIMESTAMP,
      identity: IDENTITY,
      body: BODY,
    })
    expect(lower).toContain('\nPOST\n')
  })
})

function jsonResponse(status: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** A cleanly-typed `fetch` stub that records the last request it saw. */
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): {
  fetchImpl: typeof fetch
  last: () => { url: string; init: RequestInit }
} {
  let seen: { url: string; init: RequestInit } | null = null
  const toUrl = (input: Parameters<typeof fetch>[0]): string =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = toUrl(input)
    seen = { url, init: init ?? {} }
    return handler(url, init ?? {})
  }
  return {
    fetchImpl,
    last: () => {
      if (!seen) throw new Error('fetch was not called')
      return seen
    },
  }
}

describe('provisionTunnel', () => {
  const base = {
    brokerUrl: 'https://broker.example',
    secret: SECRET,
    scutUri: IDENTITY,
    nowSeconds: () => TIMESTAMP,
  }

  it('signs the request and returns hostname + token on 201', async () => {
    const { fetchImpl, last } = stubFetch(() =>
      jsonResponse(201, { hostname: 'alice.2200.ai', tunnel_token: 'tok_abc' }),
    )
    const res = await provisionTunnel(
      { ...base, fetchImpl },
      { desiredName: 'alice', webPort: 2200 },
    )
    expect(res).toEqual({ ok: true, hostname: 'alice.2200.ai', tunnelToken: 'tok_abc' })
    // The exact vector must have gone on the wire ... proves sign+send use the
    // same bytes the broker verifies.
    const { url, init } = last()
    expect(url).toBe('https://broker.example/v1/tunnel/provision')
    const headers = init.headers as Record<string, string>
    expect(headers['X-2200-Identity']).toBe(IDENTITY)
    expect(headers['X-2200-Timestamp']).toBe(TIMESTAMP)
    expect(headers['Authorization']).toBe(`Bearer ${EXPECTED_HMAC}`)
    expect(init.body).toBe(BODY)
  })

  it('maps 409 to name_taken with alternatives', async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse(409, { available_alternatives: ['alice-1', 'alice-2'] }),
    )
    const res = await provisionTunnel(
      { ...base, fetchImpl },
      { desiredName: 'alice', webPort: 2200 },
    )
    expect(res).toEqual({ ok: false, reason: 'name_taken', alternatives: ['alice-1', 'alice-2'] })
  })

  it('maps 429 to rate_limited with the scope', async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse(429, { scope: 'identity' }))
    const res = await provisionTunnel(
      { ...base, fetchImpl },
      { desiredName: 'alice', webPort: 2200 },
    )
    expect(res.ok).toBe(false)
    if (!res.ok && res.reason === 'rate_limited') expect(res.scope).toBe('identity')
    else throw new Error('expected rate_limited')
  })

  it('surfaces a network failure as unavailable, not a throw', async () => {
    const fetchImpl: typeof fetch = () => Promise.reject(new Error('connect ECONNREFUSED'))
    const res = await provisionTunnel(
      { ...base, fetchImpl },
      { desiredName: 'alice', webPort: 2200 },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('unavailable')
  })
})

describe('revokeTunnel', () => {
  it('returns ok on 204 and hits the revoke path', async () => {
    const { fetchImpl, last } = stubFetch(() => new Response(null, { status: 204 }))
    const res = await revokeTunnel(
      {
        brokerUrl: 'https://broker.example',
        secret: SECRET,
        scutUri: IDENTITY,
        nowSeconds: () => TIMESTAMP,
        fetchImpl,
      },
      { hostname: 'alice.2200.ai' },
    )
    expect(res).toEqual({ ok: true })
    expect(last().url).toBe('https://broker.example/v1/tunnel/revoke')
  })
})
