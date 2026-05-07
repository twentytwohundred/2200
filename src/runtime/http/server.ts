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
import {
  agentBrainIndexPath,
  agentPaths as agentPathsHelper,
  homePaths,
} from '../storage/layout.js'

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
import { BrainStore } from '../brain/store.js'
import { BrainIndex, BrainIndexNotFoundError } from '../brain/index-db.js'
import type { BrainNote } from '../brain/types.js'
import type { McpServerSpec } from '../identity/types.js'
import {
  ScheduleError,
  ScheduleTimingSchema,
  createSchedule,
  deleteSchedule,
  listSchedules,
  readSchedule,
  setScheduleEnabled,
  type ScheduleEntry,
} from '../scheduler/schedule.js'
import { loadIdentity } from '../identity/loader.js'
import { aggregateToolHealth } from '../tools/health.js'
import { TaskStore } from '../agent/task/store.js'
import { newPendingTask, type TaskRecord, type TaskState } from '../agent/task/types.js'
import { newTaskId } from '../util/id.js'
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
      { method: 'GET', path: '/api/v1/agents/:name/brain' },
      { method: 'GET', path: '/api/v1/agents/:name/brain/search' },
      { method: 'GET', path: '/api/v1/agents/:name/brain/note/:slug' },
      { method: 'GET', path: '/api/v1/agents/:name/schedules' },
      { method: 'POST', path: '/api/v1/agents/:name/schedules' },
      { method: 'PATCH', path: '/api/v1/agents/:name/schedules/:id' },
      { method: 'DELETE', path: '/api/v1/agents/:name/schedules/:id' },
      { method: 'GET', path: '/api/v1/agents/:name/tools' },
      { method: 'GET', path: '/api/v1/agents/:name/tasks' },
      { method: 'POST', path: '/api/v1/agents/:name/tasks' },
      { method: 'POST', path: '/api/v1/agents/:name/brain' },
      { method: 'GET', path: '/api/v1/notifications' },
      { method: 'GET', path: '/api/v1/notifications/:id' },
      { method: 'POST', path: '/api/v1/notifications/:id/respond' },
      { method: 'POST', path: '/api/v1/notifications/:id/dismiss' },
      { method: 'POST', path: '/api/v1/onboarding' },
      { method: 'GET', path: '/api/v1/onboarding/:id' },
      { method: 'POST', path: '/api/v1/onboarding/:id/answer' },
      { method: 'POST', path: '/api/v1/onboarding/:id/confirm' },
      { method: 'DELETE', path: '/api/v1/onboarding/:id' },
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

  // -- agent brain (Epic 15 Phase C) --------------------------------------
  // Read-only HTTP surface over the per-Agent brain. Reads cross the
  // Agent's own filesystem only ... we open a fresh BrainStore +
  // BrainIndex on each call rather than touching the AgentProcess's
  // warm registry, so the supervisor stays decoupled from the
  // child-process state. The principal is the user; permission checks
  // (cross-Agent brain reads) live at the brain.* MCP tool layer and
  // are not enforced here ... the user owns the instance.
  const ListBrainQuery = z.object({
    type: z.string().optional(),
    tag: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })

  fastify.get<{ Params: { name: string } }>('/api/v1/agents/:name/brain', async (req) => {
    const snap = supervisor.snapshot()
    if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
    const q = ListBrainQuery.parse(req.query)
    const store = BrainStore.forAgent(home, req.params.name)
    const filters: { type?: string; tag?: string; limit?: number } = {}
    if (q.type !== undefined) filters.type = q.type
    if (q.tag !== undefined) filters.tag = q.tag
    if (q.limit !== undefined) filters.limit = q.limit
    const notes = await store.list(filters)
    return {
      items: notes.map(toBrainNoteListDto),
      cursor: { next: null, limit: notes.length },
    }
  })

  const SearchBrainQuery = z.object({
    q: z.string().min(1),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })

  fastify.get<{ Params: { name: string } }>('/api/v1/agents/:name/brain/search', async (req) => {
    const snap = supervisor.snapshot()
    if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
    const parsed = SearchBrainQuery.parse(req.query)
    let index: BrainIndex
    try {
      index = BrainIndex.openReadOnlyAtPath(agentBrainIndexPath(home, req.params.name))
    } catch (err) {
      // Index missing: fall back to a one-shot in-memory list scan
      // so the search box still works on a freshly-installed Agent
      // whose AgentProcess has never run. This keeps the UI from
      // surfacing a confusing 404 for an Agent that has notes on
      // disk but no warm SQLite index yet.
      if (err instanceof BrainIndexNotFoundError) {
        const store = BrainStore.forAgent(home, req.params.name)
        const all = await store.list({ limit: 1000 })
        const matches = all
          .filter((n) =>
            [n.frontmatter.title, n.frontmatter.tags.join(' '), n.body]
              .join('\n')
              .toLowerCase()
              .includes(parsed.q.toLowerCase()),
          )
          .slice(0, parsed.limit ?? 25)
        return {
          items: matches.map((n) => ({
            slug: n.slug,
            title: n.frontmatter.title,
            type: n.frontmatter.type,
            tags: n.frontmatter.tags,
            snippet: n.body.slice(0, 200),
            score: 0,
          })),
          cursor: { next: null, limit: matches.length },
          mode: 'fallback' as const,
        }
      }
      throw err
    }
    const opts: { limit?: number } = {}
    if (parsed.limit !== undefined) opts.limit = parsed.limit
    const hits = index.search(parsed.q, opts)
    index.close()
    return {
      items: hits,
      cursor: { next: null, limit: hits.length },
      mode: 'fts' as const,
    }
  })

  fastify.get<{ Params: { name: string; slug: string } }>(
    '/api/v1/agents/:name/brain/note/:slug',
    async (req) => {
      const snap = supervisor.snapshot()
      if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
      const store = BrainStore.forAgent(home, req.params.name)
      const note = await store.tryRead(req.params.slug)
      if (!note) {
        throw new ApiError(
          404,
          'brain_note_not_found',
          `No note with slug "${req.params.slug}" in agent "${req.params.name}".`,
        )
      }
      return toBrainNoteDto(note)
    },
  )

  // -- agent schedules (Epic 15 Phase C) -----------------------------------
  // CRUD over the per-Agent schedule store. After every mutation we
  // ask the live Scheduler service to reload so newly-written or
  // disabled schedules pick up immediately without a daemon bounce.
  // This mirrors the cli.scheduler.reload RPC the CLI uses.
  const CreateScheduleBody = z.object({
    description: z.string().optional(),
    prompt: z.string().min(1),
    timing: ScheduleTimingSchema,
    enabled: z.boolean().optional(),
  })

  const PatchScheduleBody = z.object({
    enabled: z.boolean(),
  })

  fastify.get<{ Params: { name: string } }>('/api/v1/agents/:name/schedules', async (req) => {
    const snap = supervisor.snapshot()
    if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
    const items = await listSchedules(home, req.params.name)
    return {
      items: items.map(toScheduleDto),
      cursor: { next: null, limit: items.length },
    }
  })

  fastify.post<{ Params: { name: string } }>(
    '/api/v1/agents/:name/schedules',
    async (req, reply) => {
      const snap = supervisor.snapshot()
      if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
      const body = CreateScheduleBody.parse(req.body)
      let entry: ScheduleEntry
      try {
        const args: Parameters<typeof createSchedule>[0] = {
          home,
          agentName: req.params.name,
          prompt: body.prompt,
          timing: body.timing,
        }
        if (body.description !== undefined) args.description = body.description
        if (body.enabled !== undefined) args.enabled = body.enabled
        entry = await createSchedule(args)
      } catch (err) {
        if (err instanceof ScheduleError) {
          throw new ApiError(422, 'schedule_invalid', err.message)
        }
        throw err
      }
      await supervisor.getScheduler().reload()
      void reply.status(201)
      return toScheduleDto(entry)
    },
  )

  fastify.patch<{
    Params: { name: string; id: string }
    Body: { enabled: boolean }
  }>('/api/v1/agents/:name/schedules/:id', async (req) => {
    const snap = supervisor.snapshot()
    if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
    const body = PatchScheduleBody.parse(req.body)
    try {
      await readSchedule(home, req.params.name, req.params.id)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ApiError(
          404,
          'schedule_not_found',
          `No schedule "${req.params.id}" for agent "${req.params.name}".`,
        )
      }
      throw err
    }
    const updated = await setScheduleEnabled(home, req.params.name, req.params.id, body.enabled)
    await supervisor.getScheduler().reload()
    return toScheduleDto(updated)
  })

  fastify.delete<{ Params: { name: string; id: string } }>(
    '/api/v1/agents/:name/schedules/:id',
    async (req) => {
      const snap = supervisor.snapshot()
      if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
      try {
        await readSchedule(home, req.params.name, req.params.id)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new ApiError(
            404,
            'schedule_not_found',
            `No schedule "${req.params.id}" for agent "${req.params.name}".`,
          )
        }
        throw err
      }
      await deleteSchedule(home, req.params.name, req.params.id)
      await supervisor.getScheduler().reload()
      return { id: req.params.id, deleted: true as const }
    },
  )

  // -- agent tools (Epic 15 Phase C) ---------------------------------------
  // Surfaces the agent's MCP-server roster (from the Identity file) +
  // a tool-health summary aggregated off the dispatcher's run records.
  // Read-only; OAuth credential management still happens via the CLI.
  fastify.get<{ Params: { name: string } }>('/api/v1/agents/:name/tools', async (req) => {
    const snap = supervisor.snapshot()
    const rec = snap.agents[req.params.name]
    if (!rec) throw notFound('agent', req.params.name)

    let identityServers: ReturnType<typeof toMcpServerDto>[] = []
    try {
      const identity = await loadIdentity(rec.identity_path)
      identityServers = identity.frontmatter.mcp_servers.map(toMcpServerDto)
    } catch {
      // Tolerate: a malformed Identity should not 500 the screen.
    }

    let healthSummary: Awaited<ReturnType<typeof aggregateToolHealth>> | null = null
    try {
      healthSummary = await aggregateToolHealth(
        agentPathsHelper(home, req.params.name).brain,
        req.params.name,
      )
    } catch {
      // Tolerate: missing brain dir means no calls yet.
    }

    return {
      agent: req.params.name,
      mcp_servers: identityServers,
      health: healthSummary,
    }
  })

  // -- agent tasks list (Epic 15 Phase C) ----------------------------------
  // Read-only task observability for the AgentDetail screen. Backed by
  // TaskStore.list which sorts most-recent-first; we apply optional
  // state + limit filters here.
  const TaskStateEnum = z.enum([
    'pending',
    'running',
    'blocked_on_user',
    'blocked_on_agent',
    'blocked_on_detector',
    'done',
    'errored',
  ])
  const ListTasksQuery = z.object({
    state: TaskStateEnum.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })

  fastify.get<{ Params: { name: string } }>('/api/v1/agents/:name/tasks', async (req) => {
    const snap = supervisor.snapshot()
    if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
    const q = ListTasksQuery.parse(req.query)
    const store = new TaskStore(home, req.params.name)
    const all = await store.list()
    const filtered = q.state ? all.filter((t) => t.frontmatter.state === q.state) : all
    const limit = q.limit ?? 50
    const items = filtered.slice(0, limit).map(toTaskListDto)
    return {
      items,
      cursor: { next: null, limit: items.length },
    }
  })

  // -- agent tasks (Epic 15 Phase C interaction surface) -------------------
  // Lets a user enqueue a synthetic prompt-task for an Agent without
  // dropping into the CLI. The task lands as a pending TaskRecord on
  // disk; the running AgentLoop's task pipe picks it up next tick.
  const CreateTaskBody = z.object({
    title: z.string().min(1).max(200).optional(),
    body: z.string().min(1),
    priority: z.number().int().min(0).max(100).optional(),
  })

  fastify.post<{ Params: { name: string } }>('/api/v1/agents/:name/tasks', async (req, reply) => {
    const snap = supervisor.snapshot()
    if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
    const body = CreateTaskBody.parse(req.body)
    const store = new TaskStore(home, req.params.name)
    const id = newTaskId()
    const titleArg =
      body.title && body.title.length > 0
        ? body.title
        : body.body.slice(0, 60).replace(/\s+/g, ' ').trim() || 'task from web'
    const task = newPendingTask({
      id,
      agent: req.params.name,
      title: titleArg,
      body: body.body,
      priority: body.priority ?? 0,
    })
    await store.save(task)
    void reply.status(201)
    return {
      id,
      agent: req.params.name,
      state: task.frontmatter.state,
      title: task.frontmatter.title,
      created: task.frontmatter.created,
    }
  })

  // -- agent brain write (Epic 15 Phase C interaction surface) ------------
  // POST a note to an Agent's brain from the web. Supports a fixed
  // slug (upsert) or auto-derives one from the title with collision
  // suffix. Returns the resulting BrainNote DTO.
  const CreateBrainNoteBody = z.object({
    title: z.string().min(1).max(200),
    body: z.string().min(1),
    slug: z.string().min(1).max(120).optional(),
    type: z.string().min(1).max(40).optional(),
    tags: z.array(z.string().min(1).max(40)).optional(),
  })

  fastify.post<{ Params: { name: string } }>('/api/v1/agents/:name/brain', async (req, reply) => {
    const snap = supervisor.snapshot()
    if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
    const body = CreateBrainNoteBody.parse(req.body)
    const store = BrainStore.forAgent(home, req.params.name)
    const writeArgs: Parameters<typeof store.write>[0] = {
      title: body.title,
      body: body.body,
    }
    if (body.slug !== undefined) writeArgs.slug = body.slug
    if (body.type !== undefined) writeArgs.type = body.type
    if (body.tags !== undefined) writeArgs.tags = body.tags
    const result = await store.write(writeArgs)
    const note = await store.read(result.slug)
    void reply.status(result.created ? 201 : 200)
    return toBrainNoteDto(note)
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

  // -- onboarding (Epic 14 + Epic 15 Phase B Card Stack) --------------------
  // Server-side state machine for the conversational onboarding flow.
  // The web app calls these endpoints to drive a question/answer
  // conversation, see a preview, and confirm to spawn an Agent.
  // Sessions are in-memory only on the supervisor; a daemon restart
  // drops every in-flight interview, mirroring the CLI's flow.
  const sessions = supervisor.getOnboardingSessions()

  const StartOnboardingBodySchema = z
    .object({
      provider: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
      script: z.string().min(1).optional(),
    })
    .optional()

  fastify.post('/api/v1/onboarding', async (req) => {
    const body = StartOnboardingBodySchema.parse(req.body) ?? {}
    const providerName = body.provider ?? 'anthropic'
    const modelId = body.model ?? 'claude-opus-4-7'

    const { loadScriptFile } = await import('../onboarding/script-loader.js')
    const { resolveProvider } = await import('../llm/registry.js')
    const { OnboardingSession } = await import('../onboarding/session.js')
    const { newRequestId: newId } = await import('./errors.js')

    const cliDir = dirname(fileURLToPath(import.meta.url))
    const defaultScriptPath = join(cliDir, '..', 'onboarding', 'scripts', 'default-v1.yaml')
    const scriptPath = body.script ?? defaultScriptPath
    const script = await loadScriptFile(scriptPath)
    let provider
    try {
      provider = await resolveProvider({ providerName })
    } catch (err) {
      throw new ApiError(
        503,
        'llm_provider_unavailable',
        `Could not resolve LLM provider "${providerName}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
    const id = `onb_${newId().replace(/^req_/, '')}`
    const session = new OnboardingSession({ id, script, provider, modelId })
    sessions.register(session)
    return {
      session_id: id,
      state: session.getState(),
      question: session.currentQuestion(),
    }
  })

  fastify.get<{ Params: { id: string } }>('/api/v1/onboarding/:id', (req) => {
    const session = sessions.touch(req.params.id)
    if (!session) {
      throw new ApiError(
        404,
        'onboarding_session_not_found',
        `No onboarding session "${req.params.id}". Sessions expire after 30 minutes of inactivity.`,
      )
    }
    return {
      session_id: session.id,
      state: session.getState(),
      question: session.currentQuestion(),
      preview: session.getPreview(),
    }
  })

  const AnswerBodySchema = z.object({
    answer: z.string(),
  })

  fastify.post<{ Params: { id: string }; Body: { answer: string } }>(
    '/api/v1/onboarding/:id/answer',
    async (req) => {
      const session = sessions.touch(req.params.id)
      if (!session) {
        throw new ApiError(
          404,
          'onboarding_session_not_found',
          `No onboarding session "${req.params.id}".`,
        )
      }
      const body = AnswerBodySchema.parse(req.body)
      const result = await session.submitAnswer(body.answer)
      return {
        session_id: session.id,
        state: session.getState(),
        ...(result.kind === 'next'
          ? { question: result.question, preview: null }
          : { question: null, preview: result.preview }),
      }
    },
  )

  fastify.post<{ Params: { id: string } }>('/api/v1/onboarding/:id/confirm', async (req) => {
    const session = sessions.touch(req.params.id)
    if (!session) {
      throw new ApiError(
        404,
        'onboarding_session_not_found',
        `No onboarding session "${req.params.id}".`,
      )
    }
    const preview = session.getPreview()
    if (!preview) {
      throw new ApiError(
        409,
        'onboarding_not_ready',
        `Session "${req.params.id}" is in state "${session.getState()}"; finish the interview before confirming.`,
      )
    }
    const { migrateFromHandoff } = await import('../migration/orchestrator.js')
    const { saveTranscript } = await import('../onboarding/transcript-store.js')
    const result = await migrateFromHandoff({
      handoff: preview.handoff,
      home,
      supervisor,
      today: new Date(),
    })
    let transcriptPath: string | null = null
    try {
      transcriptPath = await saveTranscript({
        home,
        agentName: result.agent_name,
        transcript: preview.transcript,
      })
    } catch {
      // Persistence failure is non-fatal ... the Agent is on disk.
    }
    session.markConfirmed()
    sessions.delete(session.id)
    return {
      session_id: session.id,
      agent_name: result.agent_name,
      identity_path: result.identity_path,
      continuity_note_slug: result.continuity_note_slug,
      transcript_path: transcriptPath,
      tools: preview.tools.map((t) => ({
        server: t.server.name,
        env_hint: t.env_hint,
      })),
      schedules: preview.schedules,
    }
  })

  fastify.delete<{ Params: { id: string } }>('/api/v1/onboarding/:id', (req) => {
    const session = sessions.peek(req.params.id)
    if (!session) {
      throw new ApiError(
        404,
        'onboarding_session_not_found',
        `No onboarding session "${req.params.id}".`,
      )
    }
    session.cancel()
    sessions.delete(req.params.id)
    return { session_id: req.params.id, state: 'cancelled' as const }
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

interface BrainNoteListDto {
  slug: string
  title: string
  type: string
  tags: string[]
  created: string
  updated: string
  links: string[]
  /** First 240 chars of the body, lossy preview for the list view. */
  preview: string
}

interface BrainNoteDto extends BrainNoteListDto {
  body: string
}

function toBrainNoteListDto(n: BrainNote): BrainNoteListDto {
  return {
    slug: n.slug,
    title: n.frontmatter.title,
    type: n.frontmatter.type,
    tags: n.frontmatter.tags,
    created: n.frontmatter.created,
    updated: n.frontmatter.updated,
    links: n.frontmatter.links,
    preview: n.body.length > 240 ? n.body.slice(0, 240) + '…' : n.body,
  }
}

function toBrainNoteDto(n: BrainNote): BrainNoteDto {
  return {
    ...toBrainNoteListDto(n),
    body: n.body,
  }
}

/**
 * Lossy DTO for MCP server specs ... drops command-line args and
 * static headers (potentially noisy / sensitive shape; the user
 * doesn't need them in the UI for v1) and any SecretRef values.
 * The shape of `env` and `auth` is preserved as a placeholder so
 * the UI can show "uses GMAIL_OAUTH_TOKEN" without exposing values.
 */
interface McpServerDto {
  name: string
  transport: 'stdio' | 'http'
  /** Stdio: command + arg-count summary (verbatim args omitted to keep the wire small). */
  command?: string
  arg_count?: number
  /** HTTP: endpoint URL. */
  url?: string
  /** Stdio: env var names (values are SecretRefs and never returned). */
  env_keys?: string[]
  /** HTTP: auth shape descriptor. */
  auth_kind?: 'none' | 'bearer'
}

function toMcpServerDto(spec: McpServerSpec): McpServerDto {
  if (spec.transport === 'stdio') {
    return {
      name: spec.name,
      transport: 'stdio',
      command: spec.command,
      arg_count: spec.args.length,
      env_keys: Object.keys(spec.env),
    }
  }
  return {
    name: spec.name,
    transport: 'http',
    url: spec.url,
    auth_kind: spec.auth.type,
  }
}

interface TaskListDto {
  id: string
  agent: string
  state: TaskState
  title: string
  created: string
  /** ISO of the most recent state change (terminal at, detector trip at, etc.). */
  last_at: string | null
  /** Detector kind when state === 'blocked_on_detector'. */
  detector_kind: string | null
  /** Iterations consumed when terminal. */
  iterations: number | null
  /** First 200 chars of outcome.summary when done; error.message when errored. */
  outcome_preview: string | null
}

function toTaskListDto(rec: TaskRecord): TaskListDto {
  const fm = rec.frontmatter
  let lastAt: string | null = null
  if (fm.outcome) lastAt = fm.outcome.at
  else if (fm.error) lastAt = fm.error.at
  else if (fm.detector_block) lastAt = fm.detector_block.at
  let preview: string | null = null
  if (fm.outcome) preview = fm.outcome.summary.slice(0, 200)
  else if (fm.error) preview = `${fm.error.class}: ${fm.error.message}`.slice(0, 200)
  else if (fm.detector_block) preview = fm.detector_block.detail.slice(0, 200)
  return {
    id: fm.id,
    agent: fm.agent,
    state: fm.state,
    title: fm.title,
    created: fm.created,
    last_at: lastAt,
    detector_kind: fm.detector_block?.kind ?? null,
    iterations: fm.outcome?.iterations ?? null,
    outcome_preview: preview,
  }
}

function toScheduleDto(entry: ScheduleEntry) {
  return {
    id: entry.id,
    agent: entry.agent,
    description: entry.description,
    prompt: entry.prompt,
    timing: entry.timing,
    enabled: entry.enabled,
    created_at: entry.created_at,
    last_fired_at: entry.last_fired_at,
    next_fire_at: entry.next_fire_at,
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
