import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import WebSocket from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Supervisor } from '../../../src/runtime/supervisor/supervisor.js'
import { startHttpServer, type HttpServerHandle } from '../../../src/runtime/http/server.js'
import { WebTokenStore } from '../../../src/runtime/http/tokens.js'
import { homePaths } from '../../../src/runtime/storage/layout.js'
import type { Listener } from '../../../src/runtime/control-plane/transport.js'
import type { ValidateKeyResult } from '../../../src/runtime/llm/validate-key.js'

/**
 * In-process HTTP smoke tests. The supervisor's UDS listener is bypassed
 * (the test injects a no-op listener) so we can stand up a Supervisor
 * without the daemon harness.
 */

let home: string
let sup: Supervisor
let handle: HttpServerHandle
let token: string

class NullListener implements Listener {
  connections(): AsyncIterable<never> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<never> {
        return {
          next: () =>
            new Promise<IteratorResult<never>>(() => {
              /* never resolves */
            }),
        }
      },
    }
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-http-'))
  sup = await Supervisor.create({ home })
  await sup.start({ home, listener: new NullListener() })
  handle = await startHttpServer({
    supervisor: sup,
    home,
    port: 0,
    host: '127.0.0.1',
    staticDir: join(home, '__no_static_dir__'),
  })
  const tokens = new WebTokenStore(homePaths(home).stateWebTokens)
  const list = await tokens.list()
  token = list[0]!.value
})

afterEach(async () => {
  await handle.stop()
  await sup.shutdown()
  await rm(home, { recursive: true, force: true })
})

async function get(
  path: string,
  opts: { auth?: boolean } = { auth: true },
): Promise<{
  status: number
  body: unknown
  headers: Record<string, string>
}> {
  const headers: Record<string, string> = {}
  if (opts.auth !== false) headers['authorization'] = `Bearer ${token}`
  const res = await fetch(`${handle.url}${path}`, { headers })
  const headersOut: Record<string, string> = {}
  res.headers.forEach((v, k) => {
    headersOut[k] = v
  })
  const text = await res.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    /* keep as text */
  }
  return { status: res.status, body, headers: headersOut }
}

