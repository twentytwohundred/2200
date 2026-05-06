/**
 * 2200 web HTTP server.
 *
 * Hosted by the supervisor process on a configurable port (default 2200,
 * bound to 127.0.0.1). Exposes the v1 API contract documented at
 * wiki/conventions/runtime-api.md.
 *
 * Design notes:
 * - The server is a peer to the supervisor's UDS control-plane listener.
 *   Both run inside the supervisor process. The control plane is for the
 *   CLI; this server is for browsers and any future API client.
 * - Routes pull data via direct supervisor references (snapshot()) and
 *   filesystem reads (notifications). No internal RPC hop.
 * - Bearer-token auth on every route. Tokens live at
 *   <home>/state/web-tokens/<id>.json.
 * - Phase A: serves the built web app from apps/web/dist when present.
 *   "not yet built" is a clear 503-shaped response that tells the user
 *   to run pnpm build.
 */
import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import fastifyWebsocketImport from '@fastify/websocket'
import { z, ZodError } from 'zod'
import type { Supervisor } from '../supervisor/supervisor.js'
import type { Logger } from '../util/logger.js'
import { homePaths } from '../storage/layout.js'
import {
  listNotifications,
  markAnswered,
  markDismissed,
  readNotification,
  type NotificationRecord,
} from '../notifications/reader.js'
import { readPulse } from '../agent/pulse/reader.js'
import type { PulseState } from '../agent/pulse/types.js'
import {
  listBudgetHistory,
  readBudgetOverride,
  readBudgetStateToday,
  type BudgetState,
  type BudgetOverride,
} from '../agent/budget-reader.js'
import {
  ApiError,
  envelope,
  genericEnvelope,
  newRequestId,
  notFound,
  unauthorized,
} from './errors.js'
import { WebTokenStore } from './tokens.js'

/**
 * @fastify/websocket@11 ships a typed default export that is correct at
 * runtime but trips fastify@5's stricter type-provider generics. Cast the
 * plugin reference once, locally, instead of sprinkling ts-expect-error
 * around every use site. We exercise the runtime behavior in integration
 * tests; the cast does not weaken the typing of any user-facing code.
 */
const fastifyWebsocket = fastifyWebsocketImport as unknown as Parameters<
  FastifyInstance['register']
>[0]

export const VERSION = '0.0.0-phase-a'

export interface HttpServerOptions {
  supervisor: Supervisor
  home: string
  port?: number
  host?: string
  logger?: Logger
  /** Override resolution of the static frontend dir (testing). */
  staticDir?: string
}

export interface HttpServerHandle {
  readonly url: string
  readonly port: number
  readonly host: string
  readonly fastify: FastifyInstance
  stop: () => Promise<void>
  /**
   * Push an event to every connected WebSocket. Used by the supervisor's
   * event hooks (Epic 15 PR E). Phase A defines the wire format; the
   * push wiring is exercised by future PRs.
   */
  broadcast: (event: WsEvent) => void
}

export interface Principal {
  /** "user" today; "agent" reserved for cross-instance tokens at Epic 4 Phase B. */
  kind: 'user'
  /** Display name. Phase A returns the token's label. */
  name: string
  /** Token id used to authenticate. */
  token_id: string
}

export interface WsEvent {
  event: string
  payload: Record<string, unknown>
}

type AuthedRequest = FastifyRequest & { principal: Principal }

function resolveStaticDir(override?: string): string | null {
  // An override is only honored if it actually contains an index.html.
  // This makes the helper safe to call from tests (and from a fresh
  // checkout where apps/web/dist has not been built yet).
  if (override) {
    return existsSync(join(override, 'index.html')) ? override : null
  }
  // The compiled bundle lives at <repo>/dist/runtime/http/server.js. From
  // there, apps/web/dist is two levels up + apps/web/dist. We resolve it
  // both from the source path and the compiled path so dev (tsx) and prod
  // (built bundle) both find it.
  const here = dirname(fileURLToPath(import.meta.url))
  // src/runtime/http/server.ts -> ../../../apps/web/dist
  // dist/runtime/http/server.js -> ../../../apps/web/dist
  const candidate = resolvePath(here, '..', '..', '..', 'apps', 'web', 'dist')
  if (existsSync(join(candidate, 'index.html'))) return candidate
  return null
}

