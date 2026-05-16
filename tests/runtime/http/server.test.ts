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