describe('HTTP server', () => {
  it('GET /api/v1/runtime/health returns 200 with a token', async () => {
    const r = await get('/api/v1/runtime/health')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ healthy: true })
  })

  it('POST /api/v1/system/restart restarts the fleet and returns a per-target summary', async () => {
    // Clean home ... nothing to restart, but the endpoint must exist, be
    // authed, and return the {pubs, agents} summary shape the UI renders.
    const res = await fetch(`${handle.url}/api/v1/system/restart`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { pubs: unknown[]; agents: unknown[] }
    expect(Array.isArray(body.pubs)).toBe(true)
    expect(Array.isArray(body.agents)).toBe(true)
    expect(body.agents).toEqual([])
  })

  it('POST /api/v1/system/restart without a bearer is 401', async () => {
    const res = await fetch(`${handle.url}/api/v1/system/restart`, { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('GET /api/v1/me without a bearer is 401 with the standard envelope', async () => {
    const r = await get('/api/v1/me', { auth: false })
    expect(r.status).toBe(401)
    expect(r.body).toMatchObject({
      error: { code: 'unauthorized', status: 401 },
    })
    expect((r.body as { error: { request_id: string } }).error.request_id).toMatch(/^req_/)
  })

  it('GET /api/v1/me with a bogus bearer is 401', async () => {
    const res = await fetch(`${handle.url}/api/v1/me`, {
      headers: { authorization: 'Bearer notarealtoken' },
    })
    expect(res.status).toBe(401)
  })

  it('GET /api/v1/me with the right bearer returns the principal', async () => {
    const r = await get('/api/v1/me')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ kind: 'user', name: 'default' })
  })

  it('GET /api/v1/agents returns an empty list on a fresh home', async () => {
    const r = await get('/api/v1/agents')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ items: [], cursor: { next: null } })
  })

  it('GET /api/v1/agents/missing returns 404 with the standard envelope', async () => {
    const r = await get('/api/v1/agents/missing')
    expect(r.status).toBe(404)
    expect(r.body).toMatchObject({
      error: { code: 'agent_not_found', status: 404, details: { agent: 'missing' } },
    })
  })

  it('GET /api/v1/agents/:name/budget returns 404 for an unknown agent', async () => {
    const r = await get('/api/v1/agents/missing/budget')
    expect(r.status).toBe(404)
    expect(r.body).toMatchObject({
      error: { code: 'agent_not_found' },
    })
  })

  it('GET /api/v1/agents/:name/brain returns 404 for an unknown agent', async () => {
    const r = await get('/api/v1/agents/missing/brain')
    expect(r.status).toBe(404)
    expect(r.body).toMatchObject({
      error: { code: 'agent_not_found' },
    })
  })

  it('GET /api/v1/agents/:name/brain/search returns 404 for an unknown agent', async () => {
    const r = await get('/api/v1/agents/missing/brain/search?q=anything')
    expect(r.status).toBe(404)
    expect(r.body).toMatchObject({
      error: { code: 'agent_not_found' },
    })
  })

  it('GET /api/v1/agents/:name/brain/note/:slug returns 404 for an unknown agent', async () => {
    const r = await get('/api/v1/agents/missing/brain/note/nope')
    expect(r.status).toBe(404)
    expect(r.body).toMatchObject({
      error: { code: 'agent_not_found' },
    })
  })

  it('GET /api/v1/agents/:name/schedules returns 404 for an unknown agent', async () => {
    const r = await get('/api/v1/agents/missing/schedules')
    expect(r.status).toBe(404)
    expect(r.body).toMatchObject({ error: { code: 'agent_not_found' } })
  })

  it('PATCH /api/v1/agents/:name/schedules/:id returns 404 for an unknown agent', async () => {
    const res = await fetch(`${handle.url}/api/v1/agents/missing/schedules/sch_unknown`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ enabled: false }),
    })
    expect(res.status).toBe(404)
  })

  it('DELETE /api/v1/agents/:name/schedules/:id returns 404 for an unknown agent', async () => {
    const res = await fetch(`${handle.url}/api/v1/agents/missing/schedules/sch_unknown`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(404)
  })

  it('GET /api/v1/agents/:name/tools returns 404 for an unknown agent', async () => {
    const r = await get('/api/v1/agents/missing/tools')
    expect(r.status).toBe(404)
    expect(r.body).toMatchObject({ error: { code: 'agent_not_found' } })
  })

  it('GET /api/v1/agents/:name/tasks returns 404 for an unknown agent', async () => {
    const r = await get('/api/v1/agents/missing/tasks')
    expect(r.status).toBe(404)
    expect(r.body).toMatchObject({ error: { code: 'agent_not_found' } })
  })

  it('GET /api/v1/agents/:name/tasks/:id returns 404 for an unknown agent', async () => {
    const r = await get('/api/v1/agents/missing/tasks/task_deadbeef')
    expect(r.status).toBe(404)
    expect(r.body).toMatchObject({ error: { code: 'agent_not_found' } })
  })

  it('GET /api/v1/agents/:name/credential-requests returns 404 for an unknown agent', async () => {
    const r = await get('/api/v1/agents/missing/credential-requests')
    expect(r.status).toBe(404)
    expect(r.body).toMatchObject({ error: { code: 'agent_not_found' } })
  })

  it('POST .../credential-requests/:id/fulfill is 404 for an unknown agent', async () => {
    const res = await fetch(
      `${handle.url}/api/v1/agents/missing/credential-requests/credreq_unknown/fulfill`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'x' }),
      },
    )
    expect(res.status).toBe(404)
  })

  it('POST .../credential-requests/:id/decline is 404 for an unknown agent', async () => {
    const res = await fetch(
      `${handle.url}/api/v1/agents/missing/credential-requests/credreq_unknown/decline`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
    )
    expect(res.status).toBe(404)
  })

  it('schema lists the credential-request endpoints', async () => {
    const r = await get('/api/v1/schema')
    const body = r.body as { endpoints: { method: string; path: string }[] }
    expect(body.endpoints).toContainEqual({
      method: 'GET',
      path: '/api/v1/agents/:name/credential-requests',
    })
    expect(body.endpoints).toContainEqual({
      method: 'POST',
      path: '/api/v1/agents/:name/credential-requests/:id/fulfill',
    })
    expect(body.endpoints).toContainEqual({
      method: 'POST',
      path: '/api/v1/agents/:name/credential-requests/:id/decline',
    })
  })

  it('GET /api/v1/notifications returns an empty list', async () => {
    const r = await get('/api/v1/notifications')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ items: [] })
  })

  it('GET /api/v1/runtime/version returns the api + runtime fields', async () => {
    const r = await get('/api/v1/runtime/version')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ api: 'v1' })
  })

  it('GET /api/v1/schema enumerates the v1 endpoints', async () => {
    const r = await get('/api/v1/schema')
    expect(r.status).toBe(200)
    const body = r.body as { endpoints: { method: string; path: string }[] }
    expect(body.endpoints.some((e) => e.path === '/api/v1/me')).toBe(true)
    expect(body.endpoints.some((e) => e.path === '/api/v1/agents')).toBe(true)
    expect(body.endpoints.some((e) => e.path === '/api/v1/agents/:name/budget')).toBe(true)
    expect(body.endpoints.some((e) => e.path === '/api/v1/ws')).toBe(true)
  })

  it('echoes a request id back in the x-request-id header', async () => {
    const r = await get('/api/v1/runtime/health')
    expect(r.headers['x-request-id']).toMatch(/^req_/)
  })

  it('returns the placeholder HTML on / when no static build is present', async () => {
    const res = await fetch(`${handle.url}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    const text = await res.text()
    expect(text).toMatch(/2200 web/)
  })

  it('GET /api/v1/me accepts ?token=<value> in the URL as an alternative to the Authorization header', async () => {
    // Browsers cannot set the Authorization header on EventSource or
    // WebSocket connections, so the URL fallback is load-bearing for
    // those surfaces. Tested explicitly for HTTP first since the same
    // authenticate() function gates both paths.
    const res = await fetch(`${handle.url}/api/v1/me?token=${encodeURIComponent(token)}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { kind: string; name: string }
    expect(body).toMatchObject({ kind: 'user', name: 'default' })
  })

  it('GET /api/v1/me with a bogus ?token= is 401', async () => {
    const res = await fetch(`${handle.url}/api/v1/me?token=bogus-not-a-real-token`)
    expect(res.status).toBe(401)
  })
})