export async function startHttpServer(options: HttpServerOptions): Promise<HttpServerHandle> {
  const { supervisor, home } = options
  const port = options.port ?? 2200
  const host = options.host ?? '127.0.0.1'
  const log = options.logger

  const tokens = new WebTokenStore(homePaths(home).stateWebTokens)
  await tokens.ensure('default')

  const fastify = Fastify({
    logger: false,
    trustProxy: false,
    bodyLimit: 1024 * 1024, // 1 MB
  })

  fastify.decorateRequest('principal', null)
  fastify.decorateRequest('requestId', '')

  const wsClients = new Set<{ send: (data: string) => void }>()

  fastify.addHook('onRequest', async (req, reply) => {
    ;(req as unknown as { requestId: string }).requestId = newRequestId()
    reply.header('x-request-id', (req as unknown as { requestId: string }).requestId)
  })

  fastify.setErrorHandler((err, req, reply) => {
    const requestId = (req as { requestId?: string }).requestId ?? newRequestId()
    if (err instanceof ApiError) {
      log?.warn('api error', { code: err.code, status: err.status, request_id: requestId })
      void reply.status(err.status).send(envelope(err, requestId))
      return
    }
    if (err instanceof ZodError) {
      log?.warn('validation failed', { issues: err.issues, request_id: requestId })
      void reply
        .status(422)
        .send(genericEnvelope(422, 'validation_failed', 'Request validation failed', requestId))
      return
    }
    log?.error('unhandled error', {
      error: err instanceof Error ? err.message : String(err),
      request_id: requestId,
    })
    void reply
      .status(500)
      .send(genericEnvelope(500, 'internal_error', 'Internal server error', requestId))
  })

  await fastify.register(fastifyWebsocket)

  // ------------------------------------------------------------------------
  // Auth middleware. All /api/v1 routes (except the WS upgrade preflight)
  // require a bearer token that resolves to a token record on disk.
  // ------------------------------------------------------------------------
  async function authenticate(req: FastifyRequest): Promise<Principal> {
    // Browsers cannot set the Authorization header on a WebSocket upgrade.
    // Accept ?token=<value> in the URL as an equivalent for the WS route.
    let value: string | undefined
    const header = req.headers.authorization ?? ''
    const match = /^Bearer\s+([\S]+)$/.exec(header)
    if (match?.[1]) {
      value = match[1]
    } else {
      const url = new URL(req.url, 'http://placeholder')
      const fromQuery = url.searchParams.get('token')
      if (fromQuery) value = fromQuery
    }
    if (!value) throw unauthorized()
    const token = await tokens.findByValue(value)
    if (!token) throw unauthorized()
    return { kind: 'user', name: token.label, token_id: token.id }
  }

  fastify.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/v1/')) return
    if (req.url.startsWith('/api/v1/ws')) {
      // The WS upgrade is authenticated separately below. Pre-handler
      // does not see the upgraded socket.
      return
    }
    const principal = await authenticate(req)
    ;(req as AuthedRequest).principal = principal
  })

  // ------------------------------------------------------------------------
  // Routes
  // ------------------------------------------------------------------------
  fastify.get('/api/v1/me', (req: FastifyRequest) => {
    const p = (req as AuthedRequest).principal
    return {
      kind: p.kind,
      name: p.name,
      token_id: p.token_id,
    }
  })

  fastify.get('/api/v1/runtime/health', () => ({
    healthy: true,
    components: {
      supervisor: 'up',
    },
  }))

  fastify.get('/api/v1/runtime/version', () => ({
    api: 'v1',
    runtime: VERSION,
  }))

  fastify.get('/api/v1/schema', () => ({
    api: 'v1',
    runtime: VERSION,
    description:
      'JSON Schema bundle is sketched at v1; full self-describing surface lands as endpoints stabilize.',
    endpoints: [
      { method: 'GET', path: '/api/v1/me' },
      { method: 'GET', path: '/api/v1/runtime/health' },
      { method: 'GET', path: '/api/v1/runtime/version' },
      { method: 'GET', path: '/api/v1/agents' },
      { method: 'GET', path: '/api/v1/agents/:name' },
      { method: 'POST', path: '/api/v1/agents/:name/start' },
      { method: 'POST', path: '/api/v1/agents/:name/stop' },
      { method: 'GET', path: '/api/v1/agents/:name/budget' },
      { method: 'GET', path: '/api/v1/notifications' },
      { method: 'GET', path: '/api/v1/notifications/:id' },
      { method: 'POST', path: '/api/v1/notifications/:id/respond' },
      { method: 'POST', path: '/api/v1/notifications/:id/dismiss' },
      { method: 'WS', path: '/api/v1/ws' },
    ],
  }))

  // -- agents --------------------------------------------------------------
  fastify.get('/api/v1/agents', async () => {
    const snap = supervisor.snapshot()
    const items = await Promise.all(Object.values(snap.agents).map((rec) => toAgentDto(home, rec)))
    return { items, cursor: { next: null, limit: items.length } }
  })

  fastify.get<{ Params: { name: string } }>('/api/v1/agents/:name', async (req) => {
    const snap = supervisor.snapshot()
    const rec = snap.agents[req.params.name]
    if (!rec) throw notFound('agent', req.params.name)
    return await toAgentDto(home, rec)
  })

  fastify.post<{ Params: { name: string } }>('/api/v1/agents/:name/start', async (req) => {
    const snap = supervisor.snapshot()
    if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
    await supervisor.startAgent(req.params.name)
    const after = supervisor.snapshot().agents[req.params.name]
    if (!after) throw notFound('agent', req.params.name)
    return await toAgentDto(home, after)
  })

  const StopBodySchema = z
    .object({
      reason: z.string().min(1).optional(),
    })
    .optional()

  fastify.post<{ Params: { name: string }; Body: { reason?: string } | undefined }>(
    '/api/v1/agents/:name/stop',
    async (req) => {
      const snap = supervisor.snapshot()
      if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
      const parsed = StopBodySchema.parse(req.body)
      const reason = parsed?.reason ?? 'web_request'
      await supervisor.stopAgent(req.params.name, reason)
      const after = supervisor.snapshot().agents[req.params.name]
      if (!after) throw notFound('agent', req.params.name)
      return await toAgentDto(home, after)
    },
  )

  // -- agent budget --------------------------------------------------------
  // Reads the per-day budget state file the AgentProcess's BudgetTracker
  // writes to disk (Epic 4.5). Cross-process boundary: reading from disk
  // is the supported surface; the in-memory tracker is owned by the
  // AgentProcess and is not directly reachable from the supervisor.
  fastify.get<{ Params: { name: string } }>('/api/v1/agents/:name/budget', async (req) => {
    const snap = supervisor.snapshot()
    if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
    const today = await readBudgetStateToday(home, req.params.name)
    const override = await readBudgetOverride(home, req.params.name)
    const history = await listBudgetHistory(home, req.params.name)
    return {
      today: today ? toBudgetStateDto(today) : null,
      override: override ? toBudgetOverrideDto(override) : null,
      history: history.map(toBudgetStateDto),
    }
  })

  // -- notifications -------------------------------------------------------
  const NotificationStateValues = z.enum(['pending', 'answered', 'dismissed', 'expired'])
  const NotificationTierValues = z.enum(['passive', 'normal', 'important', 'critical'])

  const ListNotificationsQuery = z.object({
    state: NotificationStateValues.optional(),
    tier: NotificationTierValues.optional(),
    agent: z.string().optional(),
  })

  fastify.get('/api/v1/notifications', async (req) => {
    const q = ListNotificationsQuery.parse(req.query)
    const filters: Parameters<typeof listNotifications>[1] = {}
    if (q.state && q.state !== 'expired') filters.state = q.state
    if (q.tier) filters.tier = q.tier
    if (q.agent) filters.agent = q.agent
    const all = await listNotifications(home, filters)
    const items = all.map(toNotificationDto)
    return { items, cursor: { next: null, limit: items.length } }
  })

  fastify.get<{ Params: { id: string } }>('/api/v1/notifications/:id', async (req) => {
    try {
      const rec = await readNotification(home, req.params.id)
      return toNotificationDto(rec)
    } catch {
      throw notFound('notification', req.params.id)
    }
  })

  const RespondBodySchema = z.object({
    response: z.string().min(1),
  })

  function notificationErrorOrThrow(err: unknown, id: string): never {
    const message = err instanceof Error ? err.message : String(err)
    if (
      (err as NodeJS.ErrnoException).code === 'ENOENT' ||
      message.includes('no YAML frontmatter')
    ) {
      throw notFound('notification', id)
    }
    if (message.includes('not "pending"')) {
      throw new ApiError(409, 'notification_not_pending', message, { id })
    }
    throw err as Error
  }

  fastify.post<{ Params: { id: string }; Body: { response: string } }>(
    '/api/v1/notifications/:id/respond',
    async (req) => {
      const parsed = RespondBodySchema.parse(req.body)
      try {
        const updated = await markAnswered(home, req.params.id, parsed.response)
        broadcastNotificationEvent('notification.answered', updated)
        return toNotificationDto(updated)
      } catch (err) {
        notificationErrorOrThrow(err, req.params.id)
      }
    },
  )

  fastify.post<{ Params: { id: string } }>('/api/v1/notifications/:id/dismiss', async (req) => {
    try {
      const updated = await markDismissed(home, req.params.id)
      broadcastNotificationEvent('notification.dismissed', updated)
      return toNotificationDto(updated)
    } catch (err) {
      notificationErrorOrThrow(err, req.params.id)
    }
  })

  function broadcastNotificationEvent(event: string, rec: NotificationRecord): void {
    const msg = JSON.stringify({
      event,
      occurred_at: new Date().toISOString(),
      payload: {
        notification_id: rec.frontmatter.id,
        agent: rec.frontmatter.agent,
        tier: rec.frontmatter.tier,
        kind: rec.frontmatter.kind,
        state: rec.frontmatter.state,
      },
    })
    for (const c of wsClients) c.send(msg)
  }

  // -- websocket -----------------------------------------------------------
  // @fastify/websocket v11 wires upgraded sockets through the same route
  // handler shape but the TS surface is stricter; using `register` with an
  // inline plugin lets us cast the socket precisely without polluting the
  // public Fastify types.
  await fastify.register((instance, _opts, done) => {
    // `wsHandler` is added by @fastify/websocket via module augmentation.
    // The TS surface for fastify@5 + @fastify/websocket@11 doesn't pick up
    // the augmentation in this build; we cast the route options where we
    // attach the WS handler.
    const wsRoute = {
      method: 'GET',
      url: '/api/v1/ws',
      handler: () => {
        throw new ApiError(426, 'upgrade_required', 'Upgrade to WebSocket required at /api/v1/ws')
      },
      wsHandler: async (socket: WsSocket, req: FastifyRequest) => {
        let principal: Principal
        try {
          principal = await authenticate(req)
        } catch {
          socket.close(4401, 'unauthorized')
          return
        }
        const handle = {
          send: (data: string) => {
            try {
              socket.send(data)
            } catch {
              /* socket closed */
            }
          },
        }
        wsClients.add(handle)
        handle.send(
          JSON.stringify({
            event: 'hello',
            occurred_at: new Date().toISOString(),
            payload: { principal: { name: principal.name } },
          }),
        )
        const heartbeat = setInterval(() => {
          handle.send(
            JSON.stringify({
              event: 'heartbeat',
              occurred_at: new Date().toISOString(),
              payload: {},
            }),
          )
        }, 30_000)
        socket.on('close', () => {
          clearInterval(heartbeat)
          wsClients.delete(handle)
        })
      },
    }
    instance.route(wsRoute)
    done()
  })

  // ------------------------------------------------------------------------
  // Static frontend (inline; avoids @fastify/static's TS surface clash with
  // fastify@5's type-provider generics on this version pair).
  // ------------------------------------------------------------------------
  const staticDir = resolveStaticDir(options.staticDir)
  fastify.setNotFoundHandler(async (req, reply) => {
    const requestId = (req as { requestId?: string }).requestId ?? newRequestId()
    if (req.method === 'GET' && !req.url.startsWith('/api/') && staticDir) {
      const sent = await tryServeStatic(reply, staticDir, req.url)
      if (sent) return
    }
    return reply
      .status(404)
      .send(genericEnvelope(404, 'not_found', `No route for ${req.method} ${req.url}`, requestId))
  })

  if (!staticDir) {
    fastify.get('/', (_req, reply) =>
      reply
        .type('text/html')
        .send(
          '<!doctype html><html><body style="font:14px ui-monospace,monospace;padding:24px;background:#111;color:#eee">' +
            '<h1 style="margin:0 0 12px;font-size:18px">2200 web</h1>' +
            '<p>The web app has not been built yet. Run:</p>' +
            '<pre style="background:#222;padding:12px;border-radius:6px">pnpm --filter @twentytwohundred/web build</pre>' +
            '<p>The API is up at <code>/api/v1/runtime/health</code>.</p>' +
            '</body></html>',
        ),
    )
  }

  await fastify.listen({ port, host })
  const address = fastify.server.address()
  const boundPort = typeof address === 'object' && address ? address.port : port
  const url = `http://${host}:${String(boundPort)}`
  log?.info('http server up', { url, port: boundPort, host, staticDir })

  return {
    url,
    port: boundPort,
    host,
    fastify,
    stop: async () => {
      for (const c of wsClients) {
        try {
          c.send(
            JSON.stringify({
              event: 'goodbye',
              occurred_at: new Date().toISOString(),
              payload: {},
            }),
          )
        } catch {
          /* ignore */
        }
      }
      wsClients.clear()
      await fastify.close()
    },
    broadcast: (event) => {
      const msg = JSON.stringify({
        event: event.event,
        occurred_at: new Date().toISOString(),
        payload: event.payload,
      })
      for (const c of wsClients) c.send(msg)
    },
  }
}