describe('HTTP server WebSocket auth', () => {
  it('upgrades and receives hello when ?token=<value> matches a known token', async () => {
    const wsUrl = `${handle.url.replace(/^http/, 'ws')}/api/v1/ws?token=${encodeURIComponent(token)}`
    const ws = new WebSocket(wsUrl)
    const message = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => {
        reject(new Error('WS did not produce a message within 2000ms'))
      }, 2000)
      ws.once('message', (data) => {
        clearTimeout(t)
        // `data` is a Buffer (or Buffer[] in fragmented frames) on
        // node-ws; the assertion below operates on a UTF-8 string.
        const buf = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data)
        resolve(buf.toString('utf8'))
      })
      ws.once('error', (err) => {
        clearTimeout(t)
        reject(err)
      })
    })
    ws.close()
    const parsed = JSON.parse(message) as {
      event: string
      payload: { principal: { name: string } }
    }
    expect(parsed.event).toBe('hello')
    expect(parsed.payload.principal.name).toBe('default')
  })

  it('closes the WS with code 4401 when no token is supplied', async () => {
    const wsUrl = `${handle.url.replace(/^http/, 'ws')}/api/v1/ws`
    const ws = new WebSocket(wsUrl)
    const code = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => {
        reject(new Error('WS did not close within 2000ms'))
      }, 2000)
      ws.once('close', (closeCode) => {
        clearTimeout(t)
        resolve(closeCode)
      })
      ws.once('error', () => {
        // Some `ws` versions raise an error before the close event when
        // the server returns a non-101 status; either path is valid for
        // an unauthenticated upgrade. The follow-up close handler still
        // fires in that case.
      })
    })
    expect(code).toBe(4401)
  })

  it('closes the WS with code 4401 when ?token= is bogus', async () => {
    const wsUrl = `${handle.url.replace(/^http/, 'ws')}/api/v1/ws?token=bogus-not-a-real-token`
    const ws = new WebSocket(wsUrl)
    const code = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => {
        reject(new Error('WS did not close within 2000ms'))
      }, 2000)
      ws.once('close', (closeCode) => {
        clearTimeout(t)
        resolve(closeCode)
      })
      ws.once('error', () => {
        /* see comment in previous test */
      })
    })
    expect(code).toBe(4401)
  })
})

describe('HTTP server onboarding endpoints', () => {
  async function authedJson(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
    }
    if (body !== undefined) init.body = JSON.stringify(body)
    const res = await fetch(`${handle.url}${path}`, init)
    const text = await res.text()
    let parsed: unknown = text
    try {
      parsed = JSON.parse(text)
    } catch {
      // keep as text
    }
    return { status: res.status, body: parsed }
  }

  it('GET /api/v1/onboarding/missing returns 404 with the standard envelope', async () => {
    const r = await authedJson('GET', '/api/v1/onboarding/onb_does_not_exist')
    expect(r.status).toBe(404)
    expect(r.body).toMatchObject({ error: { code: 'onboarding_session_not_found' } })
  })

  it('POST /api/v1/onboarding/:id/answer returns 404 for an unknown session', async () => {
    const r = await authedJson('POST', '/api/v1/onboarding/onb_unknown/answer', {
      answer: 'whatever',
    })
    expect(r.status).toBe(404)
    expect(r.body).toMatchObject({ error: { code: 'onboarding_session_not_found' } })
  })

  it('DELETE /api/v1/onboarding/:id returns 404 for an unknown session', async () => {
    const r = await authedJson('DELETE', '/api/v1/onboarding/onb_unknown')
    expect(r.status).toBe(404)
  })

  it('POST /api/v1/onboarding without an LLM provider configured surfaces a useful error', async () => {
    // The default-pick walks the provider catalog. In CI with no keys
    // set, every cloud provider fails the key_set check; the `local`
    // provider passes (keyOptional=true) but has no entries in the
    // pricing table → 400 model_required. On a local dev shell with
    // ANTHROPIC_API_KEY (or any cloud key) set, default-pick succeeds
    // and onboarding starts → 200. All three are documented behaviors;
    // the assertion is "no 5xx surprise on the happy path of an
    // unconfigured op".
    const r = await authedJson('POST', '/api/v1/onboarding')
    expect([200, 400, 503]).toContain(r.status)
    if (r.status === 503) {
      const body = r.body as { error: { code: string } }
      expect(body.error.code).toMatch(/no_provider_configured|llm_provider_unavailable/)
    } else if (r.status === 400) {
      const body = r.body as { error: { code: string } }
      expect(body.error.code).toBe('model_required')
    }
  })
})

/**
 * Onboarding must fail fast with an actionable error when the operator picks
 * the `local` provider but the endpoint is unreachable ... otherwise the
 * error-swallowing interview silently produces a garbage half-Agent bound to a
 * dead provider (the exact first-user dead-end when Ollama isn't running). The
 * reachability probe is injected so the test asserts the wiring without a live
 * local server.
 */
describe('HTTP server onboarding ... local endpoint reachability gate', () => {
  let lHome: string
  let lSup: Supervisor
  let lHandle: HttpServerHandle
  let lToken: string
  let probeResult: ValidateKeyResult

  async function post(body: unknown): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${lHandle.url}/api/v1/onboarding`, {
      method: 'POST',
      headers: { authorization: `Bearer ${lToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    let parsed: unknown = text
    try {
      parsed = JSON.parse(text)
    } catch {
      // keep as text
    }
    return { status: res.status, body: parsed }
  }

  beforeEach(async () => {
    lHome = await mkdtemp(join(tmpdir(), '2200-http-local-'))
    lSup = await Supervisor.create({ home: lHome })
    await lSup.start({ home: lHome, listener: new NullListener() })
    lHandle = await startHttpServer({
      supervisor: lSup,
      home: lHome,
      port: 0,
      host: '127.0.0.1',
      staticDir: join(lHome, '__no_static_dir__'),
      // eslint-disable-next-line @typescript-eslint/require-await
      probeLocalEndpoint: async () => probeResult,
    })
    const tokens = new WebTokenStore(homePaths(lHome).stateWebTokens)
    const list = await tokens.list()
    lToken = list[0]!.value
  })

  afterEach(async () => {
    await lHandle.stop()
    await lSup.shutdown()
    await rm(lHome, { recursive: true, force: true })
  })

  it('rejects onboarding with 503 + actionable detail when the local endpoint is down', async () => {
    probeResult = {
      ok: false,
      reason: 'network_error',
      message: 'connect ECONNREFUSED 127.0.0.1:11434',
    }
    const r = await post({ provider: 'local', model: 'llama3' })
    expect(r.status).toBe(503)
    const body = r.body as { error: { code: string; message: string } }
    expect(body.error.code).toBe('llm_provider_unreachable')
    // The operator must see WHERE and WHAT to fix, not a silent fallback.
    expect(body.error.message).toContain('11434')
    expect(body.error.message.toLowerCase()).toContain('running')
  })

  it('starts onboarding when the local endpoint probe succeeds', async () => {
    probeResult = { ok: true }
    const r = await post({ provider: 'local', model: 'llama3' })
    expect(r.status).toBe(200)
    const body = r.body as { session_id: string; state: string }
    expect(body.session_id).toMatch(/^onb_/)
  })
})