// ---------------------------------------------------------------------------
// Static file helper.
// ---------------------------------------------------------------------------
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
}

async function tryServeStatic(reply: FastifyReply, root: string, url: string): Promise<boolean> {
  // Strip query string + decode. Resolve the path safely; reject anything
  // that escapes the static root (`..` traversal etc.).
  const decoded = decodeURIComponent(url.split('?')[0] ?? '/')
  const normalized = normalize(decoded).replace(/^\/+/, '')
  const candidate = resolvePath(root, normalized)
  if (!candidate.startsWith(resolvePath(root))) return false

  let target = candidate
  const exists = existsSync(target)
  const isDirectory = exists && statSync(target).isDirectory()
  if (!exists || isDirectory) {
    target = resolvePath(root, 'index.html')
    if (!existsSync(target)) return false
  }
  const ext = extname(target).toLowerCase()
  const type = MIME[ext] ?? 'application/octet-stream'
  const body = await readFile(target)
  await reply.type(type).send(body)
  return true
}

// ---------------------------------------------------------------------------
// WebSocket socket type (kept narrow; @fastify/websocket exports SocketStream
// but we only use these methods).
// ---------------------------------------------------------------------------
interface WsSocket {
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
  on: (event: 'close', cb: () => void) => void
}

// ---------------------------------------------------------------------------
// DTO mappers ... keep wire shape stable independent of internal records.
// ---------------------------------------------------------------------------
/**
 * The agent DTO carried over `/api/v1/agents` and friends. The
 * `pulse` field comes from `<home>/agents/<name>/pulse.json` (Pulse
 * v2 substrate). It is `null` when the Agent has never run on this
 * home (no pulse file yet) and when reading the pulse file errors;
 * pulse data is observability, not load-bearing for the screen.
 */