/**
 * `/api/v1/connector/*` routes need a connector-configured supervisor;
 * the main HTTP-server describe block above does not configure the
 * connector (most tests don't want the extra port). This block stands
 * up its own connector-enabled supervisor so the operator-facing
 * routes can be exercised end-to-end.
 */
describe('HTTP server / connector routes', () => {
  let cHome: string
  let cSup: Supervisor
  let cHandle: HttpServerHandle
  let cToken: string

  beforeEach(async () => {
    cHome = await mkdtemp(join(tmpdir(), '2200-http-connector-'))
    cSup = await Supervisor.create({ home: cHome, connector: { port: 0 } })
    await cSup.start({
      home: cHome,
      connector: { port: 0 },
      listener: new NullListener(),
    })
    cHandle = await startHttpServer({
      supervisor: cSup,
      home: cHome,
      port: 0,
      host: '127.0.0.1',
      staticDir: join(cHome, '__no_static_dir__'),
    })
    const tokens = new WebTokenStore(homePaths(cHome).stateWebTokens)
    const list = await tokens.list()
    cToken = list[0]!.value
  })

  afterEach(async () => {
    await cHandle.stop().catch(() => undefined)
    await cSup.shutdown().catch(() => undefined)
    await rm(cHome, { recursive: true, force: true })
  })

  async function callJson(
    method: 'GET' | 'POST',
    path: string,
  ): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${cHandle.url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cToken}`,
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: '{}' } : {}),
    })
    let body: unknown = await res.text()
    try {
      body = JSON.parse(body as string)
    } catch {
      // keep as text
    }
    return { status: res.status, body }
  }

  it('GET /api/v1/connector/status returns configured=true with no bearer on a fresh home', async () => {
    const r = await callJson('GET', '/api/v1/connector/status')
    expect(r.status).toBe(200)
    const body = r.body as {
      configured: boolean
      listening: boolean
      bearer_present: boolean
    }
    expect(body.configured).toBe(true)
    expect(body.bearer_present).toBe(false)
    expect(body.listening).toBe(false)
  })

  it('GET /api/v1/connector/token returns null when no bearer is provisioned', async () => {
    const r = await callJson('GET', '/api/v1/connector/token')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ token: null })
  })

  it('POST /api/v1/connector/regenerate mints a token + status reflects bearer_present', async () => {
    const r = await callJson('POST', '/api/v1/connector/regenerate')
    expect(r.status).toBe(200)
    const body = r.body as { token: string }
    expect(body.token).toMatch(/^2200-mcp-[A-Za-z0-9_-]{16,}$/)

    const status = (await callJson('GET', '/api/v1/connector/status')).body as {
      bearer_present: boolean
      listening: boolean
    }
    expect(status.bearer_present).toBe(true)
    expect(status.listening).toBe(true)

    const tokenAgain = (await callJson('GET', '/api/v1/connector/token')).body as {
      token: string | null
    }
    expect(tokenAgain.token).toBe(body.token)
  })

  it('POST /api/v1/connector/disable wipes the bearer + stops the listener', async () => {
    await callJson('POST', '/api/v1/connector/regenerate')
    const r = await callJson('POST', '/api/v1/connector/disable')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ disabled: true })

    const status = (await callJson('GET', '/api/v1/connector/status')).body as {
      bearer_present: boolean
      listening: boolean
    }
    expect(status.bearer_present).toBe(false)
    expect(status.listening).toBe(false)
  })

  it('regenerate after disable mints a fresh token with regenerated_at unset (created_at is the only marker)', async () => {
    await callJson('POST', '/api/v1/connector/regenerate')
    await callJson('POST', '/api/v1/connector/disable')
    const r = await callJson('POST', '/api/v1/connector/regenerate')
    expect(r.status).toBe(200)
    const status = (await callJson('GET', '/api/v1/connector/status')).body as {
      bearer_present: boolean
      bearer_created_at: string | null
      bearer_regenerated_at: string | null
    }
    expect(status.bearer_present).toBe(true)
    expect(status.bearer_created_at).not.toBeNull()
    // After disable + regenerate, the prior token was deleted, so the
    // new token's metadata has no regenerated_at marker.
    expect(status.bearer_regenerated_at).toBeNull()
  })

  it('GET /api/v1/connector/work-packages returns an empty list on a fresh home', async () => {
    const r = await callJson('GET', '/api/v1/connector/work-packages')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ items: [] })
  })

  it('GET /api/v1/connector/work-packages filters by status', async () => {
    const { writeProposedPackage, patchPackageFrontmatter, newWorkPackageId } =
      await import('../../../src/runtime/mcp/connector/work-package.js')
    const proposedId = newWorkPackageId()
    const reviewableId = newWorkPackageId()
    await writeProposedPackage({
      home: cHome,
      packageId: proposedId,
      primaryAgent: 'a',
      proposal: {
        title: 'p',
        summary: 's',
        proposed_steps: ['x'],
        target: { kind: 'agent', agent_name: 'a' },
      },
    })
    await writeProposedPackage({
      home: cHome,
      packageId: reviewableId,
      primaryAgent: 'a',
      proposal: {
        title: 'r',
        summary: 's',
        proposed_steps: ['x'],
        target: { kind: 'agent', agent_name: 'a' },
      },
    })
    await patchPackageFrontmatter({
      home: cHome,
      packageId: reviewableId,
      updates: { package_status: 'reviewable' },
    })
    const allResp = (await callJson('GET', '/api/v1/connector/work-packages')).body as {
      items: { packageId: string; status: string }[]
    }
    expect(allResp.items).toHaveLength(2)
    const reviewableResp = (
      await callJson('GET', '/api/v1/connector/work-packages?status=reviewable')
    ).body as { items: { packageId: string; status: string }[] }
    expect(reviewableResp.items).toHaveLength(1)
    expect(reviewableResp.items[0]?.packageId).toBe(reviewableId)
  })

  it('regenerate starts the listener when it was previously idle (no bearer at supervisor start)', async () => {
    // Fresh home → supervisor started with connector configured but no
    // bearer provisioned. status reports listening:false, bearer_present:false.
    // Regenerate must transition the listener to live in one step (the
    // "idle → regenerate" Settings-tile UI state).
    const beforeStatus = (await callJson('GET', '/api/v1/connector/status')).body as {
      listening: boolean
      bearer_present: boolean
    }
    expect(beforeStatus.listening).toBe(false)
    expect(beforeStatus.bearer_present).toBe(false)

    const regen = await callJson('POST', '/api/v1/connector/regenerate')
    expect(regen.status).toBe(200)
    const afterStatus = (await callJson('GET', '/api/v1/connector/status')).body as {
      listening: boolean
      bearer_present: boolean
      port: number | null
    }
    expect(afterStatus.listening).toBe(true)
    expect(afterStatus.bearer_present).toBe(true)
    expect(afterStatus.port).not.toBeNull()
  })
})

describe('isLoopbackHost', () => {
  it('recognizes the canonical loopback forms', async () => {
    const { isLoopbackHost } = await import('../../../src/runtime/supervisor/supervisor.js')
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('LocalHost')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('0:0:0:0:0:0:0:1')).toBe(true)
  })

  it('rejects public bind targets', async () => {
    const { isLoopbackHost } = await import('../../../src/runtime/supervisor/supervisor.js')
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
    expect(isLoopbackHost('192.168.1.42')).toBe(false)
    expect(isLoopbackHost('::')).toBe(false)
  })
})