async function toAgentDto(
  home: string,
  rec: {
    name: string
    state: string
    pid: number | null
    current_task_id: string | null
    identity_path: string
    spawned_at: string | null
    last_heartbeat: string | null
    errored_at: string | null
    errored_reason: string | null
  },
) {
  let pulse: PulseDto | null = null
  try {
    const raw = await readPulse(home, rec.name)
    if (raw) pulse = pulseToDto(raw)
  } catch {
    // Tolerate: a malformed pulse.json should not 500 the agents
    // endpoint. The web app shows the agent as if pulse is unknown
    // and the operator can chase the parse error in the supervisor
    // log on their own time.
  }
  return {
    name: rec.name,
    status: rec.state,
    pid: rec.pid,
    current_task_id: rec.current_task_id,
    identity_path: rec.identity_path,
    spawned_at: rec.spawned_at,
    last_heartbeat: rec.last_heartbeat,
    errored_at: rec.errored_at,
    errored_reason: rec.errored_reason,
    pulse,
  }
}

interface PulseDto {
  state: string
  intensity: number
  detector_kind: string | null
  trip_id: string | null
  updated_at: string
}

function pulseToDto(p: PulseState): PulseDto {
  return {
    state: p.state,
    intensity: p.intensity,
    detector_kind: p.detector_kind,
    trip_id: p.trip_id,
    updated_at: p.updated_at,
  }
}

interface BudgetStateDto {
  day: string
  agent: string
  cumulative_usd: number
  cap_usd: number
  warn_at_pct: number
  warned_today: boolean
  blocked: boolean
  last_recorded_at: string | null
}

function toBudgetStateDto(s: BudgetState): BudgetStateDto {
  return {
    day: s.day,
    agent: s.agent,
    cumulative_usd: s.cumulative_usd,
    cap_usd: s.cap_usd,
    warn_at_pct: s.warn_at_pct,
    warned_today: s.warned_today,
    blocked: s.blocked,
    last_recorded_at: s.last_recorded_at,
  }
}

interface BudgetOverrideDto {
  until: string
  reason: string | null
}

function toBudgetOverrideDto(o: BudgetOverride): BudgetOverrideDto {
  return {
    until: o.until,
    reason: o.reason ?? null,
  }
}

function toNotificationDto(rec: NotificationRecord) {
  return {
    id: rec.frontmatter.id,
    ts: rec.frontmatter.ts,
    tier: rec.frontmatter.tier,
    agent: rec.frontmatter.agent,
    kind: rec.frontmatter.kind,
    state: rec.frontmatter.state,
    requires_response: rec.frontmatter.requires_response ?? false,
    response: rec.frontmatter.response ?? null,
    resolved_at: rec.frontmatter.resolved_at ?? null,
    body: rec.body,
  }
}

export { WebTokenStore } from './tokens.js'
export type { WebToken } from './tokens.js'
