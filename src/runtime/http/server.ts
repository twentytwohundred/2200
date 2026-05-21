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
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import fastifyWebsocketImport from '@fastify/websocket'
import { z, ZodError } from 'zod'
import type { Supervisor } from '../supervisor/supervisor.js'
import type { Logger } from '../util/logger.js'
import { emitNotification } from '../notifications/writer.js'
import {
  agentBrainIndexPath,
  agentPaths as agentPathsHelper,
  homePaths,
  pubPaths,
} from '../storage/layout.js'
import { createIdentityClient, ensureRegistered } from '../pub/identity-client.js'
import { readCredentialFile, writeCredentialFile } from '../pub/keypair.js'
import { readPubSecrets } from '../pub/secrets.js'

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
import { ConnectorInboundEventSchema } from '../connectors/inbound-types.js'
import { routeInbound } from '../connectors/router.js'
import type { IdentityFrontmatter } from '../identity/types.js'
import { loadCatalog, type CatalogEntry } from '../extensions/catalog.js'
import {
  installFromCatalogEntry,
  type InstallProgressEvent,
} from '../extensions/install-pipeline.js'
import { GatewayManager } from '../connectors/gateway-manager.js'
import { upsertConnectorBinding } from '../identity/binding-writer.js'
import { listKnownProviders, type ProviderCatalogEntry } from '../llm/registry.js'
import { loadPricingTable } from '../llm/pricing.js'
import {
  defaultRuntimeEnvPath,
  loadRuntimeEnv,
  removeRuntimeEnvKey,
  upsertRuntimeEnvKey,
} from '../config/runtime-env.js'
import { aggregateToolHealth } from '../tools/health.js'
import {
  installSkillFromSource,
  listSkillCredentials,
  previewSkillInstall,
  SkillOrchestratorError,
  uninstallSkillFromHome,
  updateSkillCredential,
} from '../skills/orchestrator.js'
import { listSkills } from '../skills/registry.js'
import { TaskStore } from '../agent/task/store.js'
import { newPendingTask, type TaskRecord, type TaskState } from '../agent/task/types.js'
import { buildContinuationSection } from '../agent/task/continuation.js'
import { newTaskId } from '../util/id.js'
import { ChatStore, type ChatMessage } from '../agent/chat/store.js'
import {
  MultiChatStore,
  type ChatMessageRecord as MultiChatMessage,
  type ChatThread,
} from '../agent/chat/multi-store.js'
import { EndpointStore } from '../endpoints/store.js'
import { EndpointDiscoveryError, discoverModels } from '../endpoints/discover.js'
import type { CustomEndpoint } from '../endpoints/types.js'
import { SupervisorPubBridge, PubBridgeError } from '../supervisor/pub-bridge.js'
import { readRoster } from '../pub/roster.js'
import { regenerateFleet, fleetPath } from '../supervisor/fleet.js'
import {
  ApiError,
  envelope,
  genericEnvelope,
  newRequestId,
  notFound,
  unauthorized,
} from './errors.js'
import { WebTokenStore } from './tokens.js'
import { CredentialVault } from '../credentials/vault.js'
import { CredentialRequestStore } from '../credentials/requests.js'
import {
  CredentialRequestError,
  toEnvelopeV1,
  type CredentialRequest,
} from '../credentials/request-types.js'

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
  /**
   * Override the Extensions catalog path. Production fetches from
   * 2200.ai; dev falls back to the in-repo `extensions-catalog/v1.json`.
   */
  catalogPath?: string
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

function resolveCatalogPath(override?: string): string {
  if (override) return override
  // src/runtime/http/server.ts → ../../../extensions-catalog/v1.json
  // dist/runtime/http/server.js → ../../../extensions-catalog/v1.json
  const here = dirname(fileURLToPath(import.meta.url))
  return resolvePath(here, '..', '..', '..', 'extensions-catalog', 'v1.json')
}

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

  const paths = homePaths(home)
  const tokens = new WebTokenStore(paths.stateWebTokens)
  await tokens.ensure('default')

  // Supervisor-side PubClient bridge. Lazy-init: nothing happens until
  // the first /api/v1/pubs/:name/messages call wakes a connection.
  // Shut down with the rest of the HTTP server.
  const bridgeLogger = log?.child('pub-bridge')
  const pubBridge = new SupervisorPubBridge({
    home,
    paths,
    supervisor,
    ...(bridgeLogger ? { logger: bridgeLogger } : {}),
  })

  const fastify = Fastify({
    logger: false,
    trustProxy: false,
    // 16 MB. Pub message bodies can carry attachments inline as
    // base64-encoded blobs (text files + small images). 16 MB covers
    // a few attachments per message after the ~33% base64 overhead.
    // Per-attachment + total caps still enforced at the route level.
    bodyLimit: 16 * 1024 * 1024,
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
    // Extension icon endpoint is public ... `<img src>` tags can't
    // send Authorization headers, and icons are branding assets, not
    // sensitive data. Match the supervisor's static-frontend posture.
    if (/^\/api\/v1\/extensions\/[a-z][a-z0-9-]*\/icon$/.test(req.url)) {
      return
    }
    // Gateway → supervisor pair-state push is loopback-only (the
    // gateway child process runs on the same host as the supervisor).
    // The GET counterpart stays authenticated.
    if (
      req.method === 'POST' &&
      /^\/api\/v1\/extensions\/[a-z][a-z0-9-]*\/pair\/state$/.test(req.url)
    ) {
      return
    }
    // Connector gateways post their inbound events here. Same
    // loopback-only rationale as pair/state; the substrate-side
    // endpoint validates the Extension manifest carefully.
    if (
      req.method === 'POST' &&
      /^\/api\/v1\/connectors\/[a-z][a-z0-9_]*\/inbound$/.test(req.url)
    ) {
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

  // --------------------------------------------------------------
  // System: self-upgrade endpoints.
  // --------------------------------------------------------------
  fastify.get('/api/v1/system/version', async () => {
    const { VERSION: PKG_VERSION } = await import('../../index.js')
    const { checkLatestVersion, detectInstallSource } = await import('../install/update.js')
    const source = detectInstallSource(fileURLToPath(import.meta.url))
    const check = await checkLatestVersion(PKG_VERSION)
    return {
      current: check.current,
      latest: check.kind === 'registry-error' ? null : check.latest,
      status: check.kind,
      install_source: source.kind,
      registry_error: check.kind === 'registry-error' ? check.message : null,
    }
  })

  fastify.post<{ Body: { target_version?: string } | undefined }>(
    '/api/v1/system/update',
    async (req, reply) => {
      const { triggerUpgrade } = await import('../install/upgrade-trigger.js')
      const body = req.body ?? {}
      const result = await triggerUpgrade({
        home: options.home,
        ...(body.target_version !== undefined ? { targetVersion: body.target_version } : {}),
      })

      // Map trigger outcomes to HTTP status codes.
      switch (result.kind) {
        case 'started': {
          // Schedule the daemon's own exit AFTER the response has
          // had a chance to flush. The detached helper is already
          // waiting for our PID to clear.
          //
          // 500ms is enough for the response to land at the
          // browser; longer is just dead-air. The helper polls
          // every 250ms, so it picks up the exit promptly.
          setTimeout(() => {
            process.kill(process.pid, 'SIGTERM')
          }, 500).unref()
          await reply.code(202).send(result)
          return
        }
        case 'up-to-date':
          await reply.code(409).send({ error: 'up-to-date', ...result })
          return
        case 'ahead':
          await reply.code(409).send({ error: 'ahead', ...result })
          return
        case 'source-checkout':
          await reply.code(409).send({ error: 'source-checkout', ...result })
          return
        case 'registry-error':
          await reply.code(502).send({ error: 'registry-error', ...result })
          return
      }
    },
  )

  fastify.get('/api/v1/system/upgrade-status', async () => {
    const { readUpgradeStatus } = await import('../install/upgrade-status.js')
    const status = await readUpgradeStatus(options.home)
    return { status }
  })

  // --------------------------------------------------------------
  // OAuth: xAI / Grok device-code sign-in (browser-driven).
  //
  // Mirrors the CLI flow (`2200 oauth xai login`) over HTTP so the
  // Settings page can drive the sign-in inline. The flow is stateful
  // across two requests:
  //
  //   1. POST  /api/v1/oauth/xai/login/start
  //        → daemon calls device-authorization endpoint, returns
  //          { session_id, user_code, verification_uri, ... }
  //   2. GET   /api/v1/oauth/xai/login/status?session=<id>
  //        → daemon does ONE token-endpoint poll, returns
  //          { status: 'pending' | 'completed' | 'failed', ... }.
  //          Browser polls at its own cadence.
  //   3. GET   /api/v1/oauth/xai/status
  //        → reads the sealed token (if any) and returns
  //          configured/expires/scopes (no secrets).
  //   4. POST  /api/v1/oauth/xai/logout
  //        → deletes the sealed token from disk.
  //
  // The session manager is in-process and dies with the daemon.
  // A daemon restart during a sign-in just means the user clicks
  // "Sign in" again ... no persistence of in-flight secrets.
  // --------------------------------------------------------------
  const { DeviceFlowSessionManager } = await import('../oauth/device-flow-session.js')
  const oauthSessions = new DeviceFlowSessionManager()

  fastify.post('/api/v1/oauth/xai/login/start', async (_req, reply) => {
    const { fetchXaiDiscovery, xaiDeviceFlowProvider, XAI_OAUTH_CLIENT_ID, XAI_OAUTH_SCOPES } =
      await import('../oauth/xai-config.js')
    const { generatePkce } = await import('../oauth/pkce.js')
    let discovery
    try {
      discovery = await fetchXaiDiscovery()
    } catch (err) {
      await reply.code(502).send({
        error: 'discovery_failed',
        message: err instanceof Error ? err.message : String(err),
      })
      return
    }
    const provider = xaiDeviceFlowProvider(discovery)
    const pkce = generatePkce()

    const initBody = new URLSearchParams()
    initBody.set('client_id', XAI_OAUTH_CLIENT_ID)
    initBody.set('scope', XAI_OAUTH_SCOPES.join(' '))
    initBody.set('code_challenge', pkce.challenge)
    initBody.set('code_challenge_method', pkce.method)

    let initRes
    try {
      initRes = await fetch(provider.deviceAuthorizationUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: initBody.toString(),
      })
    } catch (err) {
      await reply.code(502).send({
        error: 'device_authorization_request_failed',
        message: err instanceof Error ? err.message : String(err),
      })
      return
    }
    if (!initRes.ok) {
      const text = await initRes.text().catch(() => '')
      await reply.code(502).send({
        error: 'device_authorization_request_failed',
        message: `HTTP ${String(initRes.status)} ${text.slice(0, 300)}`,
      })
      return
    }
    const initJson = (await initRes.json().catch(() => null)) as {
      device_code?: string
      user_code?: string
      verification_uri?: string
      verification_uri_complete?: string
      expires_in?: number
      interval?: number
    } | null
    if (!initJson?.device_code || !initJson.user_code || !initJson.verification_uri) {
      await reply.code(502).send({
        error: 'device_authorization_invalid_response',
        message: 'xAI device-auth response missing device_code, user_code, or verification_uri',
      })
      return
    }

    const expiresInRaw = initJson.expires_in
    const expiresInSec =
      typeof expiresInRaw === 'number' && Number.isFinite(expiresInRaw) ? expiresInRaw : 900
    // RFC 8628: minimum 5s polling interval.
    const intervalRaw = initJson.interval
    const rawInterval =
      typeof intervalRaw === 'number' && Number.isFinite(intervalRaw) ? intervalRaw : 5
    const intervalSec = Math.min(Math.max(rawInterval, 5), 60)
    const session = oauthSessions.create({
      provider,
      deviceCode: initJson.device_code,
      userCode: initJson.user_code,
      verificationUri: initJson.verification_uri,
      ...(initJson.verification_uri_complete
        ? { verificationUriComplete: initJson.verification_uri_complete }
        : {}),
      expiresAtMs: Date.now() + expiresInSec * 1000,
      codeVerifier: pkce.verifier,
      intervalSec,
    })
    return session
  })

  fastify.get<{ Querystring: { session?: string } }>(
    '/api/v1/oauth/xai/login/status',
    async (req, reply) => {
      const sessionId = req.query.session
      if (!sessionId) {
        await reply.code(400).send({ error: 'missing_session_id' })
        return
      }
      const rec = oauthSessions.get(sessionId)
      if (!rec) {
        await reply.code(404).send({ error: 'unknown_session' })
        return
      }
      // Re-polls of a completed session return the same terminal value
      // so the browser can rely on idempotent status responses.
      if (rec.completed) return rec.completed

      const pollBody = new URLSearchParams()
      pollBody.set('grant_type', 'urn:ietf:params:oauth:grant-type:device_code')
      pollBody.set('device_code', rec.deviceCode)
      pollBody.set('client_id', rec.provider.clientId)
      pollBody.set('code_verifier', rec.codeVerifier)

      let pollRes
      try {
        pollRes = await fetch(rec.tokenUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: pollBody.toString(),
        })
      } catch (err) {
        // Transient network errors: report pending so the browser
        // tries again at its own cadence. We do NOT mark failed here;
        // a brief blip should not kill a sign-in.
        return {
          status: 'pending' as const,
          poll_interval_sec: rec.intervalSec,
          transient_error: err instanceof Error ? err.message : String(err),
        }
      }
      const pollJson = (await pollRes.json().catch(() => null)) as {
        access_token?: string
        refresh_token?: string
        expires_in?: number
        scope?: string
        error?: string
        error_description?: string
      } | null

      if (pollRes.ok && pollJson?.access_token) {
        const now = Date.now()
        const expiresAtMs =
          pollJson.expires_in !== undefined ? now + pollJson.expires_in * 1000 : now + 3_600_000
        const grantedScopes = pollJson.scope ? pollJson.scope.split(/\s+/) : []
        const refreshToken = pollJson.refresh_token ?? ''
        if (!refreshToken) {
          const fail = {
            status: 'failed' as const,
            error: 'no_refresh_token',
            description:
              'xAI did not return a refresh token; ensure the offline_access scope was granted at consent.',
          }
          oauthSessions.recordCompletion(sessionId, fail)
          return fail
        }
        const { saveOAuthToken } = await import('../oauth/token-store.js')
        await saveOAuthToken(home, {
          provider: 'xai-oauth',
          bearer: pollJson.access_token,
          refreshToken,
          metadata: {
            granted_scopes: grantedScopes,
            expires_at_ms: expiresAtMs,
            created_at: new Date(now).toISOString(),
          },
        })
        const result = {
          status: 'completed' as const,
          access_token: '<sealed-on-disk>',
          refresh_token: '<sealed-on-disk>',
          expires_at_ms: expiresAtMs,
          granted_scopes: grantedScopes,
        }
        oauthSessions.recordCompletion(sessionId, result)
        return result
      }

      const errorCode = pollJson?.error ?? 'unknown'
      if (errorCode === 'authorization_pending') {
        return { status: 'pending' as const, poll_interval_sec: rec.intervalSec }
      }
      if (errorCode === 'slow_down') {
        oauthSessions.bumpInterval(sessionId, 5)
        const updated = oauthSessions.get(sessionId)
        return { status: 'pending' as const, poll_interval_sec: updated?.intervalSec ?? 10 }
      }
      const failResult = {
        status: 'failed' as const,
        error: errorCode,
        ...(pollJson?.error_description ? { description: pollJson.error_description } : {}),
      }
      oauthSessions.recordCompletion(sessionId, failResult)
      return failResult
    },
  )

  fastify.get('/api/v1/oauth/xai/status', async () => {
    const { readOAuthToken } = await import('../oauth/token-store.js')
    const token = await readOAuthToken(home, 'xai-oauth').catch(() => null)
    if (!token) {
      return { configured: false }
    }
    return {
      configured: true,
      provider: token.provider,
      granted_scopes: token.metadata.granted_scopes,
      expires_at: new Date(token.metadata.expires_at_ms).toISOString(),
      expires_at_ms: token.metadata.expires_at_ms,
      created_at: token.metadata.created_at,
      refreshed_at: token.metadata.refreshed_at ?? null,
    }
  })

  fastify.post('/api/v1/oauth/xai/logout', async () => {
    const { deleteOAuthToken } = await import('../oauth/token-store.js')
    const removed = await deleteOAuthToken(home, 'xai-oauth')
    return { removed }
  })

  fastify.get('/api/v1/schema', () => ({
    api: 'v1',
    runtime: VERSION,
    description:
      'JSON Schema bundle is sketched at v1; full self-describing surface lands as endpoints stabilize.',
    endpoints: [
      { method: 'GET', path: '/api/v1/me' },
      { method: 'GET', path: '/api/v1/runtime/health' },
      { method: 'GET', path: '/api/v1/runtime/version' },
      { method: 'GET', path: '/api/v1/system/version' },
      { method: 'POST', path: '/api/v1/system/update' },
      { method: 'GET', path: '/api/v1/system/upgrade-status' },
      { method: 'GET', path: '/api/v1/agents' },
      { method: 'GET', path: '/api/v1/agents/:name' },
      { method: 'POST', path: '/api/v1/agents/:name/start' },
      { method: 'POST', path: '/api/v1/agents/:name/stop' },
      { method: 'POST', path: '/api/v1/agents/:name/archive' },
      { method: 'POST', path: '/api/v1/agents/:name/unarchive' },
      { method: 'GET', path: '/api/v1/agents/:name/budget' },
      { method: 'PUT', path: '/api/v1/agents/:name/budget' },
      { method: 'GET', path: '/api/v1/agents/:name/brain' },
      { method: 'GET', path: '/api/v1/agents/:name/brain/search' },
      { method: 'GET', path: '/api/v1/agents/:name/brain/note/:slug' },
      { method: 'GET', path: '/api/v1/agents/:name/schedules' },
      { method: 'POST', path: '/api/v1/agents/:name/schedules' },
      { method: 'PATCH', path: '/api/v1/agents/:name/schedules/:id' },
      { method: 'DELETE', path: '/api/v1/agents/:name/schedules/:id' },
      { method: 'GET', path: '/api/v1/agents/:name/tools' },
      { method: 'GET', path: '/api/v1/agents/:name/tasks' },
      { method: 'GET', path: '/api/v1/agents/:name/tasks/:id' },
      { method: 'POST', path: '/api/v1/agents/:name/tasks' },
      { method: 'POST', path: '/api/v1/agents/:name/brain' },
      { method: 'PATCH', path: '/api/v1/agents/:name/brain/note/:slug' },
      { method: 'DELETE', path: '/api/v1/agents/:name/brain/note/:slug' },
      { method: 'GET', path: '/api/v1/agents/:name/identity' },
      { method: 'PUT', path: '/api/v1/agents/:name/identity' },
      { method: 'PUT', path: '/api/v1/agents/:name/model' },
      { method: 'PUT', path: '/api/v1/agents/:name/avatar' },
      { method: 'PUT', path: '/api/v1/agents/:name/avatar/image' },
      { method: 'GET', path: '/api/v1/agents/:name/avatar/image' },
      { method: 'DELETE', path: '/api/v1/agents/:name/avatar/image' },
      { method: 'GET', path: '/api/v1/settings/providers' },
      { method: 'PUT', path: '/api/v1/settings/providers/:id/key' },
      { method: 'DELETE', path: '/api/v1/settings/providers/:id/key' },
      { method: 'PUT', path: '/api/v1/settings/providers/local/url' },
      { method: 'GET', path: '/api/v1/settings/endpoints' },
      { method: 'POST', path: '/api/v1/settings/endpoints' },
      { method: 'GET', path: '/api/v1/settings/endpoints/:id' },
      { method: 'PATCH', path: '/api/v1/settings/endpoints/:id' },
      { method: 'DELETE', path: '/api/v1/settings/endpoints/:id' },
      { method: 'POST', path: '/api/v1/settings/endpoints/discover' },
      { method: 'GET', path: '/api/v1/agents/:name/chat' },
      { method: 'POST', path: '/api/v1/agents/:name/chat' },
      { method: 'GET', path: '/api/v1/agents/:name/chats' },
      { method: 'POST', path: '/api/v1/agents/:name/chats' },
      { method: 'GET', path: '/api/v1/agents/:name/chats/:chatId' },
      { method: 'PATCH', path: '/api/v1/agents/:name/chats/:chatId' },
      { method: 'POST', path: '/api/v1/agents/:name/chats/:chatId/archive' },
      { method: 'POST', path: '/api/v1/agents/:name/chats/:chatId/read' },
      { method: 'GET', path: '/api/v1/agents/:name/chats/:chatId/messages' },
      { method: 'POST', path: '/api/v1/agents/:name/chats/:chatId/messages' },
      { method: 'POST', path: '/api/v1/agents/:name/chats/:chatId/attachments' },
      {
        method: 'GET',
        path: '/api/v1/agents/:name/chats/:chatId/attachments/:attId/:filename',
      },
      { method: 'GET', path: '/api/v1/agents/:name/credential-requests' },
      {
        method: 'POST',
        path: '/api/v1/agents/:name/credential-requests/:id/fulfill',
      },
      {
        method: 'POST',
        path: '/api/v1/agents/:name/credential-requests/:id/decline',
      },
      { method: 'GET', path: '/api/v1/notifications' },
      { method: 'GET', path: '/api/v1/notifications/:id' },
      { method: 'POST', path: '/api/v1/notifications/:id/respond' },
      { method: 'POST', path: '/api/v1/notifications/:id/dismiss' },
      { method: 'GET', path: '/api/v1/fleet' },
      { method: 'GET', path: '/api/v1/pubs' },
      { method: 'GET', path: '/api/v1/pubs/:name' },
      { method: 'GET', path: '/api/v1/pubs/:name/messages' },
      { method: 'POST', path: '/api/v1/pubs/:name/messages' },
      { method: 'POST', path: '/api/v1/pubs' },
      { method: 'PATCH', path: '/api/v1/pubs/:name' },
      { method: 'DELETE', path: '/api/v1/pubs/:name' },
      { method: 'POST', path: '/api/v1/pubs/:name/reactions' },
      { method: 'GET', path: '/api/v1/pubs/attachments/:attId/:filename' },
      { method: 'POST', path: '/api/v1/onboarding' },
      { method: 'GET', path: '/api/v1/onboarding/:id' },
      { method: 'POST', path: '/api/v1/onboarding/:id/answer' },
      { method: 'POST', path: '/api/v1/onboarding/:id/confirm' },
      { method: 'DELETE', path: '/api/v1/onboarding/:id' },
      { method: 'GET', path: '/api/v1/skills' },
      { method: 'POST', path: '/api/v1/skills/preview' },
      { method: 'POST', path: '/api/v1/skills/install' },
      { method: 'DELETE', path: '/api/v1/skills/:name' },
      { method: 'GET', path: '/api/v1/skills/:name/credentials' },
      { method: 'PUT', path: '/api/v1/skills/:name/credentials/:agent/:envKey' },
      { method: 'WS', path: '/api/v1/ws' },
    ],
  }))

  // -- settings: providers + keys (Epic 15 Phase C) ------------------------
  // Web-side management for LLM provider credentials. Reads + writes
  // ~/.config/2200/runtime.env in place. The supervisor reads that file
  // once at boot, so adding/changing a key requires restarting the
  // affected agents (the response carries `restart_required: true` to
  // surface this in the UI).
  //
  // Power users still own the file directly. The web write path
  // preserves comments and unrelated entries.

  /** Mask all but the last 4 chars of a key for display. */
  function maskKey(value: string): string {
    if (value.length <= 4) return '*'.repeat(Math.max(value.length, 0))
    return '*'.repeat(value.length - 4) + value.slice(-4)
  }

  /**
   * Compose the provider snapshot returned by GET
   * /api/v1/settings/providers. Combines the static catalog with the
   * runtime.env file's current contents and the live agent fleet.
   */
  type ProviderDto = ProviderCatalogEntry & {
    key_set: boolean
    key_masked: string | null
    agents_using: string[]
    suggested_models: string[]
  }
  async function buildProvidersDto(): Promise<{
    runtime_env_path: string
    items: ProviderDto[]
  }> {
    const envPath = defaultRuntimeEnvPath()
    const env = await loadRuntimeEnv(envPath)
    const snap = supervisor.snapshot()
    const pricing = loadPricingTable()

    // Group pricing-known models by provider so the UI can offer chips.
    const modelsByProvider: Record<string, string[]> = {}
    for (const key of Object.keys(pricing.models)) {
      const slash = key.indexOf('/')
      if (slash === -1) continue
      const prov = key.slice(0, slash)
      const model = key.slice(slash + 1)
      ;(modelsByProvider[prov] ??= []).push(model)
    }

    // Group running agents by provider so the user can see which
    // agents will need a restart after a key change. We re-read each
    // Identity from disk because the snapshot only carries the path;
    // a malformed Identity is tolerated (skipped) so a single bad
    // file does not break the settings page.
    const agentsByProvider: Record<string, string[]> = {}
    for (const rec of Object.values(snap.agents)) {
      try {
        const id = await loadIdentity(rec.identity_path)
        const prov = id.frontmatter.model.provider
        ;(agentsByProvider[prov] ??= []).push(id.frontmatter.agent_name)
      } catch {
        /* skip unreadable Identity */
      }
    }

    // Subscription providers (xai-subscription) get their "configured"
    // signal from the fleet OAuth token store, not from runtime.env.
    // Read once here so each provider in the loop below can check.
    const xaiSubscriptionConfigured = await (async () => {
      try {
        const { readOAuthToken } = await import('../oauth/token-store.js')
        const tok = await readOAuthToken(home, 'xai-oauth')
        return tok !== null && tok.metadata.expires_at_ms > Date.now()
      } catch {
        return false
      }
    })()

    const items = listKnownProviders().map((cat) => {
      const value = env[cat.defaultEnvKey] ?? ''
      // Subscription providers don't read runtime.env; their `key_set`
      // is whether the OAuth token is present and unexpired.
      const keySet = cat.category === 'subscription' ? xaiSubscriptionConfigured : value.length > 0
      // xai-subscription shares grok-* models with the API-key xai
      // provider, but pricing.json keys those under "xai/...". Copy
      // the suggestions over so the picker shows the same model list
      // under the Subscriptions optgroup.
      const suggestedKey = cat.name === 'xai-subscription' ? 'xai' : cat.name
      return {
        ...cat,
        // Reflect the live env value for the local provider's URL,
        // since the catalog snapshot reads it once at module load.
        baseUrl: cat.name === 'local' ? (env['LOCAL_BASE_URL'] ?? cat.baseUrl) : cat.baseUrl,
        key_set: keySet,
        key_masked: keySet && cat.category !== 'subscription' ? maskKey(value) : null,
        agents_using: (agentsByProvider[cat.name] ?? []).sort(),
        suggested_models: (modelsByProvider[suggestedKey] ?? []).sort(),
      }
    })
    return { runtime_env_path: envPath, items }
  }

  fastify.get('/api/v1/settings/providers', async () => {
    return buildProvidersDto()
  })

  const PutProviderKeyBody = z.object({
    /** Plain-text API key. Stored in runtime.env. Empty string = remove. */
    key: z.string(),
  })

  fastify.put<{ Params: { id: string } }>('/api/v1/settings/providers/:id/key', async (req) => {
    const cat = listKnownProviders().find((c) => c.name === req.params.id)
    if (!cat) throw notFound('provider', req.params.id)
    const body = PutProviderKeyBody.parse(req.body)
    if (body.key === '') {
      await removeRuntimeEnvKey(cat.defaultEnvKey)
    } else {
      await upsertRuntimeEnvKey(cat.defaultEnvKey, body.key)
    }
    const env = await loadRuntimeEnv()
    const value = env[cat.defaultEnvKey] ?? ''
    return {
      provider: cat.name,
      env_key: cat.defaultEnvKey,
      key_set: value.length > 0,
      key_masked: value.length > 0 ? maskKey(value) : null,
      restart_required: true,
    }
  })

  fastify.delete<{ Params: { id: string } }>('/api/v1/settings/providers/:id/key', async (req) => {
    const cat = listKnownProviders().find((c) => c.name === req.params.id)
    if (!cat) throw notFound('provider', req.params.id)
    await removeRuntimeEnvKey(cat.defaultEnvKey)
    return {
      provider: cat.name,
      env_key: cat.defaultEnvKey,
      key_set: false,
      restart_required: true,
    }
  })

  const PutLocalUrlBody = z.object({
    /** Full base URL for the local OpenAI-compatible endpoint. */
    base_url: z.url(),
  })

  fastify.put('/api/v1/settings/providers/local/url', async (req) => {
    const body = PutLocalUrlBody.parse(req.body)
    await upsertRuntimeEnvKey('LOCAL_BASE_URL', body.base_url)
    return { provider: 'local', base_url: body.base_url, restart_required: true }
  })

  // -- settings/endpoints (custom OpenAI-compatible servers) -----------------
  // Operators can register N homelab / appliance LLM endpoints. Each
  // entry persists to <home>/config/endpoints.json (mode 0600) and the
  // LLM registry resolves `endpoint:<slug>` provider strings against
  // the matching record. See src/runtime/endpoints/.

  const endpointStore = new EndpointStore(home)

  fastify.get('/api/v1/settings/endpoints', async () => {
    const items = await endpointStore.list()
    return { items: items.map(toEndpointDto), cursor: { next: null, limit: items.length } }
  })

  const EndpointCreateBody = z.object({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,49}$/)
      .optional(),
    name: z.string().min(1).max(80),
    base_url: z.url().max(500),
    api_key: z.string().max(2000).optional(),
    models: z
      .array(z.object({ id: z.string().min(1).max(200), label: z.string().max(200).optional() }))
      .optional(),
    /** When true, hit /models and return the discovered list inline. */
    discover: z.boolean().default(true),
  })

  fastify.post('/api/v1/settings/endpoints', async (req, reply) => {
    const body = EndpointCreateBody.parse(req.body)
    let discovered: { id: string }[] = []
    let discoverError: { kind: string; message: string } | null = null
    if (body.discover) {
      try {
        const models = await discoverModels({
          baseUrl: body.base_url,
          ...(body.api_key !== undefined ? { apiKey: body.api_key } : {}),
        })
        discovered = models.map((m) => ({ id: m.id }))
      } catch (err) {
        if (err instanceof EndpointDiscoveryError) {
          discoverError = { kind: err.kind, message: err.message }
        } else {
          throw err
        }
      }
    }
    const entry = await endpointStore.create({
      ...(body.id !== undefined ? { id: body.id } : {}),
      name: body.name,
      base_url: body.base_url,
      ...(body.api_key !== undefined ? { api_key: body.api_key } : {}),
      ...(body.models !== undefined ? { models: body.models } : {}),
    })
    void reply.status(201)
    return {
      endpoint: toEndpointDto(entry),
      discovered_models: discovered,
      discover_error: discoverError,
    }
  })

  fastify.get<{ Params: { id: string } }>('/api/v1/settings/endpoints/:id', async (req) => {
    const entry = await endpointStore.get(req.params.id)
    if (!entry) throw notFound('endpoint', req.params.id)
    return { endpoint: toEndpointDto(entry) }
  })

  const EndpointPatchBody = z.object({
    name: z.string().min(1).max(80).optional(),
    base_url: z.url().max(500).optional(),
    api_key: z.string().max(2000).optional(),
    models: z
      .array(z.object({ id: z.string().min(1).max(200), label: z.string().max(200).optional() }))
      .optional(),
  })

  fastify.patch<{ Params: { id: string } }>('/api/v1/settings/endpoints/:id', async (req) => {
    const body = EndpointPatchBody.parse(req.body)
    const existing = await endpointStore.get(req.params.id)
    if (!existing) throw notFound('endpoint', req.params.id)
    const patch: Partial<Pick<typeof existing, 'name' | 'base_url' | 'api_key' | 'models'>> = {}
    if (body.name !== undefined) patch.name = body.name
    if (body.base_url !== undefined) patch.base_url = body.base_url
    if (body.api_key !== undefined) patch.api_key = body.api_key
    if (body.models !== undefined) patch.models = body.models
    const updated = await endpointStore.update(req.params.id, patch)
    return { endpoint: toEndpointDto(updated) }
  })

  fastify.delete<{ Params: { id: string } }>('/api/v1/settings/endpoints/:id', async (req) => {
    const existing = await endpointStore.get(req.params.id)
    if (!existing) throw notFound('endpoint', req.params.id)
    await endpointStore.delete(req.params.id)
    return { id: req.params.id, deleted: true as const }
  })

  const DiscoverProbeBody = z.object({
    base_url: z.url().max(500),
    api_key: z.string().max(2000).optional(),
  })

  fastify.post('/api/v1/settings/endpoints/discover', async (req) => {
    const body = DiscoverProbeBody.parse(req.body)
    try {
      const models = await discoverModels({
        baseUrl: body.base_url,
        ...(body.api_key !== undefined ? { apiKey: body.api_key } : {}),
      })
      return { ok: true as const, models: models.map((m) => ({ id: m.id })) }
    } catch (err) {
      if (err instanceof EndpointDiscoveryError) {
        return { ok: false as const, error: { kind: err.kind, message: err.message } }
      }
      throw err
    }
  })

  // Live-poll models from a saved endpoint without re-passing its
  // api_key. The Endpoints UI hits this on a periodic schedule per
  // row so the human sees what the upstream server is currently
  // serving (e.g. a GB10 swapping between Llama 3.3 70B and a
  // smaller model). Returns the same shape as /discover so the
  // client can dedupe its render logic.
  fastify.get<{ Params: { id: string } }>(
    '/api/v1/settings/endpoints/:id/models',
    async (req, reply) => {
      const existing = await endpointStore.get(req.params.id)
      if (!existing) throw notFound('endpoint', req.params.id)
      try {
        const models = await discoverModels({
          baseUrl: existing.base_url,
          ...(existing.api_key ? { apiKey: existing.api_key } : {}),
        })
        return await reply.send({
          ok: true as const,
          endpoint_id: existing.id,
          models: models.map((m) => ({ id: m.id })),
          fetched_at: new Date().toISOString(),
        })
      } catch (err) {
        if (err instanceof EndpointDiscoveryError) {
          return await reply.send({
            ok: false as const,
            endpoint_id: existing.id,
            error: { kind: err.kind, message: err.message },
            fetched_at: new Date().toISOString(),
          })
        }
        throw err
      }
    },
  )

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

  // -- archive / unarchive -------------------------------------------------
  // Archive renames the per-Agent on-disk subtrees to
  // `<name>-archived-<YYYY-MM-DD>` so the original name is freed for
  // a future Agent of the same name. Brain, chats, identity, schedules
  // (deleted) all move with the rename. Unarchive reverses it ... by
  // default restores the pre-archive name; pass `rename_to` to land on
  // a different name when the original is no longer free.
  const ArchiveAgentBody = z
    .object({
      reason: z.string().min(1).max(500).optional(),
    })
    .optional()

  fastify.post<{ Params: { name: string }; Body: { reason?: string } | undefined }>(
    '/api/v1/agents/:name/archive',
    async (req) => {
      const snap = supervisor.snapshot()
      const rec = snap.agents[req.params.name]
      if (!rec) throw notFound('agent', req.params.name)
      if (rec.state === 'archived') {
        throw new ApiError(409, 'already_archived', `agent ${req.params.name} is already archived`)
      }
      const parsed = ArchiveAgentBody.parse(req.body)
      let archivedName: string
      try {
        archivedName = await supervisor.archiveAgent(req.params.name, {
          ...(parsed?.reason !== undefined ? { reason: parsed.reason } : {}),
        })
      } catch (err) {
        throw new ApiError(500, 'archive_failed', err instanceof Error ? err.message : String(err))
      }
      const after = supervisor.snapshot().agents[archivedName]
      if (!after) throw notFound('agent', archivedName)
      return await toAgentDto(home, after)
    },
  )

  const UnarchiveAgentBody = z
    .object({
      rename_to: z
        .string()
        .min(1)
        .regex(/^[a-z][a-z0-9_-]*$/, {
          message:
            'rename_to must start with a lowercase letter; lowercase letters, digits, _, - only',
        })
        .optional(),
    })
    .optional()

  fastify.post<{ Params: { name: string }; Body: { rename_to?: string } | undefined }>(
    '/api/v1/agents/:name/unarchive',
    async (req) => {
      const snap = supervisor.snapshot()
      const rec = snap.agents[req.params.name]
      if (!rec) throw notFound('agent', req.params.name)
      if (rec.state !== 'archived') {
        throw new ApiError(409, 'not_archived', `agent ${req.params.name} is not archived`)
      }
      const parsed = UnarchiveAgentBody.parse(req.body)
      let restored: string
      try {
        restored = await supervisor.unarchiveAgent(req.params.name, {
          ...(parsed?.rename_to !== undefined ? { rename_to: parsed.rename_to } : {}),
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('already in use')) {
          throw new ApiError(409, 'name_in_use', msg)
        }
        throw new ApiError(500, 'unarchive_failed', msg)
      }
      const after = supervisor.snapshot().agents[restored]
      if (!after) throw notFound('agent', restored)
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
    const rec = snap.agents[req.params.name]
    if (!rec) throw notFound('agent', req.params.name)
    const today = await readBudgetStateToday(home, req.params.name)
    const override = await readBudgetOverride(home, req.params.name)
    const history = await listBudgetHistory(home, req.params.name)

    // Configured cap lives in identity.md (cost_caps.daily_usd).
    // today.cap_usd in the state file is the *enforced* cap the live
    // tracker is using, which only changes on Agent restart. Surface
    // both so the UI can show the operator-set value immediately
    // after a PUT while still flagging the runtime delta.
    let configured: { daily_usd: number; warn_at_pct: number } | null = null
    try {
      const id = await loadIdentity(rec.identity_path)
      configured = {
        daily_usd: id.frontmatter.cost_caps.daily_usd,
        warn_at_pct: id.frontmatter.cost_caps.warn_at_pct,
      }
    } catch {
      /* leave null; client falls back to today's enforced cap */
    }

    return {
      today: today ? toBudgetStateDto(today) : null,
      override: override ? toBudgetOverrideDto(override) : null,
      history: history.map(toBudgetStateDto),
      configured,
    }
  })

  // PUT updates the Agent's per-day budget knobs in identity.md
  // frontmatter (cost_caps.daily_usd, cost_caps.warn_at_pct). The
  // change takes effect on the Agent's next start ... the in-process
  // BudgetTracker holds its loaded cap until restart.
  const PutAgentBudgetBody = z.object({
    daily_usd: z.number().positive().max(100_000).optional(),
    warn_at_pct: z.number().int().min(1).max(99).optional(),
  })

  fastify.put<{ Params: { name: string } }>('/api/v1/agents/:name/budget', async (req) => {
    const snap = supervisor.snapshot()
    const rec = snap.agents[req.params.name]
    if (!rec) throw notFound('agent', req.params.name)
    const body = PutAgentBudgetBody.parse(req.body)
    if (body.daily_usd === undefined && body.warn_at_pct === undefined) {
      throw new ApiError(400, 'bad_request', 'provide at least one of daily_usd or warn_at_pct')
    }
    const raw = await readFile(rec.identity_path, 'utf8')
    const updated = applyCostCapsEdit(raw, body)
    const { writeFile, rm, rename } = await import('node:fs/promises')
    const tmpPath = rec.identity_path + '.tmp'
    let parsed
    try {
      await writeFile(tmpPath, updated, 'utf8')
      parsed = await loadIdentity(tmpPath)
    } catch (err) {
      try {
        await rm(tmpPath, { force: true })
      } catch {
        /* ignore */
      }
      throw new ApiError(
        422,
        'identity_invalid',
        `proposed budget edit produced an invalid Identity: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    await rename(tmpPath, rec.identity_path)
    return {
      path: rec.identity_path,
      daily_usd: parsed.frontmatter.cost_caps.daily_usd,
      warn_at_pct: parsed.frontmatter.cost_caps.warn_at_pct,
      applies_on_restart: rec.state === 'running' || rec.state === 'waiting',
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

  // -- skills: preview / install / uninstall / list -----------------------
  // Operator pastes a URL into Settings → runtime fetches the SKILL.md
  // → preview renders → operator supplies env values + selects agents →
  // install commits. See wiki/decisions/2026-05-14-skill-ingest-substrate.md.
  const SkillPreviewBody = z.object({
    source: z.string().min(1),
  })

  fastify.post('/api/v1/skills/preview', async (req) => {
    const parsed = SkillPreviewBody.parse(req.body)
    try {
      return await previewSkillInstall({ source: parsed.source })
    } catch (err) {
      if (err instanceof SkillOrchestratorError) {
        throw new ApiError(
          err.code === 'PARSE_FAILED' ? 422 : 400,
          err.code.toLowerCase(),
          err.message,
        )
      }
      throw err
    }
  })

  const SkillInstallBody = z.object({
    source: z.string().min(1),
    agents: z.array(z.string().min(1)).default([]),
    secrets: z
      .record(z.string(), z.record(z.string(), z.record(z.string(), z.string())))
      .default({}),
    force: z.boolean().optional(),
  })

  fastify.post('/api/v1/skills/install', async (req) => {
    const parsed = SkillInstallBody.parse(req.body)
    const snap = supervisor.snapshot()
    for (const agent of parsed.agents) {
      if (!snap.agents[agent]) throw notFound('agent', agent)
    }
    try {
      return await installSkillFromSource({
        home,
        source: parsed.source,
        agents: parsed.agents,
        secrets: parsed.secrets,
        ...(parsed.force !== undefined ? { force: parsed.force } : {}),
      })
    } catch (err) {
      if (err instanceof SkillOrchestratorError) {
        const status = err.code === 'PARSE_FAILED' || err.code === 'SECRETS_INCOMPLETE' ? 422 : 400
        throw new ApiError(status, err.code.toLowerCase(), err.message)
      }
      throw err
    }
  })

  fastify.get('/api/v1/skills', async () => {
    const entries = await listSkills(home)
    return { items: entries }
  })

  const SkillUninstallBody = z
    .object({
      agents: z.array(z.string().min(1)).default([]),
    })
    .optional()

  fastify.delete<{ Params: { name: string }; Body: { agents?: string[] } | undefined }>(
    '/api/v1/skills/:name',
    async (req) => {
      const parsed = SkillUninstallBody.parse(req.body) ?? { agents: [] }
      const snap = supervisor.snapshot()
      const agentsToScrub = parsed.agents.length > 0 ? parsed.agents : Object.keys(snap.agents)
      try {
        return await uninstallSkillFromHome({
          home,
          name: req.params.name,
          agents: agentsToScrub,
        })
      } catch (err) {
        if (err instanceof SkillOrchestratorError) {
          throw new ApiError(400, err.code.toLowerCase(), err.message)
        }
        throw err
      }
    },
  )

  // -- skill credentials (rotate / update keys) ---------------------------
  // For a given installed skill, surface the per-Agent vault credentials
  // that the install wired up. Update writes a new value into the vault;
  // operator-supplied restart of the affected Agent picks it up. Refuses
  // to update credentials whose name doesn't carry the skill's prefix
  // (defense in depth: skill-management UI never overwrites a non-skill
  // secret like an oauth token).
  fastify.get<{ Params: { name: string } }>('/api/v1/skills/:name/credentials', async (req) => {
    const snap = supervisor.snapshot()
    const liveAgents = Object.entries(snap.agents)
      .filter(([, rec]) => rec.state !== 'archived')
      .map(([n]) => n)
    const groups = await listSkillCredentials({
      home,
      skillName: req.params.name,
      agents: liveAgents,
    })
    return { skill_name: req.params.name, agents: groups }
  })

  const SkillCredentialUpdateBody = z.object({
    value: z.string().min(1),
  })

  fastify.put<{
    Params: { name: string; agent: string; envKey: string }
    Body: { value: string }
  }>('/api/v1/skills/:name/credentials/:agent/:envKey', async (req) => {
    const snap = supervisor.snapshot()
    if (!snap.agents[req.params.agent]) throw notFound('agent', req.params.agent)
    const parsed = SkillCredentialUpdateBody.parse(req.body)
    try {
      return await updateSkillCredential({
        home,
        skillName: req.params.name,
        agentName: req.params.agent,
        envKey: decodeURIComponent(req.params.envKey),
        value: parsed.value,
      })
    } catch (err) {
      if (err instanceof SkillOrchestratorError) {
        const status = err.code === 'SECRETS_INCOMPLETE' ? 422 : 400
        throw new ApiError(status, err.code.toLowerCase(), err.message)
      }
      throw err
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
    /**
     * Source filter. 'other' (default) excludes chat-created tasks;
     * the chat screen already surfaces those. 'chat' returns only
     * chat tasks. 'all' returns everything regardless of source.
     */
    include: z.enum(['other', 'chat', 'all']).optional(),
  })

  fastify.get<{ Params: { name: string } }>('/api/v1/agents/:name/tasks', async (req) => {
    const snap = supervisor.snapshot()
    if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
    const q = ListTasksQuery.parse(req.query)
    const store = new TaskStore(home, req.params.name)
    const all = await store.list()
    const stateFiltered = q.state ? all.filter((t) => t.frontmatter.state === q.state) : all
    const include = q.include ?? 'other'
    const sourceFiltered =
      include === 'all'
        ? stateFiltered
        : stateFiltered.filter((t) => classifyTaskSource(t.body) === include)
    const limit = q.limit ?? 50
    const items = sourceFiltered.slice(0, limit).map(toTaskListDto)
    return {
      items,
      cursor: { next: null, limit: items.length },
    }
  })

  // -- agent task detail (Epic 15 Phase C) --------------------------------
  // Full TaskRecord for one task. Surfaces what list omits: full body,
  // full outcome.summary, full error message, checkpoint info,
  // detector trip context.
  fastify.get<{ Params: { name: string; id: string } }>(
    '/api/v1/agents/:name/tasks/:id',
    async (req) => {
      const snap = supervisor.snapshot()
      if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
      const store = new TaskStore(home, req.params.name)
      const task = await store.get(req.params.id)
      if (!task) {
        throw new ApiError(
          404,
          'task_not_found',
          `No task "${req.params.id}" for agent "${req.params.name}".`,
        )
      }
      return toTaskDetailDto(task)
    },
  )

  // -- agent tasks (Epic 15 Phase C interaction surface) -------------------
  // Lets a user enqueue a synthetic prompt-task for an Agent without
  // dropping into the CLI. The task lands as a pending TaskRecord on
  // disk; the running AgentLoop's task pipe picks it up next tick.
  const CreateTaskBody = z.object({
    title: z.string().min(1).max(200).optional(),
    body: z.string().min(1),
    priority: z.number().int().min(0).max(100).optional(),
    /**
     * Task idempotency mode (Epic 2 / Epic 4.5).
     *   - 'pure': safe-to-rerun, mutating tools blocked. Best for
     *     read-only / report tasks.
     *   - 'checkpointed': may have side effects, restart resumes from
     *     last checkpoint. Best for interactive tasks where the user
     *     expects writes (brain notes, fs writes, pub messages).
     *   - 'destructive': may have side effects, never auto-resume.
     * Defaults to 'checkpointed' for web-sent tasks: the user is
     * consciously asking the agent to do something and would expect
     * mutations to land.
     */
    idempotency: z.enum(['pure', 'checkpointed', 'destructive']).optional(),
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
      idempotency: body.idempotency ?? 'checkpointed',
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

  /**
   * Sync a single note into the FTS5 index. Daemon-side writes go
   * through the BrainStore on disk but the index is owned by the
   * agent process; if the daemon doesn't push the change in, search
   * misses the new content until the next rebuild. Briefly opens
   * the index in write mode (SQLite WAL allows this concurrent with
   * the agent's own writer).
   */
  function syncBrainIndex(
    agentName: string,
    op: 'upsert' | 'delete',
    noteOrSlug: BrainNote | string,
  ): void {
    try {
      const idxPath = agentBrainIndexPath(home, agentName)
      const index = BrainIndex.openAtPath(idxPath)
      try {
        if (op === 'upsert') index.upsert(noteOrSlug as BrainNote)
        else index.delete(noteOrSlug as string)
      } finally {
        index.close()
      }
    } catch {
      // Tolerate: a flaky index op is non-fatal. Search has a list-
      // fallback for missing index, and the next 2200 brain rebuild
      // re-syncs.
    }
  }

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
    syncBrainIndex(req.params.name, 'upsert', note)
    void reply.status(result.created ? 201 : 200)
    return toBrainNoteDto(note)
  })

  // PATCH a brain note. Body { title, body, type?, tags? } overwrites
  // the named slug. The frontmatter `created` is preserved across
  // writes by the BrainStore; `updated` is bumped to now().
  const PatchBrainNoteBody = z.object({
    title: z.string().min(1).max(200),
    body: z.string().min(1),
    type: z.string().min(1).max(40).optional(),
    tags: z.array(z.string().min(1).max(40)).optional(),
  })

  fastify.patch<{ Params: { name: string; slug: string } }>(
    '/api/v1/agents/:name/brain/note/:slug',
    async (req) => {
      const snap = supervisor.snapshot()
      if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
      const store = BrainStore.forAgent(home, req.params.name)
      const existing = await store.tryRead(req.params.slug)
      if (!existing) {
        throw new ApiError(
          404,
          'brain_note_not_found',
          `No note with slug "${req.params.slug}" in agent "${req.params.name}".`,
        )
      }
      const body = PatchBrainNoteBody.parse(req.body)
      const writeArgs: Parameters<typeof store.write>[0] = {
        title: body.title,
        body: body.body,
        slug: req.params.slug,
      }
      if (body.type !== undefined) writeArgs.type = body.type
      if (body.tags !== undefined) writeArgs.tags = body.tags
      await store.write(writeArgs)
      const note = await store.read(req.params.slug)
      syncBrainIndex(req.params.name, 'upsert', note)
      return toBrainNoteDto(note)
    },
  )

  fastify.delete<{ Params: { name: string; slug: string } }>(
    '/api/v1/agents/:name/brain/note/:slug',
    async (req) => {
      const snap = supervisor.snapshot()
      if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
      const store = BrainStore.forAgent(home, req.params.name)
      const existing = await store.tryRead(req.params.slug)
      if (!existing) {
        throw new ApiError(
          404,
          'brain_note_not_found',
          `No note with slug "${req.params.slug}" in agent "${req.params.name}".`,
        )
      }
      await store.delete(req.params.slug)
      syncBrainIndex(req.params.name, 'delete', req.params.slug)
      return { slug: req.params.slug, deleted: true as const }
    },
  )

  // -- agent identity raw read/write (Epic 15 Phase C) --------------------
  // Lets the web client edit identity.md inline. Read returns the raw
  // markdown; write validates that the new content parses as a valid
  // Identity (catches syntax errors before they reach the agent loop)
  // and atomic-writes it. The agent process must be bounced for changes
  // to take effect; the response carries a hint to that effect.
  fastify.get<{ Params: { name: string } }>('/api/v1/agents/:name/identity', async (req) => {
    const snap = supervisor.snapshot()
    const rec = snap.agents[req.params.name]
    if (!rec) throw notFound('agent', req.params.name)
    const raw = await readFile(rec.identity_path, 'utf8')
    return { path: rec.identity_path, content: raw }
  })

  const PutIdentityBody = z.object({
    content: z.string().min(1),
  })

  fastify.put<{ Params: { name: string } }>('/api/v1/agents/:name/identity', async (req) => {
    const snap = supervisor.snapshot()
    const rec = snap.agents[req.params.name]
    if (!rec) throw notFound('agent', req.params.name)
    const body = PutIdentityBody.parse(req.body)
    // Validate the new content parses as a real Identity before
    // overwriting. Bad YAML or missing required fields would crash
    // the agent on next bounce; surfacing the error here keeps the
    // running agent unaffected.
    const { writeFile } = await import('node:fs/promises')
    const tmpPath = rec.identity_path + '.tmp'
    try {
      await writeFile(tmpPath, body.content, 'utf8')
      await loadIdentity(tmpPath)
    } catch (err) {
      try {
        await (await import('node:fs/promises')).rm(tmpPath, { force: true })
      } catch {
        /* ignore */
      }
      throw new ApiError(
        422,
        'identity_invalid',
        `proposed identity failed to parse: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    // Move tmp to final atomically.
    const { rename } = await import('node:fs/promises')
    await rename(tmpPath, rec.identity_path)
    return {
      path: rec.identity_path,
      bytes_written: body.content.length,
      restart_required: true,
    }
  })

  // -- agent model switch (Epic 15 Phase C settings surface) --------------
  // Targeted edit of the Identity's `model.provider` + `model.model_id`
  // (and optional `followup_model_id`). The full identity PUT requires
  // the operator to hand-edit YAML; this endpoint is the click-target
  // for the AgentDetail model picker. We re-write the file via the
  // same validate-tmp-rename flow so a malformed Identity never
  // overwrites a good one.
  const PutAgentModelBody = z.object({
    // Provider names: lowercase + digits + hyphens (e.g. `xai-subscription`)
    // OR the `endpoint:<slug>` shape custom-endpoint providers use.
    // The downstream `listKnownProviders().includes(...)` check is the
    // authoritative gate; this regex just keeps obviously-malformed
    // input out of file paths.
    provider: z.string().regex(/^[a-z0-9:-]+$/),
    model_id: z.string().regex(/^[a-z0-9.-]+$/),
    /** Optional follow-up model id; null clears the field. */
    followup_model_id: z
      .string()
      .regex(/^[a-z0-9.-]+$/)
      .nullable()
      .optional(),
  })

  fastify.put<{ Params: { name: string } }>('/api/v1/agents/:name/model', async (req) => {
    const snap = supervisor.snapshot()
    const rec = snap.agents[req.params.name]
    if (!rec) throw notFound('agent', req.params.name)
    const body = PutAgentModelBody.parse(req.body)
    // Reject unknown providers up front to keep the user out of a
    // broken-identity-then-restart cycle.
    const known = listKnownProviders().map((c) => c.name)
    if (!known.includes(body.provider)) {
      throw new ApiError(
        422,
        'unknown_provider',
        `provider '${body.provider}' is not in the registry. Known: ${known.join(', ')}`,
      )
    }
    const raw = await readFile(rec.identity_path, 'utf8')
    const updated = applyModelEdit(raw, {
      provider: body.provider,
      model_id: body.model_id,
      // Only forward the field when the client included it; omitting
      // leaves the existing value alone, while explicit null clears it.
      ...(body.followup_model_id !== undefined
        ? { followup_model_id: body.followup_model_id }
        : {}),
    })
    const { writeFile, rm, rename } = await import('node:fs/promises')
    const tmpPath = rec.identity_path + '.tmp'
    try {
      await writeFile(tmpPath, updated, 'utf8')
      await loadIdentity(tmpPath)
    } catch (err) {
      try {
        await rm(tmpPath, { force: true })
      } catch {
        /* ignore */
      }
      throw new ApiError(
        422,
        'identity_invalid',
        `proposed model edit produced an invalid Identity: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    await rename(tmpPath, rec.identity_path)
    // Identity changed (model field). Regenerate Fleet.md so the
    // fleet doc reflects the new model + role across the team. The
    // running agent process still has the old binding cached until
    // restart; the fleet doc surfaces what's on disk.
    void regenerateFleet({
      home,
      paths,
      state: supervisor.snapshot(),
      ...(log ? { logger: log.child('fleet') } : {}),
    }).catch((err: unknown) => {
      log?.warn('fleet regeneration failed after model edit', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
    return {
      path: rec.identity_path,
      provider: body.provider,
      model_id: body.model_id,
      followup_model_id: body.followup_model_id ?? null,
      restart_required: true,
    }
  })

  // -- agent avatar --------------------------------------------------------
  // Operators set a glyph (emoji or short text) that the AgentMark
  // renders in place of the default initial letter. Empty string
  // clears the avatar.

  const PutAgentAvatarBody = z.object({
    avatar: z.string().max(8),
  })

  fastify.put<{ Params: { name: string } }>('/api/v1/agents/:name/avatar', async (req) => {
    const snap = supervisor.snapshot()
    const rec = snap.agents[req.params.name]
    if (!rec) throw notFound('agent', req.params.name)
    const body = PutAgentAvatarBody.parse(req.body)
    const raw = await readFile(rec.identity_path, 'utf8')
    const updated = applyAvatarEdit(raw, body.avatar)
    const { writeFile, rm, rename } = await import('node:fs/promises')
    const tmpPath = rec.identity_path + '.tmp'
    try {
      await writeFile(tmpPath, updated, 'utf8')
      await loadIdentity(tmpPath)
    } catch (err) {
      try {
        await rm(tmpPath, { force: true })
      } catch {
        /* ignore */
      }
      throw new ApiError(
        422,
        'identity_invalid',
        `proposed avatar edit produced an invalid Identity: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    await rename(tmpPath, rec.identity_path)
    return {
      path: rec.identity_path,
      avatar: body.avatar.length > 0 ? body.avatar : null,
    }
  })

  // -- agent avatar image (uploaded persona portrait) ----------------------
  // Cropped + client-side-compressed webp posted as base64 lands here.
  // Server decodes, writes to <home>/agents/<name>/avatar.webp.
  // Subsequent loads of agent.avatar_image_url hit the GET handler.

  const PutAgentAvatarImageBody = z.object({
    /** webp/png/jpeg image, ≤256KB after client-side compression. */
    data_base64: z.string().min(1).max(400_000),
    /** "webp" (preferred) or "png" or "jpeg". */
    mime: z.enum(['image/webp', 'image/png', 'image/jpeg']).default('image/webp'),
  })

  fastify.put<{ Params: { name: string } }>(
    '/api/v1/agents/:name/avatar/image',
    async (req, reply) => {
      const snap = supervisor.snapshot()
      const rec = snap.agents[req.params.name]
      if (!rec) throw notFound('agent', req.params.name)
      const body = PutAgentAvatarImageBody.parse(req.body)
      const buf = Buffer.from(body.data_base64, 'base64')
      const { avatarImage } = agentPathsHelper(home, req.params.name)
      const { writeFile, mkdir } = await import('node:fs/promises')
      await mkdir(dirname(avatarImage), { recursive: true })
      await writeFile(avatarImage, buf)
      void reply.status(201)
      return {
        path: avatarImage,
        bytes: buf.byteLength,
        url: `/api/v1/agents/${encodeURIComponent(req.params.name)}/avatar/image?v=${encodeURIComponent(new Date().toISOString())}`,
      }
    },
  )

  fastify.delete<{ Params: { name: string } }>('/api/v1/agents/:name/avatar/image', async (req) => {
    const snap = supervisor.snapshot()
    if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
    const { avatarImage } = agentPathsHelper(home, req.params.name)
    try {
      const { rm } = await import('node:fs/promises')
      await rm(avatarImage, { force: true })
    } catch {
      /* idempotent; ignore */
    }
    return { ok: true as const }
  })

  fastify.get<{ Params: { name: string } }>(
    '/api/v1/agents/:name/avatar/image',
    async (req, reply) => {
      const snap = supervisor.snapshot()
      if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
      const { avatarImage } = agentPathsHelper(home, req.params.name)
      try {
        const { readFile } = await import('node:fs/promises')
        const buf = await readFile(avatarImage)
        void reply.header('cache-control', 'private, max-age=300')
        void reply.header('content-type', 'image/webp')
        return await reply.send(buf)
      } catch {
        throw notFound('avatar_image', req.params.name)
      }
    },
  )

  // -- agent chat (Epic 15 Phase C interaction surface) -------------------
  // Persistent conversation thread with the Agent. Each user message
  // appends to the chat log + starts a task that sees the full prior
  // history; on task completion the assistant message is appended.
  // The web /chat screen polls (and listens to WS task events) to
  // surface assistant turns as they land.
  fastify.get<{ Params: { name: string } }>('/api/v1/agents/:name/chat', async (req) => {
    const snap = supervisor.snapshot()
    if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
    const chat = new ChatStore(home, req.params.name)
    const messages = await chat.list()
    return {
      items: messages.map(toChatMessageDto),
      cursor: { next: null, limit: messages.length },
    }
  })

  const ChatPostBody = z.object({
    content: z.string().min(1),
  })

  fastify.post<{ Params: { name: string } }>('/api/v1/agents/:name/chat', async (req, reply) => {
    const snap = supervisor.snapshot()
    if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
    const body = ChatPostBody.parse(req.body)
    const chat = new ChatStore(home, req.params.name)

    // Append the user turn first so the GET endpoint surfaces it
    // immediately (the web client renders user messages instantly).
    const userMsg = await chat.append({ role: 'user', content: body.content })

    // Build the task body: prior conversation as plain context + the
    // new user turn. The agent's task body is what the model sees as
    // the user message; we concatenate the recent history above the
    // new turn so the agent has continuity. We cap at the most recent
    // 20 messages to keep the prompt bounded.
    const history = await chat.list()
    const recent = history.slice(-21).filter((m) => m.id !== userMsg.id)
    const taskBody = buildChatTaskBody(recent, body.content, req.params.name)

    const taskStore = new TaskStore(home, req.params.name)
    const taskId = newTaskId()
    const title = body.content.slice(0, 60).replace(/\s+/g, ' ').trim() || 'chat message from web'
    const task = newPendingTask({
      id: taskId,
      agent: req.params.name,
      title,
      body: taskBody,
      priority: 0,
      // Chat-originated tasks are classified destructive: a user asking
      // an Agent to do something via chat is implicit authorization to
      // run any tool the Agent has, including destructive ones
      // (schedule.add, shell.run, fs.delete, brain.delete). Earlier
      // 'checkpointed' default blocked legitimate Agent action; the
      // user wouldn't be asking via chat if they didn't want the
      // Agent to act on their behalf.
      idempotency: 'destructive',
      // The legacy `/chat` endpoint targets the implicit default
      // thread. credential_request reads `task.source.kind === 'chat'`
      // to gate dispatch; without this, every chat-created task would
      // present as null-source and the surface check would reject.
      source: { kind: 'chat', chat_id: 'default', message_id: userMsg.id },
    })
    await taskStore.save(task)

    // Start a background watcher: when the task transitions to a
    // terminal state, append the assistant message back into the
    // chat log. We poll the task store rather than reach into the
    // agent process; the daemon watches its own filesystem.
    void watchAndAppendChatReply({
      home,
      agent: req.params.name,
      taskId,
      chat,
      log: log?.child('chat'),
    })

    void reply.status(201)
    return {
      message: toChatMessageDto(userMsg),
      task_id: taskId,
    }
  })

  // -- agent chats (design-system v1.1 multi-chat surface) -----------------
  // Persistent multi-thread chat per Agent. Each Agent has N chats; each
  // chat is a JSONL stream at <home>/agents/<name>/chats/<chat-id>.jsonl.
  // The legacy single-thread `chat.jsonl` surfaces as a chat with id
  // "default" via the MultiChatStore's legacy fallback.
  //
  // Wire format: see toMultiChatThreadDto / toMultiChatMessageDto below.

  fastify.get<{ Params: { name: string } }>('/api/v1/agents/:name/chats', async (req) => {
    const snap = supervisor.snapshot()
    if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
    const store = new MultiChatStore(home, req.params.name)
    const chats = await store.listChats()
    return {
      items: chats.map(toMultiChatThreadDto),
      cursor: { next: null, limit: chats.length },
    }
  })

  const ChatCreateBody = z.object({
    title: z.string().min(1).max(200).optional(),
  })

  fastify.post<{ Params: { name: string } }>('/api/v1/agents/:name/chats', async (req, reply) => {
    const snap = supervisor.snapshot()
    if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
    const body = ChatCreateBody.parse(req.body ?? {})
    const store = new MultiChatStore(home, req.params.name)
    const created = await store.createChat({
      ...(body.title !== undefined ? { title: body.title } : {}),
    })
    broadcastChatEvent('chat.created', req.params.name, created.id, {
      title: created.title,
    })
    void reply.status(201)
    return { chat: toMultiChatThreadDto(created) }
  })

  fastify.get<{ Params: { name: string; chatId: string } }>(
    '/api/v1/agents/:name/chats/:chatId',
    async (req) => {
      const snap = supervisor.snapshot()
      if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
      const store = new MultiChatStore(home, req.params.name)
      const chat = await store.getChat(req.params.chatId)
      if (!chat) throw notFound('chat', req.params.chatId)
      return { chat: toMultiChatThreadDto(chat) }
    },
  )

  const ChatRenameBody = z.object({
    title: z.string().min(1).max(200),
  })

  fastify.patch<{ Params: { name: string; chatId: string } }>(
    '/api/v1/agents/:name/chats/:chatId',
    async (req) => {
      const snap = supervisor.snapshot()
      if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
      const body = ChatRenameBody.parse(req.body)
      const store = new MultiChatStore(home, req.params.name)
      const updated = await store.renameChat(req.params.chatId, body.title)
      broadcastChatEvent('chat.renamed', req.params.name, updated.id, {
        title: updated.title,
      })
      return { chat: toMultiChatThreadDto(updated) }
    },
  )

  const ChatArchiveBody = z.object({
    archived: z.boolean().default(true),
  })

  fastify.post<{ Params: { name: string; chatId: string } }>(
    '/api/v1/agents/:name/chats/:chatId/archive',
    async (req) => {
      const snap = supervisor.snapshot()
      if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
      const body = ChatArchiveBody.parse(req.body ?? {})
      const store = new MultiChatStore(home, req.params.name)
      const updated = await store.archiveChat(req.params.chatId, body.archived)
      broadcastChatEvent('chat.archived', req.params.name, updated.id, {
        archived: updated.archived,
      })
      return { chat: toMultiChatThreadDto(updated) }
    },
  )

  fastify.post<{ Params: { name: string; chatId: string } }>(
    '/api/v1/agents/:name/chats/:chatId/read',
    async (req) => {
      const snap = supervisor.snapshot()
      if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
      const store = new MultiChatStore(home, req.params.name)
      await store.markRead(req.params.chatId)
      broadcastChatEvent('chat.read', req.params.name, req.params.chatId, {})
      return { ok: true }
    },
  )

  fastify.get<{ Params: { name: string; chatId: string } }>(
    '/api/v1/agents/:name/chats/:chatId/messages',
    async (req) => {
      const snap = supervisor.snapshot()
      if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
      const store = new MultiChatStore(home, req.params.name)
      const messages = await store.listMessages(req.params.chatId)
      return {
        items: messages.map(toMultiChatMessageDto),
        cursor: { next: null, limit: messages.length },
      }
    },
  )

  const ChatMessagePostBody = z.object({
    body: z.string().min(1),
    mode: z.enum(['pure', 'checkpointed', 'destructive']).optional(),
    attachments: z
      .array(
        z.object({
          id: z.string(),
          kind: z.enum(['file', 'image']),
          name: z.string(),
          size: z.number().int().nonnegative(),
          mime: z.string(),
        }),
      )
      .optional(),
  })

  fastify.post<{ Params: { name: string; chatId: string } }>(
    '/api/v1/agents/:name/chats/:chatId/messages',
    async (req, reply) => {
      const snap = supervisor.snapshot()
      if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
      const body = ChatMessagePostBody.parse(req.body)
      const store = new MultiChatStore(home, req.params.name)
      const chat = await store.getChat(req.params.chatId)
      if (!chat) throw notFound('chat', req.params.chatId)

      const userMsg = await store.appendMessage({
        chatId: req.params.chatId,
        role: 'user',
        body: body.body,
        ...(body.mode !== undefined ? { mode: body.mode } : {}),
        ...(body.attachments !== undefined ? { attachments: body.attachments } : {}),
      })
      broadcastChatEvent('chat.message', req.params.name, req.params.chatId, {
        message: toMultiChatMessageDto(userMsg),
      })

      // Start an Agent task with the full chat history as context. The
      // assistant reply is appended by watchAndAppendChatThreadReply
      // when the task lands in a terminal state.
      const history = await store.listMessages(req.params.chatId)
      const recent = history
        .slice(-21)
        .filter((m) => m.id !== userMsg.id)
        .map((m) => ({
          id: m.id,
          ts: m.ts,
          role: m.role,
          content: m.body,
          task_id: m.task_id,
        }))
      const taskBody = buildChatTaskBody(recent as ChatMessage[], body.body, req.params.name)

      const taskStore = new TaskStore(home, req.params.name)
      const idempotency = body.mode ?? 'destructive'

      // Continuation primitive (decision:
      // 2026-05-16-task-continuation-primitive): if this agent has a
      // task parked on a wait_for matching this chat thread + sender,
      // resume it instead of starting a fresh task. The chat
      // continuity case is the user replying after the Agent called
      // `await_response` with source_kind='chat' (e.g. "I'll come back
      // when I have an answer from X" then the user replied first).
      const waitingChat = await taskStore.findWaiting({
        kind: 'chat',
        chat_id: req.params.chatId,
      })
      let taskId: string
      if (waitingChat) {
        const continuation = buildContinuationSection({
          source_kind: 'chat',
          sender_label: 'user',
          context_note: waitingChat.frontmatter.wait_for?.context_note ?? '',
          body_text: body.body,
          reply_hint:
            'Reply via `chat_send` ... your assistant reply will be appended automatically when the task completes.',
        })
        const resumed = await taskStore.updateRecord(waitingChat.frontmatter.id, (rec) => ({
          frontmatter: {
            ...rec.frontmatter,
            state: 'pending',
            wait_for: null,
          },
          body: `${rec.body}\n\n${continuation}`,
        }))
        taskId = resumed?.frontmatter.id ?? newTaskId()
        log?.info('chat inbound → resumed parked task', {
          agent: req.params.name,
          task_id: taskId,
          chat_id: req.params.chatId,
        })
      } else {
        taskId = newTaskId()
        const title = body.body.slice(0, 60).replace(/\s+/g, ' ').trim() || 'chat message from web'
        const task = newPendingTask({
          id: taskId,
          agent: req.params.name,
          title,
          body: taskBody,
          priority: 0,
          idempotency,
          // Multi-chat endpoint: the chat_id is the path param. Sets
          // task.source so surface-aware tools (credential_request) can
          // verify this task originated from a 1:1 chat.
          source: { kind: 'chat', chat_id: req.params.chatId, message_id: userMsg.id },
        })
        await taskStore.save(task)
      }

      void watchAndAppendChatThreadReply({
        home,
        agent: req.params.name,
        chatId: req.params.chatId,
        taskId,
        store,
        broadcast: broadcastChatEvent,
        log: log?.child('chat-multi'),
      })

      void reply.status(201)
      return {
        message: toMultiChatMessageDto(userMsg),
        task_id: taskId,
      }
    },
  )

  // Attachments: base64-inline upload. Stays simple at v1.1; we can
  // swap in multipart later if needed for large payloads.
  const AttachmentUploadBody = z.object({
    name: z.string().min(1).max(200),
    mime: z.string().min(1).max(100),
    kind: z.enum(['file', 'image']),
    data_base64: z.string().min(1).max(15_000_000), // ~11MB raw
  })

  fastify.post<{ Params: { name: string; chatId: string } }>(
    '/api/v1/agents/:name/chats/:chatId/attachments',
    async (req, reply) => {
      const snap = supervisor.snapshot()
      if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
      const body = AttachmentUploadBody.parse(req.body)
      const store = new MultiChatStore(home, req.params.name)
      const chat = await store.getChat(req.params.chatId)
      if (!chat) throw notFound('chat', req.params.chatId)

      const data = Buffer.from(body.data_base64, 'base64')
      const ref = await store.saveAttachment({
        chatId: req.params.chatId,
        kind: body.kind,
        name: body.name,
        mime: body.mime,
        data,
      })

      void reply.status(201)
      return {
        attachment: {
          ...ref,
          url: `/api/v1/agents/${req.params.name}/chats/${req.params.chatId}/attachments/${ref.id}/${encodeURIComponent(ref.name)}`,
        },
      }
    },
  )

  fastify.get<{
    Params: { name: string; chatId: string; attId: string; filename: string }
  }>('/api/v1/agents/:name/chats/:chatId/attachments/:attId/:filename', async (req, reply) => {
    const snap = supervisor.snapshot()
    if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
    const store = new MultiChatStore(home, req.params.name)
    const path = store.attachmentPath(req.params.chatId, req.params.attId, req.params.filename)
    try {
      const buf = await (await import('node:fs/promises')).readFile(path)
      void reply.header('cache-control', 'private, max-age=300')
      return await reply.send(buf)
    } catch {
      throw notFound('attachment', req.params.attId)
    }
  })

  // -- credential requests (decision: request_credential substrate) --------
  // Operator-driven resolution of pending credential_request records.
  // Fulfill seals the pasted value directly into the per-Agent vault
  // without the value ever entering the Agent's loop or transit the
  // LLM provider. Decline records the operator's reason. The Agent's
  // running tool dispatch unblocks via the polling waitForResolution
  // helper as soon as the record's state flips.

  function toCredentialRequestDto(rec: CredentialRequest): {
    id: string
    agent: string
    chat_id: string
    state: CredentialRequest['state']
    label: string
    help: string
    kind: CredentialRequest['kind']
    reason: string
    credential_name: string
    created_at: string
    expires_at: string
    fulfilled_at: string | null
    declined_at: string | null
    decline_reason: string | null
    expired_at: string | null
    expired_reason: CredentialRequest['expired_reason']
  } {
    return {
      id: rec.id,
      agent: rec.agent,
      chat_id: rec.chat_id,
      state: rec.state,
      label: rec.label,
      help: rec.help,
      kind: rec.kind,
      reason: rec.reason,
      credential_name: rec.credential_name,
      created_at: rec.created_at,
      expires_at: rec.expires_at,
      fulfilled_at: rec.fulfilled_at,
      declined_at: rec.declined_at,
      decline_reason: rec.decline_reason,
      expired_at: rec.expired_at,
      expired_reason: rec.expired_reason,
    }
  }

  function credentialErrorOrThrow(err: unknown, id: string): never {
    if (err instanceof CredentialRequestError) {
      if (err.code === 'NOT_FOUND') throw notFound('credential_request', id)
      if (err.code === 'INVALID_TRANSITION') {
        throw new ApiError(409, 'credential_request_not_pending', err.message, { id })
      }
    }
    throw err as Error
  }

  fastify.get<{ Params: { name: string }; Querystring: { state?: string; chat_id?: string } }>(
    '/api/v1/agents/:name/credential-requests',
    async (req) => {
      const snap = supervisor.snapshot()
      if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
      const store = new CredentialRequestStore(home)
      const filter: { agent: string; state?: CredentialRequest['state']; chat_id?: string } = {
        agent: req.params.name,
      }
      if (
        req.query.state === 'pending' ||
        req.query.state === 'fulfilled' ||
        req.query.state === 'declined' ||
        req.query.state === 'expired'
      ) {
        filter.state = req.query.state
      }
      if (typeof req.query.chat_id === 'string' && req.query.chat_id.length > 0) {
        filter.chat_id = req.query.chat_id
      }
      const items = await store.list(filter)
      return { items: items.map(toCredentialRequestDto) }
    },
  )

  const FulfillBodySchema = z.object({
    value: z.string().min(1).max(64_000),
  })

  fastify.post<{ Params: { name: string; id: string }; Body: { value: string } }>(
    '/api/v1/agents/:name/credential-requests/:id/fulfill',
    async (req, reply) => {
      const snap = supervisor.snapshot()
      if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
      const parsed = FulfillBodySchema.parse(req.body)
      const store = new CredentialRequestStore(home)
      let rec: CredentialRequest
      try {
        rec = await store.get(req.params.id)
      } catch (err) {
        credentialErrorOrThrow(err, req.params.id)
      }
      if (rec.agent !== req.params.name) {
        throw new ApiError(
          403,
          'credential_request_wrong_agent',
          'credential request does not belong to this agent',
          { id: rec.id, agent: rec.agent },
        )
      }
      if (rec.state !== 'pending') {
        throw new ApiError(
          409,
          'credential_request_not_pending',
          `credential request is in state ${rec.state}; cannot fulfill`,
          { id: rec.id, state: rec.state },
        )
      }

      // Seal the value DIRECTLY to vault. This is the load-bearing
      // privacy property: the value never enters the Agent's loop or
      // LLM provider context. It moves: browser → here → vault.
      const vault = new CredentialVault(home, req.params.name)
      const sealedAt = new Date().toISOString()
      await vault.set(rec.credential_name, {
        value: parsed.value,
        metadata: {
          created_at: sealedAt,
          provider: 'operator',
          notes: `via credential_request ${rec.id}`,
        },
      })

      // Transition the request and broadcast.
      let updated: CredentialRequest
      try {
        updated = await store.transition(rec.id, 'fulfilled', { now: sealedAt })
      } catch (err) {
        credentialErrorOrThrow(err, rec.id)
      }

      // Automatic post-fulfillment guidance (lifecycle hardening 2026-05-15).
      // Appends a second system message immediately after the card so the
      // agent sees the exact required next steps without having to
      // remember prompt rule #8 across turns. This directly addresses the
      // fuzzy-bannana failure where the agent re-asked, slept, complained,
      // and shell-thrashed instead of doing credential_has + final reply.
      try {
        const chats = new MultiChatStore(home, rec.agent)
        const guidance = `credential_request ${rec.id} for "${rec.credential_name}" has been fulfilled by the operator and sealed to your vault. Your *required* next actions in this task are: (1) call credential_has for "${rec.credential_name}" to verify the value is present, (2) produce a final assistant reply to the original user request confirming you now have the credential and it is verified on disk. Do not emit another credential_request for this name. Use http_request with bearer_credential (or the appropriate MCP skill) for any consumption. The vault is opaque — do not shell_run or fs_* to locate it.`
        await chats.appendMessage({
          chatId: rec.chat_id,
          role: 'system',
          body: guidance,
          kind: null,
          taskId: null,
        })
        // The append + the broadcastChatEvent below is sufficient for
        // the web UI to eventually see the guidance. The agent will pick
        // it up on its next chat read in the loop.
      } catch {
        // Guidance is best-effort; the core fulfillment (vault seal +
        // state transition + card) has already succeeded.
      }

      broadcastChatEvent('credential_request.fulfilled', rec.agent, rec.chat_id, {
        request_id: rec.id,
        credential_name: rec.credential_name,
        fulfilled_at: sealedAt,
        envelope: toEnvelopeV1(updated),
      })
      void reply.status(200)
      return toCredentialRequestDto(updated)
    },
  )

  const DeclineBodySchema = z
    .object({
      reason: z.string().max(2000).optional(),
    })
    .strict()
    .partial()

  fastify.post<{
    Params: { name: string; id: string }
    Body: { reason?: string }
  }>('/api/v1/agents/:name/credential-requests/:id/decline', async (req, reply) => {
    const snap = supervisor.snapshot()
    if (!snap.agents[req.params.name]) throw notFound('agent', req.params.name)
    const parsed = DeclineBodySchema.parse(req.body)
    const store = new CredentialRequestStore(home)
    let rec: CredentialRequest
    try {
      rec = await store.get(req.params.id)
    } catch (err) {
      credentialErrorOrThrow(err, req.params.id)
    }
    if (rec.agent !== req.params.name) {
      throw new ApiError(
        403,
        'credential_request_wrong_agent',
        'credential request does not belong to this agent',
        { id: rec.id, agent: rec.agent },
      )
    }
    if (rec.state !== 'pending') {
      throw new ApiError(
        409,
        'credential_request_not_pending',
        `credential request is in state ${rec.state}; cannot decline`,
        { id: rec.id, state: rec.state },
      )
    }
    const declinedAt = new Date().toISOString()
    let updated: CredentialRequest
    try {
      const transitionFields: { now: string; decline_reason?: string } = { now: declinedAt }
      if (parsed.reason !== undefined && parsed.reason.length > 0) {
        transitionFields.decline_reason = parsed.reason
      }
      updated = await store.transition(rec.id, 'declined', transitionFields)
    } catch (err) {
      credentialErrorOrThrow(err, rec.id)
    }
    broadcastChatEvent('credential_request.declined', rec.agent, rec.chat_id, {
      request_id: rec.id,
      credential_name: rec.credential_name,
      declined_at: declinedAt,
      decline_reason: updated.decline_reason,
      envelope: toEnvelopeV1(updated),
    })
    void reply.status(200)
    return toCredentialRequestDto(updated)
  })

  function broadcastChatEvent(
    event:
      | 'chat.message'
      | 'chat.created'
      | 'chat.renamed'
      | 'chat.archived'
      | 'chat.read'
      | 'chat.audit_flag'
      | 'credential_request.created'
      | 'credential_request.fulfilled'
      | 'credential_request.declined'
      | 'credential_request.expired',
    agentName: string,
    chatId: string,
    payload: Record<string, unknown>,
  ): void {
    const msg = JSON.stringify({
      event,
      occurred_at: new Date().toISOString(),
      payload: {
        agent: agentName,
        chat_id: chatId,
        ...payload,
      },
    })
    for (const c of wsClients) c.send(msg)
  }

  // -- fleet ---------------------------------------------------------------
  // The supervisor-maintained Fleet.md gives every consumer a
  // unified view of who's on this install. Auto-regenerated by the
  // supervisor on agent / identity / model changes; agents inject
  // it into their system prompt at task start. The web Studio reads
  // it through this endpoint for the sidebar.
  fastify.get('/api/v1/fleet', async () => {
    const snap = supervisor.snapshot()
    let markdown = ''
    try {
      markdown = await (await import('node:fs/promises')).readFile(fleetPath(home), 'utf8')
    } catch {
      // File may not exist yet on a brand-new install; force a fresh
      // generation rather than returning an empty doc.
      try {
        await regenerateFleet({
          home,
          paths,
          state: snap,
          ...(log ? { logger: log.child('fleet') } : {}),
        })
        markdown = await (await import('node:fs/promises')).readFile(fleetPath(home), 'utf8')
      } catch (err) {
        log?.warn('fleet read+generate failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return {
      markdown,
      path: fleetPath(home),
      generated_at: extractGeneratedAt(markdown),
    }
  })

  // -- pubs ----------------------------------------------------------------
  // Read-only Studio surface (PR1). Lists pubs from the supervisor
  // snapshot, exposes per-pub metadata + members, and proxies the
  // rolling message buffer from the supervisor's bridge PubClient.
  // POST send/react land in PR2/PR3.

  fastify.get('/api/v1/pubs', () => {
    const snap = supervisor.snapshot()
    const items = Object.values(snap.pubs).map((p) => ({
      name: p.name,
      state: p.state,
      port: p.port,
      pid: p.pid,
      created_at: p.created_at,
      errored_at: p.errored_at,
      errored_reason: p.errored_reason,
    }))
    return { items, cursor: { next: null, limit: items.length } }
  })

  // -- create a pub (Studio creation flow) ---------------------------------
  // Creates a new pub-server, writes pubs.md for each chosen agent (the
  // file AgentProcess reads at boot to attach wake sources), and
  // restarts those agents so they re-attach against the new pub.
  // Agents must already have pub.identity set in their Identity ...
  // we don't auto-provision pub identities here.
  const PubCreateBody = z.object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/, {
        message: 'pub name must be lowercase alphanumeric + dashes',
      }),
    members: z.array(z.string().min(1)).min(1).max(50),
    description: z.string().max(280).optional(),
  })

  fastify.post('/api/v1/pubs', async (req, reply) => {
    const body = PubCreateBody.parse(req.body)
    const snap = supervisor.snapshot()
    if (snap.pubs[body.name]) {
      throw new ApiError(409, 'pub_exists', `pub "${body.name}" already exists`)
    }

    // Validate every named agent exists AND has pub.identity set so
    // its wake-source attach loop will actually fire.
    const unknown: string[] = []
    const unprovisioned: string[] = []
    for (const m of body.members) {
      const rec = snap.agents[m]
      if (!rec) {
        unknown.push(m)
        continue
      }
      try {
        const id = await loadIdentity(rec.identity_path)
        if (!id.frontmatter.pub?.identity) unprovisioned.push(m)
      } catch {
        unprovisioned.push(m)
      }
    }
    if (unknown.length > 0) {
      throw new ApiError(404, 'agent_not_found', `unknown Agent(s): ${unknown.join(', ')}`)
    }
    if (unprovisioned.length > 0) {
      throw new ApiError(
        409,
        'agent_pub_unprovisioned',
        `Agent(s) missing pub.identity in Identity (run identity provisioning first): ${unprovisioned.join(', ')}`,
      )
    }

    // Create + start the pub.
    const created = await supervisor.createPub(body.name, {
      ...(body.description !== undefined ? { description: body.description } : {}),
    })
    try {
      await supervisor.startPub(body.name)
    } catch (err) {
      throw new ApiError(
        500,
        'pub_start_failed',
        `pub record created but startup failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    // Settle: the pub-server is launched but its HTTP listener may
    // not yet be bound. The existing supervisor recoverState path
    // waits 800ms after pub launch for the same reason. Wait + ping
    // /agents/me-style endpoint until it responds before we try to
    // register anyone.
    {
      const baseUrl = `http://127.0.0.1:${String(created.port)}`
      const deadline = Date.now() + 5_000
      let ready = false
      while (Date.now() < deadline) {
        try {
          // GET / on a pub-server returns 404 once bound; that is the
          // proof we want. Any fetch resolution (any status) means the
          // listener is up.
          await fetch(baseUrl, { method: 'GET' })
          ready = true
          break
        } catch {
          await new Promise((r) => setTimeout(r, 200))
        }
      }
      if (!ready) {
        throw new ApiError(
          500,
          'pub_not_ready',
          `pub started but HTTP listener never bound on ${baseUrl} after 5s`,
        )
      }
    }

    // Register identities with the brand-new pub.
    //
    // The pub-server starts empty: no agents and no user are
    // registered until we explicitly enroll them. Without this step
    // (1) the supervisor's pub bridge cannot mintToken to fetch the
    // room state, so the web client sees an empty members list +
    // never-ending "no messages" empty state; (2) the member Agents
    // cannot attach a wake source when they restart, so the room
    // stays cold. Use the existing ensureRegistered helper that
    // GETs /agents/me first and only registers on 404, so idempotent
    // re-creates of a same-named pub do not blow up.
    const newPubPaths = pubPaths(home, body.name)
    const newPubSecrets = await readPubSecrets({
      adminSecret: newPubPaths.adminSecret,
      signingKey: newPubPaths.signingKey,
    })
    const newPubClient = createIdentityClient({
      baseUrl: `http://127.0.0.1:${String(created.port)}`,
    })
    const userCredPath = homePaths(home).configUserPubSecret
    try {
      const userCred = await readCredentialFile(userCredPath)
      const updated = await ensureRegistered(
        newPubClient,
        userCred,
        newPubSecrets.adminSecret,
        body.name,
      )
      await writeCredentialFile(userCredPath, updated)
    } catch (err) {
      throw new ApiError(
        500,
        'user_pub_register_failed',
        `pub started but user registration failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    for (const m of body.members) {
      const agentCredPath = agentPathsHelper(home, m).pubSecret
      try {
        const cred = await readCredentialFile(agentCredPath)
        const updated = await ensureRegistered(
          newPubClient,
          cred,
          newPubSecrets.adminSecret,
          body.name,
        )
        await writeCredentialFile(agentCredPath, updated)
      } catch (err) {
        throw new ApiError(
          500,
          'agent_pub_register_failed',
          `pub started but ${m} registration failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    // Add the new pub to each member's pubs.md and restart so they
    // attach a wake source. Restarts happen sequentially to avoid
    // bunching SIGTERMs at the supervisor.
    //
    // `seedIfMissing` carries the Agent's *current effective*
    // membership (resolved from identity.md fallback or
    // "all running pubs" default) so first-time pubs.md creation
    // does not drop pubs the Agent was already implicitly in.
    const { addPubToAgentFile } = await import('../agent/pubs-file.js')
    const postCreateSnap = supervisor.snapshot()
    const runningPubsBeforeNew = Object.values(postCreateSnap.pubs)
      .filter((p) => p.state === 'running' && p.name !== body.name)
      .map((p) => p.name)
    const restarted: { name: string; was_running: boolean }[] = []
    for (const m of body.members) {
      const rec = snap.agents[m]
      if (!rec) continue
      const paths = agentPathsHelper(home, m)
      let seedIfMissing: string[] = runningPubsBeforeNew
      try {
        const id = await loadIdentity(rec.identity_path)
        const fromIdentity = id.frontmatter.pub?.member_of ?? []
        if (fromIdentity.length > 0) seedIfMissing = fromIdentity
      } catch {
        /* fall back to running-pubs default */
      }
      try {
        await addPubToAgentFile(paths.pubsFile, m, body.name, { seedIfMissing })
      } catch (err) {
        throw new ApiError(
          500,
          'pubs_file_write_failed',
          `wrote pub record but failed updating ${m}'s pubs.md: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      const wasRunning = rec.state === 'running' || rec.state === 'waiting'
      if (wasRunning) {
        try {
          await supervisor.stopAgent(m, 'studio_membership_change')
          await supervisor.startAgent(m)
          restarted.push({ name: m, was_running: true })
        } catch (err) {
          // Membership is written; failed restart leaves operator to
          // bring the agent back manually. Surface in the response so
          // the UI can flag it.
          restarted.push({ name: m, was_running: true })
          log?.warn('agent restart failed after room membership change', {
            agent: m,
            pub: body.name,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      } else {
        restarted.push({ name: m, was_running: false })
      }
    }

    void reply.status(201)
    return {
      name: body.name,
      port: created.port,
      pub_md_path: created.pub_md_path,
      members: body.members,
      restarted,
    }
  })

  // -- patch a pub (edit guests) -------------------------------------------
  // Per Doug 2026-05-13: operators can add/remove "guests" from a Room
  // after creation, same as a chat group. Remove just drops the pub
  // from the agent's pubs.md and restarts them (the pub-server roster
  // entry stays since OpenPub has no agent-deletion endpoint we can
  // safely call; the agent simply stops attaching a wake source and
  // no longer receives the room's traffic).
  const PubPatchBody = z.object({
    add_guests: z.array(z.string().min(1)).max(50).optional(),
    remove_guests: z.array(z.string().min(1)).max(50).optional(),
  })

  fastify.patch<{ Params: { name: string } }>('/api/v1/pubs/:name', async (req) => {
    const pubName = req.params.name
    const snap = supervisor.snapshot()
    const pubRec = snap.pubs[pubName]
    if (!pubRec) throw notFound('pub', pubName)
    const body = PubPatchBody.parse(req.body)
    const adds = body.add_guests ?? []
    const removes = body.remove_guests ?? []
    if (adds.length === 0 && removes.length === 0) {
      throw new ApiError(400, 'bad_request', 'provide at least one of add_guests or remove_guests')
    }
    const overlap = adds.filter((a) => removes.includes(a))
    if (overlap.length > 0) {
      throw new ApiError(
        400,
        'bad_request',
        `agents listed in both add and remove: ${overlap.join(', ')}`,
      )
    }
    for (const m of [...adds, ...removes]) {
      if (!snap.agents[m]) throw notFound('agent', m)
    }

    const { addPubToAgentFile, removePubFromAgentFile } = await import('../agent/pubs-file.js')

    const restarted: { name: string; was_running: boolean }[] = []

    // Adds: register at the pub, then write pubs.md, then restart.
    if (adds.length > 0) {
      const newPubPaths = pubPaths(home, pubName)
      const newPubSecrets = await readPubSecrets({
        adminSecret: newPubPaths.adminSecret,
        signingKey: newPubPaths.signingKey,
      })
      const client = createIdentityClient({
        baseUrl: `http://127.0.0.1:${String(pubRec.port)}`,
      })
      const runningPubsExcludingTarget = Object.values(snap.pubs)
        .filter((p) => p.state === 'running' && p.name !== pubName)
        .map((p) => p.name)
      for (const m of adds) {
        const rec = snap.agents[m]
        if (!rec) continue
        const credPath = agentPathsHelper(home, m).pubSecret
        try {
          const cred = await readCredentialFile(credPath)
          const updated = await ensureRegistered(client, cred, newPubSecrets.adminSecret, pubName)
          await writeCredentialFile(credPath, updated)
        } catch (err) {
          throw new ApiError(
            500,
            'agent_pub_register_failed',
            `${m} could not be registered at ${pubName}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        const seedIfMissing: string[] = runningPubsExcludingTarget
        try {
          await addPubToAgentFile(agentPathsHelper(home, m).pubsFile, m, pubName, {
            seedIfMissing,
          })
        } catch (err) {
          throw new ApiError(
            500,
            'pubs_file_write_failed',
            `wrote registration but failed updating ${m}'s pubs.md: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        const wasRunning = rec.state === 'running' || rec.state === 'waiting'
        if (wasRunning) {
          try {
            await supervisor.stopAgent(m, 'room_membership_change')
            await supervisor.startAgent(m)
          } catch (err) {
            log?.warn('agent restart failed after room membership change', {
              agent: m,
              pub: pubName,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
        restarted.push({ name: m, was_running: wasRunning })
      }
    }

    // Removes: drop the pub from pubs.md, restart. No pub-server
    // call ... OpenPub has no per-agent deletion endpoint.
    if (removes.length > 0) {
      for (const m of removes) {
        const rec = snap.agents[m]
        if (!rec) continue
        try {
          await removePubFromAgentFile(agentPathsHelper(home, m).pubsFile, m, pubName)
        } catch (err) {
          throw new ApiError(
            500,
            'pubs_file_write_failed',
            `failed updating ${m}'s pubs.md: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        const wasRunning = rec.state === 'running' || rec.state === 'waiting'
        if (wasRunning) {
          try {
            await supervisor.stopAgent(m, 'room_membership_change')
            await supervisor.startAgent(m)
          } catch (err) {
            log?.warn('agent restart failed after room membership change', {
              agent: m,
              pub: pubName,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
        restarted.push({ name: m, was_running: wasRunning })
      }
    }

    return {
      name: pubName,
      added: adds,
      removed: removes,
      restarted,
    }
  })

  // -- destroy a pub -------------------------------------------------------
  // Requires a typed confirmation in the body so a stray fetch can't
  // wipe a room. Refuses to destroy the canonical "studio" pub.
  // Updates every affected agent's pubs.md and restarts them before
  // tearing the pub-server down so they don't flap reconnecting to a
  // vanished pub.
  const PubDestroyBody = z.object({
    confirm: z.literal('DESTROY'),
  })

  fastify.delete<{ Params: { name: string } }>('/api/v1/pubs/:name', async (req) => {
    const pubName = req.params.name
    if (pubName === 'studio') {
      throw new ApiError(
        409,
        'cannot_destroy_studio',
        'the canonical "studio" pub cannot be destroyed',
      )
    }
    const snap = supervisor.snapshot()
    if (!snap.pubs[pubName]) throw notFound('pub', pubName)
    // Parse a confirmation token from EITHER the JSON body OR a
    // query string `?confirm=DESTROY`. The query form is the
    // ergonomic path for fetch() callers that don't want to set a
    // body on DELETE.
    const query = req.query as Record<string, string | undefined>
    if (query['confirm'] !== 'DESTROY') {
      try {
        PubDestroyBody.parse(req.body)
      } catch {
        throw new ApiError(
          400,
          'confirm_required',
          'destructive ... pass {"confirm":"DESTROY"} in the body or ?confirm=DESTROY',
        )
      }
    }

    const { removePubFromAgentFile } = await import('../agent/pubs-file.js')

    // Walk every agent and drop pubName from their pubs.md if
    // listed. Restart agents that lose a membership so their wake
    // sources detach before the pub-server disappears.
    const restarted: { name: string; was_running: boolean }[] = []
    for (const [agentName, rec] of Object.entries(snap.agents)) {
      try {
        const after = await removePubFromAgentFile(
          agentPathsHelper(home, agentName).pubsFile,
          agentName,
          pubName,
        )
        if (after === null) continue // pubs.md absent → fallthrough membership; nothing to update
      } catch (err) {
        log?.warn('failed clearing pub from pubs.md during destroy', {
          agent: agentName,
          pub: pubName,
          error: err instanceof Error ? err.message : String(err),
        })
        continue
      }
      const wasRunning = rec.state === 'running' || rec.state === 'waiting'
      if (wasRunning) {
        try {
          await supervisor.stopAgent(agentName, 'pub_destroyed')
          await supervisor.startAgent(agentName)
        } catch (err) {
          log?.warn('agent restart failed after pub destroy', {
            agent: agentName,
            pub: pubName,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      restarted.push({ name: agentName, was_running: wasRunning })
    }

    await supervisor.removePub(pubName)
    return { name: pubName, destroyed: true, restarted }
  })

  const PubMessagesQuery = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    since: z.string().optional(),
  })

  fastify.get<{ Params: { name: string } }>('/api/v1/pubs/:name', async (req) => {
    const snap = supervisor.snapshot()
    const pub = snap.pubs[req.params.name]
    if (!pub) throw notFound('pub', req.params.name)
    let members: { agent_id: string; display_name: string; status: string }[] = []
    let atmosphere: { tone?: string; energy?: string; active_topics?: string[] } | null = null
    try {
      // Build the members list from two sources merged:
      //
      //  1. The live `room_state.agents_present` (whoever is currently
      //     subscribed via WebSocket ... typically includes the user).
      //  2. The pub's `roster.json` (every Agent ever created against
      //     this pub).
      //
      // OpenPub does not always re-broadcast `room_state` to the
      // bridge when a new agent connects after the bridge, so reading
      // only `room_state` understates the room. Merging with roster
      // gives us the complete-roster perspective the architecture
      // expects (per the multi-agent chatter lessons memory).
      //
      // Also: filter out the OpenPub Bartender (`agent_id: 'house'`).
      // It is a server-side moderator persona meant for greeting
      // visitors in public pubs; in the Studio (the install's
      // default private-team pub) it is just noise.
      const room = await pubBridge.getRoomState(req.params.name)
      const roster = await readRoster(home, req.params.name)
      const presentIds = new Set<string>()
      const merged = new Map<string, { agent_id: string; display_name: string; status: string }>()
      if (room) {
        for (const a of room.agents_present) {
          if (a.agent_id === 'house') continue
          presentIds.add(a.agent_id)
          merged.set(a.agent_id, {
            agent_id: a.agent_id,
            display_name: a.display_name,
            status: a.status || 'active',
          })
        }
        atmosphere = room.atmosphere ?? null
      }
      const runningAgentIds = new Set<string>()
      const knownLiveAgentNames = new Set<string>()
      for (const ag of Object.values(snap.agents)) {
        if (ag.state === 'archived') continue
        knownLiveAgentNames.add(ag.name)
        if (ag.state === 'running') runningAgentIds.add(ag.name)
      }
      for (const r of roster.agents) {
        if (merged.has(r.agent_id)) continue
        // Drop roster entries whose agent_name no longer maps to a
        // live (non-archived) Agent. Covers: deleted Agents, archived
        // Agents (renamed in supervisor state), and orphaned roster
        // rows from earlier broken create attempts.
        if (!knownLiveAgentNames.has(r.agent_name)) continue
        merged.set(r.agent_id, {
          agent_id: r.agent_id,
          display_name: r.display_name,
          status: runningAgentIds.has(r.agent_name) ? 'idle' : 'offline',
        })
      }
      members = Array.from(merged.values())
    } catch (err) {
      if (err instanceof PubBridgeError) {
        log?.warn('pub bridge unavailable', { pub: req.params.name, code: err.code })
      } else {
        throw err
      }
    }
    return {
      name: pub.name,
      state: pub.state,
      port: pub.port,
      pid: pub.pid,
      created_at: pub.created_at,
      errored_at: pub.errored_at,
      errored_reason: pub.errored_reason,
      members,
      atmosphere,
    }
  })

  fastify.get<{ Params: { name: string } }>('/api/v1/pubs/:name/messages', async (req, reply) => {
    const snap = supervisor.snapshot()
    const pub = snap.pubs[req.params.name]
    if (!pub) throw notFound('pub', req.params.name)
    const q = PubMessagesQuery.parse(req.query)
    try {
      const items =
        (await pubBridge.getMessages(req.params.name, {
          ...(q.limit !== undefined ? { limit: q.limit } : {}),
          since: q.since ?? null,
        })) ?? []
      const reactions = await pubBridge.getReactions(req.params.name)
      return {
        items: items.map((m) => ({
          message_id: m.message_id,
          agent_id: m.agent_id,
          display_name: m.display_name,
          timestamp: m.timestamp,
          content: m.content,
          type: m.type,
          mentions: m.mentions,
          mention_names: m.mention_names,
          directed_to: m.directed_to,
          reply_to: m.reply_to,
          reactions: (reactions.get(m.message_id) ?? []).map((r) => ({
            agent_id: r.agent_id,
            display_name: r.display_name,
            emoji: r.emoji,
            timestamp: r.timestamp,
          })),
        })),
        cursor: { next: null, limit: items.length },
      }
    } catch (err) {
      if (err instanceof PubBridgeError) {
        void reply.status(503)
        return {
          items: [],
          cursor: { next: null, limit: 0 },
          error: { code: err.code, message: err.message },
        }
      }
      throw err
    }
  })

  // Per-attachment + total-message caps. Attachments land in
  // <home>/commons/scratch/attachments/<id>/<filename> so they show
  // up on the agents' /commons/scratch/... virtual prefix and are
  // readable via fs.read.
  const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024 // 5 MB per file
  const ATTACHMENTS_MAX_PER_MESSAGE = 6
  const TEXT_INLINE_MAX_BYTES = 8 * 1024 // inline text content under 8 KB so the agent sees it without an fs.read

  const PubAttachmentInput = z.object({
    filename: z
      .string()
      .min(1)
      .max(255)
      .refine((s) => !s.includes('/') && !s.includes('\\') && !s.includes('..'), {
        message: 'filename must not contain path separators or ..',
      }),
    content_type: z.string().min(1).max(200),
    base64: z.string().min(1),
  })

  const PubSendBody = z.object({
    content: z.string().min(1).max(8000),
    mentions: z.array(z.string()).optional(),
    reply_to: z.string().nullable().optional(),
    attachments: z.array(PubAttachmentInput).max(ATTACHMENTS_MAX_PER_MESSAGE).optional(),
  })

  // GET attachment files written by the POST /pubs/:name/messages
  // handler above. The user's web app uses this to render image
  // previews + offer downloads inline in the Studio timeline; agents
  // read the same files through their /commons/scratch/... virtual
  // prefix via fs.read.
  fastify.get<{ Params: { attId: string; filename: string } }>(
    '/api/v1/pubs/attachments/:attId/:filename',
    async (req, reply) => {
      // Path-component validation: attId must be hex-id-only (no /, no ..)
      // and filename must not escape. The POST writer enforces these on
      // ingest; we double-check here to keep this route safe even if a
      // future writer regresses.
      if (!/^[a-f0-9]{6,32}$/i.test(req.params.attId)) {
        throw notFound('attachment', req.params.attId)
      }
      if (
        req.params.filename.includes('/') ||
        req.params.filename.includes('\\') ||
        req.params.filename.includes('..')
      ) {
        throw notFound('attachment', req.params.filename)
      }
      const filePath = join(
        home,
        'commons',
        'scratch',
        'attachments',
        req.params.attId,
        req.params.filename,
      )
      const { stat, readFile } = await import('node:fs/promises')
      let st
      try {
        st = await stat(filePath)
      } catch {
        throw notFound('attachment', req.params.filename)
      }
      if (!st.isFile()) {
        throw notFound('attachment', req.params.filename)
      }
      const buf = await readFile(filePath)
      const ext = req.params.filename.split('.').pop()?.toLowerCase() ?? ''
      const mime = inferMimeFromExt(ext)
      void reply.header('content-type', mime)
      void reply.header('cache-control', 'private, max-age=3600')
      void reply.send(buf)
    },
  )

  fastify.post<{ Params: { name: string } }>('/api/v1/pubs/:name/messages', async (req, reply) => {
    const snap = supervisor.snapshot()
    if (!snap.pubs[req.params.name]) throw notFound('pub', req.params.name)
    const body = PubSendBody.parse(req.body)

    // Attachments (if any) are written under
    // <home>/commons/scratch/attachments/<short>/. Agents see the
    // path via the /commons/scratch/... virtual prefix and can read
    // text files via fs.read. We also inline small text payloads in
    // the message itself so the agent has the content without a
    // tool round-trip.
    let renderedContent = body.content
    if (body.attachments && body.attachments.length > 0) {
      const attachmentDir = `attachments/${newAttachmentId()}`
      const absDir = join(home, 'commons', 'scratch', attachmentDir)
      const { mkdir, writeFile } = await import('node:fs/promises')
      await mkdir(absDir, { recursive: true })
      const lines: string[] = ['Attached files:']
      const inlines: string[] = []
      for (const att of body.attachments) {
        const buf = Buffer.from(att.base64, 'base64')
        if (buf.byteLength > ATTACHMENT_MAX_BYTES) {
          throw new ApiError(
            413,
            'attachment_too_large',
            `attachment "${att.filename}" is ${String(buf.byteLength)} bytes, max ${String(ATTACHMENT_MAX_BYTES)}`,
          )
        }
        await writeFile(join(absDir, att.filename), buf)
        const virtualPath = `/commons/scratch/${attachmentDir}/${att.filename}`
        lines.push(`- ${virtualPath} (${att.content_type}, ${formatBytes(buf.byteLength)})`)
        // Inline text under the threshold so agents see it directly.
        const isText =
          att.content_type.startsWith('text/') ||
          /\b(json|yaml|yml|markdown|md|csv|xml)\b/i.test(att.content_type) ||
          /\b(application\/(json|xml|x-yaml|yaml))/i.test(att.content_type)
        if (isText && buf.byteLength <= TEXT_INLINE_MAX_BYTES) {
          inlines.push(
            `\n--- ${att.filename} (inline) ---\n${buf.toString('utf8')}\n--- end ${att.filename} ---`,
          )
        }
      }
      renderedContent = `${lines.join('\n')}${inlines.length > 0 ? `\n${inlines.join('\n')}` : ''}\n\n${body.content}`
    }

    try {
      const result = await pubBridge.send(req.params.name, {
        content: renderedContent,
        ...(body.mentions !== undefined ? { mentions: body.mentions } : {}),
        ...(body.reply_to !== undefined ? { reply_to: body.reply_to } : {}),
      })
      void reply.status(201)
      return result
    } catch (err) {
      if (err instanceof PubBridgeError) {
        void reply.status(err.code === 'pub_not_running' ? 409 : 503)
        return { error: { code: err.code, message: err.message } }
      }
      throw err
    }
  })

  const PubReactBody = z.object({
    message_id: z.string().min(1),
    emoji: z.string().min(1).max(32),
  })

  fastify.post<{ Params: { name: string } }>('/api/v1/pubs/:name/reactions', async (req, reply) => {
    const snap = supervisor.snapshot()
    if (!snap.pubs[req.params.name]) throw notFound('pub', req.params.name)
    const body = PubReactBody.parse(req.body)
    try {
      await pubBridge.react(req.params.name, body.message_id, body.emoji)
      void reply.status(204)
      return null
    } catch (err) {
      if (err instanceof PubBridgeError) {
        void reply.status(err.code === 'pub_not_running' ? 409 : 503)
        return { error: { code: err.code, message: err.message } }
      }
      throw err
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

  // -- onboarding (Epic 14 + Epic 15 Phase B Card Stack) --------------------
  // Server-side state machine for the conversational onboarding flow.
  // The web app calls these endpoints to drive a question/answer
  // conversation, see a preview, and confirm to build an Agent.
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

    // Default-pick policy: if the caller did not name a provider/model
    // (CLI legacy behavior, or a misconfigured client), walk
    // listKnownProviders() and pick the first one whose env key is set
    // (or whose key is optional, e.g. local Ollama). The hardcoded
    // anthropic+opus default in earlier versions failed every install
    // that used a different provider; auto-default to the first
    // configured one and let the operator override via the picker.
    const env = await loadRuntimeEnv(defaultRuntimeEnvPath())
    let providerName = body.provider
    let modelId = body.model
    if (!providerName) {
      const configured = listKnownProviders().find((p) => {
        if (p.keyOptional) return true
        const v = env[p.defaultEnvKey] ?? ''
        return v.length > 0
      })
      if (!configured) {
        throw new ApiError(
          503,
          'no_provider_configured',
          'No LLM provider has an API key configured. Visit Settings → Providers to add one before starting onboarding.',
        )
      }
      providerName = configured.name
    }

    const { loadScriptFile } = await import('../onboarding/script-loader.js')
    const { resolveProvider } = await import('../llm/registry.js')
    const { OnboardingSession } = await import('../onboarding/session.js')
    const { newRequestId: newId } = await import('./errors.js')

    if (!modelId) {
      // Pull from pricing table the first canonical model for this
      // provider so a caller can omit `model` entirely and still get
      // a sensible default.
      const pricing = loadPricingTable()
      const candidates = Object.keys(pricing.models)
        .filter((k) => k.startsWith(providerName + '/'))
        .map((k) => k.slice(providerName.length + 1))
        .sort()
      modelId = candidates[0] ?? ''
      if (!modelId) {
        throw new ApiError(
          400,
          'model_required',
          `Provider "${providerName}" has no default model registered. Pass an explicit model id.`,
        )
      }
    }

    const cliDir = dirname(fileURLToPath(import.meta.url))
    const defaultScriptPath = join(cliDir, '..', 'onboarding', 'scripts', 'default-v2.yaml')
    const scriptPath = body.script ?? defaultScriptPath
    const script = await loadScriptFile(scriptPath)
    let provider
    try {
      provider = await resolveProvider({ providerName, home })
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

  const ConfirmBodySchema = z
    .object({
      /**
       * Operator-selected Capability ids to override the auto-applied
       * defaults from `preview.capabilities`. When provided, every id
       * must appear in the preview's suggestions (no arbitrary
       * injection from the wire). When omitted, the auto-applied
       * default_on set from the preview's handoff stays as-is.
       */
      selected_capabilities: z.array(z.string().min(1)).optional(),
    })
    .optional()

  fastify.post<{ Params: { id: string }; Body: unknown }>(
    '/api/v1/onboarding/:id/confirm',
    async (req) => {
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
      const body = ConfirmBodySchema.parse(req.body ?? {})
      let handoff = preview.handoff
      if (body?.selected_capabilities !== undefined) {
        const { applyCapabilityOverride } = await import('../onboarding/capability-override.js')
        const result = applyCapabilityOverride({
          handoff: preview.handoff,
          suggestions: preview.capabilities,
          selected_ids: body.selected_capabilities,
        })
        if (!result.ok) {
          throw new ApiError(
            422,
            'onboarding_invalid_capability_selection',
            `selected_capabilities contains ids not in the session's suggestions: ${result.invalid_ids.join(', ')}`,
          )
        }
        handoff = result.handoff
      }
      const { migrateFromHandoff } = await import('../migration/orchestrator.js')
      const { saveTranscript } = await import('../onboarding/transcript-store.js')
      const result = await migrateFromHandoff({
        handoff,
        home,
        supervisor,
        today: new Date(),
        seedFirstTask: true,
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
      // Auto-start the new Agent. Without this, the Agent record is on disk
      // in `state: 'stopped'` and the seeded orientation task sits in the
      // queue waiting indefinitely. v1 scope's Capability 1 onboarding
      // expects "Agent is built ... reports ready" to happen from a single
      // operator action; the start has to fire here, not via a follow-up
      // CLI call. Failure to start is logged via notification but does not
      // fail the confirm ... the operator can `2200 agent start <name>`
      // if anything went sideways.
      let autoStarted = false
      let autoStartError: string | null = null
      try {
        await supervisor.startAgent(result.agent_name)
        autoStarted = true
      } catch (err) {
        autoStartError = err instanceof Error ? err.message : String(err)
        try {
          await emitNotification({
            home,
            agentName: result.agent_name,
            tier: 'important',
            kind: 'agent.auto_start_failed',
            body:
              `Agent **${result.agent_name}** was created from onboarding but auto-start failed: ${autoStartError}\n\n` +
              `Run \`2200 agent start ${result.agent_name}\` once any underlying issue is addressed.`,
          })
        } catch {
          // best-effort
        }
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
        auto_started: autoStarted,
        auto_start_error: autoStartError,
      }
    },
  )

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
  // ------------------------------------------------------------------------
  // Connector inbound endpoint (decision: 2026-05-16-connector-extensions).
  //
  // Per-connector gateway processes (the long-lived child processes the
  // supervisor starts for WhatsApp / Slack / Discord / Telegram
  // Extensions) POST normalized inbound events here. The handler resolves
  // which Agents have a binding to the connector, applies their per-
  // binding allowlist + policy, and creates synthetic tasks on each Agent
  // that passes. No auth in v1: the endpoint is loopback-only and the
  // gateways run on the same host as the supervisor. Hardening to a
  // shared install-time secret is deferred to the install-flow work.
  // ------------------------------------------------------------------------
  fastify.post<{ Params: { connector_id: string } }>(
    '/api/v1/connectors/:connector_id/inbound',
    async (req, reply) => {
      const parsed = ConnectorInboundEventSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ code: 'invalid_inbound_event', errors: parsed.error.issues })
      }
      const event = parsed.data
      if (event.connector_id !== req.params.connector_id) {
        return reply.status(400).send({
          code: 'connector_id_mismatch',
          path: req.params.connector_id,
          body: event.connector_id,
        })
      }
      const snap = supervisor.snapshot()
      const identities: { agent: string; frontmatter: IdentityFrontmatter }[] = []
      for (const [name, rec] of Object.entries(snap.agents)) {
        try {
          const id = await loadIdentity(rec.identity_path)
          identities.push({ agent: name, frontmatter: id.frontmatter })
        } catch {
          // Identity unreadable; skip this Agent for routing purposes.
        }
      }
      const decisions = routeInbound({ event, identities })
      const passed = decisions.filter((d) => d.kind === 'pass')
      const paired = decisions.filter((d) => d.kind === 'pair')
      const blocked = decisions.filter((d) => d.kind === 'block')
      const createdTasks: { agent: string; task_id: string; resumed: boolean }[] = []
      for (const decision of passed) {
        try {
          const taskStore = new TaskStore(home, decision.agent)
          const senderLabel = event.sender.display_name ?? event.sender.id
          const conversationLabel = event.conversation.display_name ?? event.conversation.id

          // Continuation primitive (decision:
          // 2026-05-16-task-continuation-primitive): before creating a
          // fresh task, see if this Agent has a task parked on a
          // wait_for that matches this inbound. If so, resume that task
          // with the inbound appended as continuation context instead
          // of starting a fresh isolated task.
          const waiting = await taskStore.findWaiting({
            kind: 'connector',
            connector_id: event.connector_id,
            conversation_id: event.conversation.id,
            sender: event.sender.id,
          })
          if (waiting) {
            const continuation = buildContinuationSection({
              source_kind: 'connector',
              sender_label: senderLabel,
              context_note: waiting.frontmatter.wait_for?.context_note ?? '',
              body_text: event.text ?? '(media-only message)',
              attachments: event.attachments.map(
                (a) => `${a.kind}: ${a.url}${a.caption ? ` (${a.caption})` : ''}`,
              ),
              reply_hint: `Reply via \`${event.connector_id}_send\` with \`to: "${event.conversation.id}"\`.`,
            })
            const resumed = await taskStore.updateRecord(waiting.frontmatter.id, (rec) => ({
              frontmatter: {
                ...rec.frontmatter,
                state: 'pending',
                wait_for: null,
              },
              body: `${rec.body}\n\n${continuation}`,
            }))
            if (resumed) {
              createdTasks.push({
                agent: decision.agent,
                task_id: waiting.frontmatter.id,
                resumed: true,
              })
              log?.info('connector inbound → resumed parked task', {
                connector_id: event.connector_id,
                agent: decision.agent,
                task_id: waiting.frontmatter.id,
                conversation: event.conversation.id,
                sender: event.sender.id,
              })
              continue
            }
          }

          const taskId = newTaskId()
          const titleBody = event.text ?? '(media-only message)'
          const title = titleBody.slice(0, 60).replace(/\s+/g, ' ').trim() || 'connector message'
          const taskBody = [
            `Incoming ${event.connector_id} ${event.conversation.kind} from **${senderLabel}** in conversation \`${conversationLabel}\`.`,
            '',
            event.text ?? '_(media or non-text content; see attachments below)_',
            event.attachments.length > 0
              ? `\n\nAttachments:\n${event.attachments
                  .map((a) => `- ${a.kind}: ${a.url}${a.caption ? ` (${a.caption})` : ''}`)
                  .join('\n')}`
              : '',
            '',
            `Reply via \`${event.connector_id}_send\` with \`to: "${event.conversation.id}"\`.`,
          ]
            .filter(Boolean)
            .join('\n')
          const task = newPendingTask({
            id: taskId,
            agent: decision.agent,
            title,
            body: taskBody,
            priority: 0,
            idempotency: 'destructive',
            source: {
              kind: 'connector',
              connector_id: event.connector_id,
              conversation_id: event.conversation.id,
              sender_id: event.sender.id,
              account: event.account,
              ...(event.sender.display_name !== undefined
                ? { sender_display_name: event.sender.display_name }
                : {}),
            },
          })
          await taskStore.save(task)
          createdTasks.push({ agent: decision.agent, task_id: taskId, resumed: false })
          log?.info('connector inbound → task created', {
            connector_id: event.connector_id,
            agent: decision.agent,
            task_id: taskId,
            conversation: event.conversation.id,
            sender: event.sender.id,
          })
        } catch (err) {
          log?.warn('connector inbound → failed to enqueue task', {
            agent: decision.agent,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      // Pairing requests (v1: log only; operator-notification fan-out is a
      // follow-on once the pairing-approval UI lands).
      for (const p of paired) {
        log?.info('connector inbound → pairing required (no task created)', {
          connector_id: event.connector_id,
          agent: p.agent,
          sender: event.sender.id,
        })
      }
      // Visibility for misconfiguration: log blocked decisions so
      // operator-side issues (account mismatch, missing mention,
      // disabled policy) surface instead of being silently dropped.
      // mention_required + group_not_allowlisted are noisy and
      // expected on chatty servers; suppress them at info level.
      for (const b of blocked) {
        if (b.reason === 'mention_required' || b.reason === 'group_not_allowlisted') {
          continue
        }
        log?.info('connector inbound → blocked', {
          connector_id: event.connector_id,
          agent: b.agent,
          reason: b.reason,
          event_account: event.account,
          binding_account: b.binding.account,
          sender: event.sender.id,
        })
      }
      return reply.status(202).send({
        passed: createdTasks,
        paired: paired.map((p) => ({ agent: p.agent, reason: p.reason })),
        blocked: blocked.map((b) => ({ agent: b.agent, reason: b.reason })),
      })
    },
  )

  // ------------------------------------------------------------------------
  // Extension catalog + install endpoints (decision: 2026-05-16-connector-store).
  //
  // The catalog is served from the in-repo file in dev; production
  // moves to a 2200.ai-hosted endpoint. Install resolves a catalog
  // entry, copies the workspace source (or pulls npm; not yet wired),
  // validates the manifest, runs the install hook, and broadcasts WS
  // progress events as `extension.install_progress`.
  // ------------------------------------------------------------------------
  const catalogPath = resolveCatalogPath(options.catalogPath)

  // Connector gateway processes are managed by the supervisor when
  // the operator clicks "Finish install" in the Store UI. Gateway
  // child processes POST their pair state (qr image, paired,
  // disconnected) to /pair/state below; the web UI polls /pair/state
  // for live updates.
  const gatewayManager = new GatewayManager({
    home,
    supervisorUrl: `http://127.0.0.1:${String(port)}`,
    catalogPath,
  })

  interface PairState {
    state: 'awaiting_qr_scan' | 'connecting' | 'paired' | 'disconnected' | 'errored' | 'idle'
    qr_data_url?: string
    self_jid?: string | null
    self_user?: { id: string; username: string; discriminator?: string }
    detail?: string
    account: string
    updated_at: string
  }
  // Keyed by `${extension_id}::${agent_or_extension}` so per-Agent
  // (Discord) and per-Extension (WhatsApp Inbox) pair states don't
  // collide. agent_or_extension is the agent name for per-Agent
  // connectors, '_extension' for per-Extension scope.
  const pairStates = new Map<string, PairState>()
  const pairKey = (id: string, agent: string | null): string => `${id}::${agent ?? '_extension'}`

  // Serve per-Extension icon files. Prefers the installed copy at
  // <home>/extensions/<id>/icon.svg; falls back to the workspace
  // source directory listed in the catalog (so the icon is available
  // for browse before install). Extensions can ship `icon.svg`,
  // `icon.png`, or omit (catalog `icon` field null and the Store
  // card renders a fallback glyph).
  fastify.get<{ Params: { id: string } }>('/api/v1/extensions/:id/icon', async (req, reply) => {
    const id = req.params.id
    if (!/^[a-z][a-z0-9-]*$/.test(id)) {
      return reply.status(400).send({ code: 'invalid_id' })
    }
    const candidates: string[] = [
      join(home, 'extensions', id, 'icon.svg'),
      join(home, 'extensions', id, 'icon.png'),
    ]
    try {
      const catalog = await loadCatalog(catalogPath)
      const entry = catalog.extensions.find((e) => e.id === id)
      if (entry?.source.type === 'workspace') {
        const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
        candidates.push(join(repoRoot, entry.source.path, 'icon.svg'))
        candidates.push(join(repoRoot, entry.source.path, 'icon.png'))
      }
    } catch {
      // Catalog unreadable; fall through with installed-only candidates.
    }
    for (const path of candidates) {
      if (!existsSync(path)) continue
      const mime = path.endsWith('.svg') ? 'image/svg+xml' : 'image/png'
      reply.header('content-type', mime)
      reply.header('cache-control', 'public, max-age=3600')
      return reply.send(await readFile(path))
    }
    return reply.status(404).send({ code: 'icon_not_found', id })
  })

  // List installed Extensions + their per-Agent bindings + gateway
  // state. This is what the Store's "Installed" tab + Configure view
  // reads to render persistent state across page reloads.
  fastify.get('/api/v1/extensions/installed', async (_req, reply) => {
    const extensionsRoot = join(home, 'extensions')
    interface InstalledBinding {
      agent: string
      account: string
      bot_user_id?: string
      bot_username?: string
      gateway_running: boolean
      pair_state: string
      pair_state_detail?: string
      pair_state_updated_at?: string
      allowlist_dm: string[]
      allowlist_group: string[]
      dm_policy: 'open' | 'allowlist' | 'disabled' | 'pairing'
      group_policy: 'open' | 'allowlist' | 'disabled'
      require_mention: boolean
    }
    interface InstalledExtension {
      id: string
      manifest: Record<string, unknown>
      bindings: InstalledBinding[]
      // For extension-scope connectors (WhatsApp Inbox), gateway state
      // lives at the extension level (no per-Agent breakdown).
      extension_gateway?: {
        running: boolean
        pair_state: string
        self_jid?: string | null
      }
    }
    const items: InstalledExtension[] = []
    let extDirs: string[]
    try {
      const { readdir } = await import('node:fs/promises')
      const entries = await readdir(extensionsRoot, { withFileTypes: true })
      extDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
    } catch {
      return reply.send({ items: [] })
    }

    const snap = supervisor.snapshot()
    const allIdentities: { agent: string; frontmatter: IdentityFrontmatter }[] = []
    for (const [name, rec] of Object.entries(snap.agents)) {
      try {
        const id = await loadIdentity(rec.identity_path)
        allIdentities.push({ agent: name, frontmatter: id.frontmatter })
      } catch {
        // best effort
      }
    }

    for (const dir of extDirs) {
      let manifest: Record<string, unknown>
      try {
        const { readFile: rf } = await import('node:fs/promises')
        const text = await rf(join(extensionsRoot, dir, 'manifest.json'), 'utf-8')
        manifest = JSON.parse(text) as Record<string, unknown>
      } catch {
        // skip non-Extension directories
        continue
      }
      const bindings: InstalledBinding[] = []
      for (const { agent, frontmatter } of allIdentities) {
        const b = frontmatter.connectors.find((c) => c.connector_id === dir)
        if (!b) continue
        const ps = pairStates.get(pairKey(dir, agent))
        const binding: InstalledBinding = {
          agent,
          account: b.account,
          gateway_running: gatewayManager.isRunning(dir, agent),
          pair_state: ps?.state ?? 'idle',
          allowlist_dm: b.allowlist.dm,
          allowlist_group: b.allowlist.group,
          dm_policy: b.policies.dm_policy,
          group_policy: b.policies.group_policy,
          require_mention: b.policies.require_mention,
        }
        if (ps?.self_user) {
          binding.bot_user_id = ps.self_user.id
          binding.bot_username = ps.self_user.username
        }
        if (ps?.detail) binding.pair_state_detail = ps.detail
        if (ps?.updated_at) binding.pair_state_updated_at = ps.updated_at
        bindings.push(binding)
      }
      const item: InstalledExtension = { id: dir, manifest, bindings }
      // Extension-scope summary (WhatsApp Inbox).
      const extPs = pairStates.get(pairKey(dir, null))
      if (extPs) {
        item.extension_gateway = {
          running: gatewayManager.isRunning(dir, null),
          pair_state: extPs.state,
          ...(extPs.self_jid !== undefined ? { self_jid: extPs.self_jid } : {}),
        }
      }
      items.push(item)
    }
    return reply.send({ items })
  })

  fastify.get('/api/v1/extensions/catalog', async (_req, reply) => {
    try {
      const catalog = await loadCatalog(catalogPath)
      return catalog
    } catch (err) {
      log?.warn('catalog load failed', {
        path: catalogPath,
        error: err instanceof Error ? err.message : String(err),
      })
      return reply.status(500).send({
        code: 'catalog_unavailable',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  })

  // -- pair flow (connector Extensions) ----------------------------------
  // The Store UI's "Finish install" CTA hits POST /pair/start, which
  // starts the gateway child process. The gateway then POSTs its pair
  // state (qr | connecting | paired | disconnected) to /pair/state as
  // events fire. The Store polls GET /pair/state every ~500ms during
  // active pairing.
  //
  // POST /pair/state is the gateway → supervisor channel. Marked public
  // in the auth pre-handler regex (loopback-only in practice; gateway
  // runs on the same host).

  // Extract the optional agent query param. Per-Agent connectors
  // pass `?agent=simon`; per-Extension (WhatsApp Inbox) omits.
  function readAgentParam(query: unknown): string | null {
    if (typeof query !== 'object' || query === null) return null
    const q = query as Record<string, unknown>
    const a = q['agent']
    if (typeof a !== 'string' || a.length === 0) return null
    if (!/^[a-z][a-z0-9_-]*$/.test(a)) {
      throw new Error('agent name must be lowercase letter + lowercase / digits / -_')
    }
    return a
  }

  fastify.post<{ Params: { id: string }; Querystring: { agent?: string } }>(
    '/api/v1/extensions/:id/pair/start',
    async (req, reply) => {
      const id = req.params.id
      if (!/^[a-z][a-z0-9-]*$/.test(id)) {
        return reply.status(400).send({ code: 'invalid_id' })
      }
      let agent: string | null
      try {
        agent = readAgentParam(req.query)
      } catch (err) {
        return reply.status(400).send({
          code: 'invalid_agent',
          message: err instanceof Error ? err.message : 'invalid agent',
        })
      }
      try {
        const handle = await gatewayManager.start(id, agent)
        const seedKey = pairKey(id, agent)
        if (!pairStates.has(seedKey)) {
          pairStates.set(seedKey, {
            state: 'connecting',
            account: agent ?? 'default',
            updated_at: new Date().toISOString(),
          })
        }
        return await reply.status(200).send({
          extension_id: handle.extension_id,
          agent_name: handle.agent_name,
          gateway: { pid: handle.pid, port: handle.port, started_at: handle.started_at },
        })
      } catch (err) {
        return await reply.status(500).send({
          code: 'gateway_start_failed',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },
  )

  const PairStateBodySchema = z.object({
    state: z.enum(['awaiting_qr_scan', 'connecting', 'paired', 'disconnected', 'errored']),
    qr_data_url: z.string().optional(),
    self_jid: z.string().nullable().optional(),
    self_user: z
      .object({
        id: z.string(),
        username: z.string(),
        discriminator: z.string().optional(),
      })
      .optional(),
    detail: z.string().optional(),
    // For per-Extension connectors the gateway sends 'default'; for
    // per-Agent connectors the gateway sends the Agent name. Treat as
    // the pair-state key disambiguator either way.
    account: z.string().default('default'),
    at: z.string().optional(),
  })

  fastify.post<{ Params: { id: string } }>(
    '/api/v1/extensions/:id/pair/state',
    async (req, reply) => {
      const id = req.params.id
      if (!/^[a-z][a-z0-9-]*$/.test(id)) {
        return reply.status(400).send({ code: 'invalid_id' })
      }
      const parsed = PairStateBodySchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ code: 'invalid_pair_state', errors: parsed.error.issues })
      }
      const next: PairState = {
        state: parsed.data.state,
        account: parsed.data.account,
        updated_at: new Date().toISOString(),
      }
      if (parsed.data.qr_data_url) next.qr_data_url = parsed.data.qr_data_url
      if (parsed.data.self_jid !== undefined) next.self_jid = parsed.data.self_jid
      if (parsed.data.self_user) {
        next.self_user = {
          id: parsed.data.self_user.id,
          username: parsed.data.self_user.username,
          ...(parsed.data.self_user.discriminator !== undefined
            ? { discriminator: parsed.data.self_user.discriminator }
            : {}),
        }
      }
      if (parsed.data.detail) next.detail = parsed.data.detail
      // For per-Extension connectors, account = 'default' maps to
      // the '_extension' bucket. For per-Agent connectors, account =
      // <agent_name>.
      const agentKey = parsed.data.account === 'default' ? null : parsed.data.account
      const k = pairKey(id, agentKey)
      pairStates.set(k, next)
      log?.info('pair state updated', {
        extension_id: id,
        agent: agentKey ?? '_extension',
        state: next.state,
      })
      return reply.status(200).send({ ok: true })
    },
  )

  fastify.get<{ Params: { id: string }; Querystring: { agent?: string } }>(
    '/api/v1/extensions/:id/pair/state',
    (req, reply) => {
      const id = req.params.id
      if (!/^[a-z][a-z0-9-]*$/.test(id)) {
        return reply.status(400).send({ code: 'invalid_id' })
      }
      let agent: string | null
      try {
        agent = readAgentParam(req.query)
      } catch (err) {
        return reply.status(400).send({
          code: 'invalid_agent',
          message: err instanceof Error ? err.message : 'invalid agent',
        })
      }
      const k = pairKey(id, agent)
      const state = pairStates.get(k) ?? {
        state: 'idle' as const,
        account: agent ?? 'default',
        updated_at: new Date(0).toISOString(),
      }
      return reply.send({
        extension_id: id,
        agent_name: agent,
        gateway_running: gatewayManager.isRunning(id, agent),
        ...state,
      })
    },
  )

  // -- per-Agent connector setup (for account_scope: 'agent') -----------
  // The Store's per-Agent install flow POSTs here after the operator
  // pastes the bot token. We:
  //   1. Validate the Agent exists.
  //   2. Seal credentials into the per-Agent vault (name: `${id}-${key}`).
  //   3. Add/update the connector binding in the Agent's identity.md.
  //   4. Restart the Agent so the loop picks up the new binding.
  //   5. Start the gateway for (extension_id, agent_name).
  // ----------------------------------------------------------------------

  const SetupAgentBindingBodySchema = z.object({
    /**
     * Credentials map. Keys match the binding's `credentials` schema
     * (e.g. `bot_token` for Discord). Values are the actual plaintext
     * secrets the operator pasted; we seal them to vault here and
     * record only the credential name in the binding.
     */
    credentials: z.record(z.string().min(1), z.string().min(1)).default({}),
    /** Default allowlist tweaks (optional). */
    allowlist_dm: z.array(z.string()).optional(),
    /**
     * Discord channel allowlist. Required for Discord (per-Agent bots
     * are pinned to a dedicated channel ... users can't DM bots, so
     * the channel is the only viable conversation surface). When set,
     * the router uses allowlist-based group routing without
     * require_mention; messages in this channel wake the Agent
     * directly. Optional for other connectors.
     */
    allowlist_group: z.array(z.string().regex(/^\d+$/)).optional(),
  })

  fastify.post<{ Params: { id: string; agent: string } }>(
    '/api/v1/extensions/:id/agents/:agent/setup',
    async (req, reply) => {
      const id = req.params.id
      const agent = req.params.agent
      if (!/^[a-z][a-z0-9-]*$/.test(id)) {
        return reply.status(400).send({ code: 'invalid_id' })
      }
      if (!/^[a-z][a-z0-9_-]*$/.test(agent)) {
        return reply.status(400).send({ code: 'invalid_agent' })
      }
      const snap = supervisor.snapshot()
      const rec = snap.agents[agent]
      if (!rec) return reply.status(404).send({ code: 'agent_not_found', agent })
      const parsed = SetupAgentBindingBodySchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ code: 'invalid_setup_body', errors: parsed.error.issues })
      }

      // Catalog lookup for the connector entry (auth_model + permissions).
      const catalog = await loadCatalog(catalogPath)
      const entry = catalog.extensions.find((e) => e.id === id)
      if (!entry) {
        return reply.status(404).send({ code: 'catalog_entry_not_found', id })
      }
      if (entry.account_scope !== 'agent') {
        return reply.status(400).send({
          code: 'wrong_account_scope',
          message: `${id} is account_scope="${entry.account_scope ?? 'null'}"; use /pair/start for extension-scope connectors`,
        })
      }

      // 1. Seal credentials to vault.
      const vault = new CredentialVault(home, agent)
      const credentialMap: Record<string, string> = {}
      for (const [bindingKey, secret] of Object.entries(parsed.data.credentials)) {
        // Credential names use the slug regex (lowercase + digits + dashes
        // only) so the binding key's underscores are normalized to dashes.
        // The Identity binding's `credentials` map still uses the original
        // (snake_case) key as the lookup, but the underlying credential
        // name on disk is the slug form.
        const credentialName = `${id}-${bindingKey.replace(/_/g, '-')}`
        try {
          await vault.set(credentialName, {
            value: secret,
            metadata: {
              created_at: new Date().toISOString(),
              provider: id,
              notes: `sealed by Store install flow for binding "${bindingKey}"`,
            },
          })
          credentialMap[bindingKey] = credentialName
        } catch (err) {
          return await reply.status(500).send({
            code: 'vault_write_failed',
            message: err instanceof Error ? err.message : String(err),
          })
        }
      }

      // 2. Add / update the binding in identity.md.
      // For Discord: the channel allowlist IS the conversation gate
      // (no bot DMs on Discord, so users can only reach the Agent via
      // a channel the bot is in). group_policy=allowlist + the
      // channel id in allowlist.group means every message in that
      // channel wakes the Agent; require_mention=false because the
      // channel is already dedicated to this Agent. For other
      // per-Agent connectors, we ship a pairing-style default until
      // their UX work happens.
      const channelAllowlist = parsed.data.allowlist_group ?? []
      if (id === 'discord' && channelAllowlist.length === 0) {
        return await reply.status(400).send({
          code: 'channel_required',
          message: 'Discord setup requires at least one channel id in allowlist_group',
        })
      }
      const defaultPolicies =
        id === 'discord'
          ? {
              dm_policy: 'open' as const,
              group_policy: 'allowlist' as const,
              require_mention: false,
            }
          : {
              dm_policy: 'pairing' as const,
              group_policy: 'allowlist' as const,
              require_mention: true,
            }
      try {
        await upsertConnectorBinding(rec.identity_path, {
          connector_id: id,
          account: 'default',
          credentials: credentialMap,
          allowlist: {
            dm: parsed.data.allowlist_dm ?? [],
            group: channelAllowlist,
          },
          policies: defaultPolicies,
        })
      } catch (err) {
        return await reply.status(500).send({
          code: 'identity_write_failed',
          message: err instanceof Error ? err.message : String(err),
        })
      }

      // 3. Restart the Agent so the new binding loads.
      try {
        await supervisor.stopAgent(agent)
        await supervisor.startAgent(agent)
      } catch (err) {
        log?.warn('agent restart after binding setup failed', {
          agent,
          error: err instanceof Error ? err.message : String(err),
        })
      }

      // 4. Start the gateway.
      try {
        const handle = await gatewayManager.start(id, agent)
        return await reply.status(200).send({
          extension_id: id,
          agent_name: agent,
          gateway: { pid: handle.pid, port: handle.port, started_at: handle.started_at },
          credentials_sealed: Object.keys(credentialMap),
        })
      } catch (err) {
        return await reply.status(500).send({
          code: 'gateway_start_failed',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },
  )

  // -- per-Agent binding policy patch -----------------------------------
  // Update the allowlist + policy block on an existing binding
  // without touching credentials or restarting the Agent. The
  // supervisor's router re-reads identity.md on every inbound POST,
  // so the new policy takes effect on the next message ... no
  // restart needed (routing happens in the supervisor, not the
  // Agent process). Mainly used for "change the Discord channel"
  // from the Configure view in the Store.
  // ----------------------------------------------------------------------
  const PatchAgentBindingBodySchema = z.object({
    allowlist_dm: z.array(z.string()).optional(),
    allowlist_group: z.array(z.string().regex(/^\d+$/)).optional(),
  })
  fastify.patch<{ Params: { id: string; agent: string } }>(
    '/api/v1/extensions/:id/agents/:agent/policy',
    async (req, reply) => {
      const id = req.params.id
      const agent = req.params.agent
      if (!/^[a-z][a-z0-9-]*$/.test(id)) {
        return reply.status(400).send({ code: 'invalid_id' })
      }
      if (!/^[a-z][a-z0-9_-]*$/.test(agent)) {
        return reply.status(400).send({ code: 'invalid_agent' })
      }
      const snap = supervisor.snapshot()
      const rec = snap.agents[agent]
      if (!rec) return reply.status(404).send({ code: 'agent_not_found', agent })
      const parsed = PatchAgentBindingBodySchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ code: 'invalid_patch_body', errors: parsed.error.issues })
      }
      const identity = await loadIdentity(rec.identity_path)
      const existing = identity.frontmatter.connectors.find(
        (b) => b.connector_id === id && b.account === 'default',
      )
      if (!existing) {
        return reply.status(404).send({
          code: 'binding_not_found',
          message: `agent "${agent}" has no binding for "${id}" / account=default`,
        })
      }
      const nextAllowlist = {
        dm: parsed.data.allowlist_dm ?? existing.allowlist.dm,
        group: parsed.data.allowlist_group ?? existing.allowlist.group,
      }
      // When the operator pins the Agent to a Discord channel (the
      // canonical Discord per-Agent pattern), auto-shift the policy
      // block to "channel-allowlist, no mention required" ... the
      // alternative is the operator manually editing identity.md
      // to flip group_policy + require_mention, which defeats the
      // purpose of a UI knob.
      const nextPolicies =
        id === 'discord' && nextAllowlist.group.length > 0
          ? {
              ...existing.policies,
              group_policy: 'allowlist' as const,
              require_mention: false,
            }
          : existing.policies
      try {
        await upsertConnectorBinding(rec.identity_path, {
          connector_id: existing.connector_id,
          account: existing.account,
          credentials: existing.credentials,
          allowlist: nextAllowlist,
          policies: nextPolicies,
        })
      } catch (err) {
        return await reply.status(500).send({
          code: 'identity_write_failed',
          message: err instanceof Error ? err.message : String(err),
        })
      }
      return reply.status(200).send({
        extension_id: id,
        agent_name: agent,
        allowlist: nextAllowlist,
        policies: nextPolicies,
      })
    },
  )

  const InstallBodySchema = z.object({
    source: z.discriminatedUnion('type', [
      z.object({ type: z.literal('catalog'), id: z.string().min(1) }),
      z.object({ type: z.literal('npm'), package: z.string().min(1) }),
      z.object({ type: z.literal('path'), path: z.string().min(1) }),
    ]),
    permissions_acknowledged: z.array(z.string()).default([]),
    tos_acknowledged: z.boolean().default(false),
  })

  fastify.post('/api/v1/extensions/install', async (req, reply) => {
    const body = InstallBodySchema.parse(req.body)
    let entry: CatalogEntry
    if (body.source.type === 'catalog') {
      const requestedId = body.source.id
      const catalog = await loadCatalog(catalogPath)
      const found = catalog.extensions.find((e) => e.id === requestedId)
      if (!found) {
        return reply.status(404).send({ code: 'catalog_entry_not_found', id: requestedId })
      }
      entry = found
    } else {
      // npm + path direct-install paths are out of scope for v1; the
      // Store UX only exercises the catalog flow.
      return reply.status(400).send({
        code: 'source_type_not_supported',
        message: `source.type '${body.source.type}' not implemented in this endpoint; use catalog source`,
      })
    }

    // Fire-and-forget the install; progress streams over WS.
    const installId = `inst_pending_${String(Date.now())}`
    const broadcastProgress = (event: InstallProgressEvent): void => {
      const msg = JSON.stringify({
        event: 'extension.install_progress',
        occurred_at: new Date().toISOString(),
        payload: event as unknown as Record<string, unknown>,
      })
      for (const c of wsClients) c.send(msg)
    }
    void installFromCatalogEntry({
      entry,
      home,
      permissionsAcknowledged: body.permissions_acknowledged,
      tosAcknowledged: body.tos_acknowledged,
      onProgress: broadcastProgress,
    }).catch((err: unknown) => {
      log?.warn('install pipeline failed', {
        extension_id: entry.id,
        error: err instanceof Error ? err.message : String(err),
      })
    })

    return reply.status(202).send({ install_id: installId, extension_id: entry.id })
  })

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

  // ------------------------------------------------------------------------
  // Doctor (Settings -> Doctor tab).
  //
  // Scans the substrate for known issue patterns and offers per-issue
  // fixes. v1 surface: errored Agents (recoverable vs. unknown),
  // missing connector gateways, stale pending credential requests.
  // Each issue carries a stable id of `<kind>:<scope>` so the fix
  // endpoint can dispatch without storing diagnostic state on the
  // server.
  // ------------------------------------------------------------------------
  type DoctorSeverity = 'info' | 'warn' | 'error'
  interface DoctorIssue {
    id: string
    severity: DoctorSeverity
    kind: string
    title: string
    description: string
    fix_available: boolean
    fix_label?: string
  }

  async function diagnose(): Promise<DoctorIssue[]> {
    const issues: DoctorIssue[] = []
    const snap = supervisor.snapshot()

    // Check 1: errored Agents. Distinguish "polite-shutdown wedge"
    // (fixable by restart) from "real crash" (operator investigation).
    for (const [name, rec] of Object.entries(snap.agents)) {
      if (rec.state !== 'errored') continue
      const reason = rec.errored_reason ?? ''
      if (reason.startsWith('process exited during daemon shutdown')) {
        issues.push({
          id: `agent_errored_recoverable:${name}`,
          severity: 'warn',
          kind: 'agent_errored_recoverable',
          title: `Agent "${name}" wedged in errored after daemon shutdown`,
          description:
            `${name} hit a known shutdown-race wedge (code=null signal=null treated as crash). ` +
            `The upstream fix landed in 2026-05-16; this Agent was wedged before the fix.`,
          fix_available: true,
          fix_label: `Restart ${name}`,
        })
      } else {
        issues.push({
          id: `agent_errored_unknown:${name}`,
          severity: 'error',
          kind: 'agent_errored_unknown',
          title: `Agent "${name}" in errored state`,
          description: reason || '(no errored_reason recorded)',
          fix_available: false,
        })
      }
    }

    // Check 2: connector gateways that should be running but are not.
    // For each installed Extension with at least one Agent binding,
    // verify the gateway is live. Per-Agent and extension-scope
    // handled separately (mirror of the boot recovery logic).
    try {
      const catalog = await loadCatalog(catalogPath)
      const { readdir } = await import('node:fs/promises')
      let installedIds: string[] = []
      try {
        const entries = await readdir(join(home, 'extensions'), { withFileTypes: true })
        installedIds = entries
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => e.name)
      } catch {
        // no extensions installed
      }
      for (const extId of installedIds) {
        const entry = catalog.extensions.find((e) => e.id === extId)
        if (entry?.category !== 'connector') continue
        const scope = entry.account_scope ?? 'extension'
        const boundAgents: string[] = []
        for (const [name, rec] of Object.entries(snap.agents)) {
          try {
            const id = await loadIdentity(rec.identity_path)
            if (id.frontmatter.connectors.some((c) => c.connector_id === extId)) {
              boundAgents.push(name)
            }
          } catch {
            // identity unreadable; skip
          }
        }
        if (boundAgents.length === 0) continue
        if (scope === 'extension') {
          if (!gatewayManager.isRunning(extId, null)) {
            issues.push({
              id: `connector_gateway_missing:${extId}::`,
              severity: 'warn',
              kind: 'connector_gateway_missing',
              title: `${entry.label} gateway is not running`,
              description:
                `${String(boundAgents.length)} Agent${boundAgents.length === 1 ? '' : 's'} ` +
                `${boundAgents.length === 1 ? 'has' : 'have'} bindings to ${entry.label} ` +
                `but the gateway process is not live. Inbound messages will not wake anyone ` +
                `until the gateway is back up.`,
              fix_available: true,
              fix_label: 'Start gateway',
            })
          }
        } else {
          for (const agent of boundAgents) {
            if (!gatewayManager.isRunning(extId, agent)) {
              issues.push({
                id: `connector_gateway_missing:${extId}::${agent}`,
                severity: 'warn',
                kind: 'connector_gateway_missing',
                title: `${entry.label} gateway for ${agent} is not running`,
                description:
                  `${agent} has a ${entry.label} binding but the per-Agent gateway is not live. ` +
                  `${entry.label} messages to ${agent} will not arrive until the gateway is back up.`,
                fix_available: true,
                fix_label: `Start gateway for ${agent}`,
              })
            }
          }
        }
      }
    } catch (err) {
      log?.warn('doctor: gateway check failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // Check 3: stale pending credential requests owned by Agents
    // that are no longer running. Operator paste cards for dead
    // recipients should be expired so they don't clutter the inbox.
    try {
      const credStore = new CredentialRequestStore(home)
      const pending = await credStore.list({ state: 'pending' })
      for (const rec of pending) {
        const agentRec = snap.agents[rec.agent]
        const agentLive = agentRec?.state === 'running' || agentRec?.state === 'waiting'
        if (agentLive) continue
        issues.push({
          id: `pending_credential_orphaned:${rec.id}`,
          severity: 'warn',
          kind: 'pending_credential_orphaned',
          title: `Pending credential request for offline Agent "${rec.agent}"`,
          description:
            `Credential "${rec.credential_name}" requested by ${rec.agent} ` +
            `(label: "${rec.label}"), but ${rec.agent} is currently ` +
            `${agentRec?.state ?? 'missing'}. The request will sit forever unless expired.`,
          fix_available: true,
          fix_label: 'Expire request',
        })
      }
    } catch (err) {
      log?.warn('doctor: pending credential check failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }

    return issues
  }

  fastify.get('/api/v1/doctor/diagnose', async (_req, reply) => {
    const items = await diagnose()
    return reply.send({ items, generated_at: new Date().toISOString() })
  })

  const DoctorFixBodySchema = z.object({ id: z.string().min(1) })
  fastify.post('/api/v1/doctor/fix', async (req, reply) => {
    const parsed = DoctorFixBodySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ code: 'invalid_body', errors: parsed.error.issues })
    }
    const id = parsed.data.id
    // Dispatch by id prefix. Format: <kind>:<scope-string>.
    if (id.startsWith('agent_errored_recoverable:')) {
      const agent = id.slice('agent_errored_recoverable:'.length)
      try {
        await supervisor.startAgent(agent)
        return await reply.send({ applied: true, message: `Started ${agent}.` })
      } catch (err) {
        return reply.status(500).send({
          applied: false,
          message: `Could not start ${agent}: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }
    if (id.startsWith('connector_gateway_missing:')) {
      const scope = id.slice('connector_gateway_missing:'.length)
      const [extId, agentPart] = scope.split('::')
      if (!extId) return reply.status(400).send({ applied: false, message: 'invalid scope' })
      const agentName = agentPart && agentPart.length > 0 ? agentPart : null
      try {
        const handle = await gatewayManager.start(extId, agentName)
        return await reply.send({
          applied: true,
          message: `Started ${extId} gateway${agentName ? ` for ${agentName}` : ''} (pid ${String(handle.pid)}).`,
        })
      } catch (err) {
        return reply.status(500).send({
          applied: false,
          message: `Could not start gateway: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }
    if (id.startsWith('pending_credential_orphaned:')) {
      const requestId = id.slice('pending_credential_orphaned:'.length)
      try {
        const credStore = new CredentialRequestStore(home)
        await credStore.transition(requestId, 'expired', {
          now: new Date().toISOString(),
          expired_reason: 'agent_crashed',
        })
        return await reply.send({ applied: true, message: 'Expired the request.' })
      } catch (err) {
        return reply.status(500).send({
          applied: false,
          message: `Could not expire request: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }
    return reply.status(400).send({ applied: false, message: `unknown issue id: ${id}` })
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

  // Boot-time gateway recovery.
  //
  // Connector gateways are child processes of the supervisor. When
  // the supervisor restarts (daemon stop/start, SIGKILL, crash), the
  // gateways either die alongside it (clean shutdown via stopAll) or
  // are orphaned (SIGKILL case). Either way, the new supervisor's
  // GatewayManager starts with empty state and no gateway is running
  // for any installed Extension. Inbound messages disappear silently
  // until the operator manually re-starts each gateway. This block
  // closes that gap: walk installed Extensions + per-Agent bindings
  // and start the gateways that should be running.
  //
  // For per-Agent connectors (Discord), one gateway per (extension,
  // Agent) tuple. For per-Extension connectors (WhatsApp Inbox), one
  // gateway per Extension if at least one Agent has a binding. The
  // platform's single-bot-connection semantics (Discord disconnects
  // older clients holding the same token; Baileys takes over the
  // device pair) handle the orphan case ... the new gateway takes
  // over and the orphan gets kicked.
  //
  // Fire-and-forget: failures on individual gateways are logged but
  // do not block the server from coming up. The operator can always
  // hit the Configure view's "Start gateway" button as a fallback.
  void recoverGateways({
    home,
    catalogPath,
    gatewayManager,
    snapshot: () => supervisor.snapshot(),
    log: log?.child('gateway-recovery'),
  }).catch((err: unknown) => {
    log?.warn('gateway recovery failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  })

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
      await pubBridge.close()
      await gatewayManager.stopAll()
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
// Boot-time gateway recovery (decision: 2026-05-16-connector-extensions).
// ---------------------------------------------------------------------------

interface RecoverGatewaysArgs {
  home: string
  catalogPath: string
  gatewayManager: GatewayManager
  snapshot: () => ReturnType<Supervisor['snapshot']>
  log: Logger | undefined
}

async function recoverGateways(args: RecoverGatewaysArgs): Promise<void> {
  const { home, catalogPath, gatewayManager, snapshot, log } = args
  // Load the catalog so we know which connectors have gateway hooks
  // and what their account_scope is.
  let catalog: Awaited<ReturnType<typeof loadCatalog>>
  try {
    catalog = await loadCatalog(catalogPath)
  } catch (err) {
    log?.warn('catalog unreadable; skipping gateway recovery', {
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }
  // Orphan sweep: when a prior supervisor was SIGKILL'd (instead of
  // SIGTERM'd) its child gateways survived. Each gateway writes its
  // own pid + port to gateway.json at startup; walk those files and
  // SIGTERM any pids that are still alive before starting fresh.
  // Without this, the new gateway and the orphan both connect to
  // Discord with the same bot token; Discord's single-bot-token rule
  // kicks one but the orphan keeps reconnect-looping in the
  // background, leaking memory and noise.
  await sweepOrphanGateways(join(home, 'state', 'extensions'), log)
  const { readdir } = await import('node:fs/promises')
  const extensionsRoot = join(home, 'extensions')
  let installed: string[]
  try {
    const entries = await readdir(extensionsRoot, { withFileTypes: true })
    installed = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
  } catch {
    // No extensions installed yet; nothing to recover.
    return
  }
  // Build the set of (agent, connector_id) bindings by walking each
  // Agent's identity.md. We only start gateways for connectors that
  // (a) are installed, (b) have a gateway hook in the catalog entry,
  // and (c) have at least one Agent binding.
  const snap = snapshot()
  const agentBindings: { agent: string; connector_id: string }[] = []
  for (const [name, rec] of Object.entries(snap.agents)) {
    try {
      const id = await loadIdentity(rec.identity_path)
      for (const c of id.frontmatter.connectors) {
        agentBindings.push({ agent: name, connector_id: c.connector_id })
      }
    } catch {
      // Identity unreadable; skip this Agent for recovery purposes.
    }
  }
  let started = 0
  let skipped = 0
  let failed = 0
  for (const extId of installed) {
    const entry = catalog.extensions.find((e) => e.id === extId)
    if (entry?.category !== 'connector') {
      skipped += 1
      continue
    }
    const scope = entry.account_scope ?? 'extension'
    const bindings = agentBindings.filter((b) => b.connector_id === extId)
    if (bindings.length === 0) {
      // No Agent uses this Extension; no gateway to start.
      skipped += 1
      continue
    }
    if (scope === 'extension') {
      // One gateway per Extension; pair-once shared across all bindings.
      try {
        const handle = await gatewayManager.start(extId, null)
        log?.info('gateway recovered (extension scope)', {
          extension_id: extId,
          pid: handle.pid,
          port: handle.port,
          bindings: bindings.length,
        })
        started += 1
      } catch (err) {
        log?.warn('gateway recovery failed (extension scope)', {
          extension_id: extId,
          error: err instanceof Error ? err.message : String(err),
        })
        failed += 1
      }
    } else {
      // Per-Agent: one gateway per (extension, agent) tuple.
      for (const b of bindings) {
        try {
          const handle = await gatewayManager.start(extId, b.agent)
          log?.info('gateway recovered (per-Agent scope)', {
            extension_id: extId,
            agent: b.agent,
            pid: handle.pid,
            port: handle.port,
          })
          started += 1
        } catch (err) {
          log?.warn('gateway recovery failed (per-Agent scope)', {
            extension_id: extId,
            agent: b.agent,
            error: err instanceof Error ? err.message : String(err),
          })
          failed += 1
        }
      }
    }
  }
  log?.info('gateway recovery complete', { started, skipped, failed })
}

/**
 * Walk `<state>/extensions/*\/gateway.json` and
 * `<state>/extensions/*\/agents/*\/gateway.json`, read each pid, and
 * SIGTERM any that are still alive. Best-effort: we wait briefly for
 * the process to exit but do not block recovery on stragglers (the
 * platform's single-connection semantics will kick them anyway). A
 * 200ms wait covers the common case where the orphan respects
 * SIGTERM; anything slower we leave for the OS to reap.
 */
async function sweepOrphanGateways(stateRoot: string, log: Logger | undefined): Promise<void> {
  const { readdir, readFile } = await import('node:fs/promises')
  const candidates: string[] = []
  let extDirs: string[]
  try {
    const entries = await readdir(stateRoot, { withFileTypes: true })
    extDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    // No extensions directory; nothing to sweep.
    return
  }
  for (const extName of extDirs) {
    candidates.push(join(stateRoot, extName, 'gateway.json'))
    try {
      const agentsRoot = join(stateRoot, extName, 'agents')
      const agentDirs = await readdir(agentsRoot, { withFileTypes: true })
      for (const a of agentDirs) {
        if (a.isDirectory()) {
          candidates.push(join(stateRoot, extName, 'agents', a.name, 'gateway.json'))
        }
      }
    } catch {
      // No per-Agent gateways for this Extension.
    }
  }
  let killed = 0
  for (const path of candidates) {
    if (!existsSync(path)) continue
    let pid: number | null = null
    try {
      const raw = await readFile(path, 'utf-8')
      const parsed = JSON.parse(raw) as { pid?: number }
      if (typeof parsed.pid === 'number') pid = parsed.pid
    } catch {
      continue
    }
    if (pid === null) continue
    let alive = false
    try {
      // Signal 0 doesn't deliver a signal, just probes whether the
      // pid exists and we're allowed to signal it. EPERM also means
      // alive (running as another user, but we're single-user here).
      process.kill(pid, 0)
      alive = true
    } catch (err) {
      const errno = (err as NodeJS.ErrnoException).code
      if (errno === 'EPERM') alive = true
    }
    if (!alive) continue
    try {
      process.kill(pid, 'SIGTERM')
      killed += 1
      log?.info('orphan gateway killed', { pid, gateway_info_path: path })
    } catch (err) {
      log?.warn('orphan gateway kill failed', {
        pid,
        path,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (killed > 0) {
    // Give the orphans a moment to exit cleanly before we start
    // replacements that contend for the same bot token / device pair.
    await new Promise((r) => setTimeout(r, 200))
    log?.info('orphan gateway sweep complete', { killed })
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

function extractGeneratedAt(markdown: string): string | null {
  const m = /^generated_at:\s*(.+)$/m.exec(markdown)
  return m ? (m[1]?.trim() ?? null) : null
}

/** Short URL-safe id for attachment directories. */
function newAttachmentId(): string {
  // 12 random hex chars; collision risk negligible for the use case.
  return randomBytes(6).toString('hex')
}

/**
 * Minimal extension → MIME map. Just enough coverage for the
 * attachment-serve route ... unknown types fall back to octet-stream
 * so the browser offers a download instead of trying to render.
 */
function inferMimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
    json: 'application/json; charset=utf-8',
    yaml: 'application/yaml; charset=utf-8',
    yml: 'application/yaml; charset=utf-8',
    csv: 'text/csv; charset=utf-8',
    log: 'text/plain; charset=utf-8',
    html: 'text/html; charset=utf-8',
  }
  return map[ext] ?? 'application/octet-stream'
}

function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
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
    created_at: string | null
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
  let model: { provider: string; model_id: string; followup_model_id: string | null } | null = null
  let avatar: string | null = null
  let archived: { at: string; reason?: string } | null = null
  try {
    const id = await loadIdentity(rec.identity_path)
    model = {
      provider: id.frontmatter.model.provider,
      model_id: id.frontmatter.model.model_id,
      followup_model_id: id.frontmatter.model.followup_model_id ?? null,
    }
    avatar = id.frontmatter.avatar ?? null
    if (id.frontmatter.archived) {
      archived = id.frontmatter.archived.reason
        ? { at: id.frontmatter.archived.at, reason: id.frontmatter.archived.reason }
        : { at: id.frontmatter.archived.at }
    }
  } catch {
    // Same tolerance as pulse: a broken Identity should not break
    // the screen. The detail screen shows "?" for the model.
  }
  const { avatarImage } = agentPathsHelper(home, rec.name)
  let avatarImageMtime: string | null = null
  try {
    const stat = await (await import('node:fs/promises')).stat(avatarImage)
    avatarImageMtime = stat.mtime.toISOString()
  } catch {
    /* no image uploaded; falls back to glyph or initial */
  }
  return {
    name: rec.name,
    status: rec.state,
    pid: rec.pid,
    current_task_id: rec.current_task_id,
    identity_path: rec.identity_path,
    created_at: rec.created_at,
    last_heartbeat: rec.last_heartbeat,
    errored_at: rec.errored_at,
    errored_reason: rec.errored_reason,
    pulse,
    model,
    avatar,
    avatar_image_url:
      avatarImageMtime !== null
        ? `/api/v1/agents/${encodeURIComponent(rec.name)}/avatar/image?v=${encodeURIComponent(
            avatarImageMtime,
          )}`
        : null,
    archived,
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
  /**
   * Where the task came from. Inferred from the body shape (chat tasks
   * carry a known preamble); 'web' or 'cli' otherwise. The web's RECENT
   * TASKS panel filters out chat-sourced tasks by default since the
   * chat screen surfaces them already.
   */
  source: 'chat' | 'other'
}

/**
 * Rewrite the `model:` block of an Identity file's YAML frontmatter
 * with a new provider / model_id / optional follow-up model. Pure
 * string surgery against the YAML body, since round-tripping through
 * a YAML parser would destroy the user's comments and key ordering.
 *
 * Contract: the input must contain a frontmatter block delimited by
 * `---` lines and a `model:` mapping inside it (every Identity
 * created by the runtime has both). Throws ApiError(422) if either
 * assumption is violated; the PUT handler converts that into a
 * surfaced error so the file is never mangled.
 */
function applyModelEdit(
  raw: string,
  edit: { provider: string; model_id: string; followup_model_id?: string | null },
): string {
  const fmStart = raw.indexOf('---')
  if (fmStart === -1) {
    throw new ApiError(422, 'identity_invalid', 'Identity has no frontmatter delimiter')
  }
  const fmEnd = raw.indexOf('\n---', fmStart + 3)
  if (fmEnd === -1) {
    throw new ApiError(422, 'identity_invalid', 'Identity frontmatter is not closed')
  }
  const head = raw.slice(0, fmStart + 3)
  const fm = raw.slice(fmStart + 3, fmEnd + 1)
  const tail = raw.slice(fmEnd + 1)

  const lines = fm.split('\n')
  const modelLineIdx = lines.findIndex((l) => /^model:\s*$/.test(l))
  if (modelLineIdx === -1) {
    throw new ApiError(422, 'identity_invalid', 'Identity has no `model:` block to edit')
  }
  // Determine the indented block following `model:` and replace its
  // provider, model_id, and (optionally) followup_model_id lines.
  let blockEnd = modelLineIdx + 1
  while (blockEnd < lines.length) {
    const line = lines[blockEnd] ?? ''
    if (line === '' || /^\s/.test(line)) blockEnd++
    else break
  }
  const block = lines.slice(modelLineIdx + 1, blockEnd)
  // Detect the indent (use the first non-empty child line; default to two spaces).
  let indent = '  '
  for (const line of block) {
    const m = /^(\s+)\S/.exec(line)
    if (m?.[1] !== undefined) {
      indent = m[1]
      break
    }
  }
  // Pull out the existing provider so we can detect a switch.
  let existingProvider: string | null = null
  for (const line of block) {
    const m = /^\s+provider:\s*(\S+)/.exec(line)
    if (m?.[1] !== undefined) {
      existingProvider = m[1]
      break
    }
  }
  const providerChanged = existingProvider !== null && existingProvider !== edit.provider

  const setLine = (key: string, value: string): string => `${indent}${key}: ${value}`
  let providerSeen = false
  let modelIdSeen = false
  let followupSeen = false
  const newBlock: string[] = []
  for (const line of block) {
    const stripped = line.trim()
    if (stripped.startsWith('provider:')) {
      newBlock.push(setLine('provider', edit.provider))
      providerSeen = true
    } else if (stripped.startsWith('model_id:')) {
      newBlock.push(setLine('model_id', edit.model_id))
      modelIdSeen = true
    } else if (stripped.startsWith('followup_model_id:')) {
      followupSeen = true
      // followup_model_id is provider-specific: a deepseek-reasoner id
      // makes no sense on xAI. Drop on provider change unless the
      // caller explicitly supplied a new value.
      if (edit.followup_model_id === null) {
        // skip line
      } else if (edit.followup_model_id !== undefined) {
        newBlock.push(setLine('followup_model_id', edit.followup_model_id))
      } else if (providerChanged) {
        // skip — stale follow-up from prior provider
      } else {
        newBlock.push(line) // unchanged
      }
    } else {
      newBlock.push(line)
    }
  }
  if (!providerSeen) newBlock.unshift(setLine('provider', edit.provider))
  if (!modelIdSeen) newBlock.unshift(setLine('model_id', edit.model_id))
  if (!followupSeen && edit.followup_model_id !== null && edit.followup_model_id !== undefined) {
    newBlock.push(setLine('followup_model_id', edit.followup_model_id))
  }

  let rebuiltLines: string[] = [
    ...lines.slice(0, modelLineIdx + 1),
    ...newBlock,
    ...lines.slice(blockEnd),
  ]

  // Strip a top-level `provider_secret:` block on provider change.
  // The secret ref points at the OLD provider's env var (e.g.
  // DEEPSEEK_API_KEY); leaving it in place causes the runtime to ship
  // the wrong vendor's key to the new provider's endpoint, which
  // surfaces as a confusing "invalid API key" error from the new
  // vendor. Falling back to the registry default for the new provider
  // is the right behavior.
  if (providerChanged) {
    rebuiltLines = stripTopLevelBlock(rebuiltLines, 'provider_secret')
  }

  return head + rebuiltLines.join('\n') + tail
}

/**
 * Remove a top-level YAML mapping (header line + every contiguous
 * indented child line) from a frontmatter line array. Used when
 * `applyModelEdit` detects a provider switch and needs to clear
 * provider-specific overrides.
 */
/**
 * Replace (or insert / remove) the top-level `avatar:` line in the
 * Identity frontmatter. An empty `value` removes the line entirely so
 * the agent falls back to the generated AgentMark.
 */
function applyAvatarEdit(raw: string, value: string): string {
  const fmStart = raw.indexOf('---')
  if (fmStart === -1) {
    throw new ApiError(422, 'identity_invalid', 'Identity has no frontmatter')
  }
  const fmEnd = raw.indexOf('\n---', fmStart + 3)
  if (fmEnd === -1) {
    throw new ApiError(422, 'identity_invalid', 'Identity frontmatter is not closed')
  }
  const head = raw.slice(0, fmStart + 3)
  const fm = raw.slice(fmStart + 3, fmEnd + 1)
  const tail = raw.slice(fmEnd + 1)

  const lines = fm.split('\n')
  const filtered = lines.filter((l) => !/^avatar:\s*/.test(l))

  if (value.length > 0) {
    // Insert after agent_role: when present, otherwise at the top of
    // frontmatter (after the empty leading line).
    const idx = filtered.findIndex((l) => /^agent_role:\s*/.test(l))
    const insertAt = idx === -1 ? 1 : idx + 1
    // Quote with single quotes; the emoji is bytewise safe in YAML
    // but quoting keeps the parser happy with unusual glyphs.
    const escaped = value.replace(/'/g, "''")
    filtered.splice(insertAt, 0, `avatar: '${escaped}'`)
  }
  return head + filtered.join('\n') + tail
}

/**
 * Update sub-keys of the top-level `cost_caps:` block in Identity
 * frontmatter. Only the fields present in `patch` are touched; sibling
 * lines (reset_at, on_breach) are preserved. If the block is missing
 * entirely the helper inserts a fresh one before any blank-line
 * terminator so the Zod loader picks it up on re-parse.
 */
function applyCostCapsEdit(
  raw: string,
  patch: { daily_usd?: number | undefined; warn_at_pct?: number | undefined },
): string {
  const fmStart = raw.indexOf('---')
  if (fmStart === -1) {
    throw new ApiError(422, 'identity_invalid', 'Identity has no frontmatter')
  }
  const fmEnd = raw.indexOf('\n---', fmStart + 3)
  if (fmEnd === -1) {
    throw new ApiError(422, 'identity_invalid', 'Identity frontmatter is not closed')
  }
  const head = raw.slice(0, fmStart + 3)
  const fm = raw.slice(fmStart + 3, fmEnd + 1)
  const tail = raw.slice(fmEnd + 1)

  const lines = fm.split('\n')
  const headerIdx = lines.findIndex((l) => /^cost_caps:\s*$/.test(l))

  if (headerIdx === -1) {
    // No block ... synthesize one and insert at the bottom of the
    // frontmatter (before the final blank line, if any).
    const block = [
      'cost_caps:',
      `  daily_usd: ${String(patch.daily_usd ?? 50)}`,
      `  warn_at_pct: ${String(patch.warn_at_pct ?? 80)}`,
      '  reset_at: 00:00 UTC',
      '  on_breach: block_new_tasks',
    ]
    // Insert right before the trailing newline that precedes `---`.
    const insertAt =
      lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
    lines.splice(insertAt, 0, ...block)
    return head + lines.join('\n') + tail
  }

  // Walk the block's child lines and update matching keys in-place.
  // Stop at the next non-indented, non-empty line.
  let i = headerIdx + 1
  let sawDaily = false
  let sawWarn = false
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line !== '' && !/^\s/.test(line)) break
    if (patch.daily_usd !== undefined && /^\s+daily_usd:\s*/.test(line)) {
      lines[i] = `  daily_usd: ${String(patch.daily_usd)}`
      sawDaily = true
    } else if (patch.warn_at_pct !== undefined && /^\s+warn_at_pct:\s*/.test(line)) {
      lines[i] = `  warn_at_pct: ${String(patch.warn_at_pct)}`
      sawWarn = true
    }
    i++
  }
  // Insert any patch field that didn't already exist as a child line.
  const inserts: string[] = []
  if (patch.daily_usd !== undefined && !sawDaily) {
    inserts.push(`  daily_usd: ${String(patch.daily_usd)}`)
  }
  if (patch.warn_at_pct !== undefined && !sawWarn) {
    inserts.push(`  warn_at_pct: ${String(patch.warn_at_pct)}`)
  }
  if (inserts.length > 0) {
    lines.splice(headerIdx + 1, 0, ...inserts)
  }
  return head + lines.join('\n') + tail
}

function stripTopLevelBlock(lines: string[], key: string): string[] {
  const headerRe = new RegExp(`^${key}:\\s*$`)
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (headerRe.test(line)) {
      // Skip header.
      i++
      // Skip every following indented (or blank) child line.
      while (i < lines.length) {
        const child = lines[i] ?? ''
        if (child === '' || /^\s/.test(child)) {
          i++
        } else {
          break
        }
      }
      continue
    }
    out.push(line)
    i++
  }
  return out
}

/** Marker prefix that identifies a chat-created task body. Kept in sync with buildChatTaskBody. */
const CHAT_TASK_BODY_PREFIX = 'You are continuing a chat with the user.'

function classifyTaskSource(body: string): 'chat' | 'other' {
  return body.startsWith(CHAT_TASK_BODY_PREFIX) ? 'chat' : 'other'
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
    source: classifyTaskSource(rec.body),
    outcome_preview: preview,
  }
}

interface TaskDetailDto extends TaskListDto {
  /** The full task body (the prompt the model sees). */
  body: string
  /** Full outcome.summary when state is 'done'; null otherwise. */
  outcome_summary: string | null
  /** Full error message when state is 'errored'; null otherwise. */
  error_message: string | null
  /** Error class when state is 'errored'; null otherwise. */
  error_class: string | null
  /** Detector trip detail when blocked_on_detector. */
  detector_detail: string | null
  /** Detector trip id when blocked_on_detector. */
  detector_trip_id: string | null
  /** Latest checkpoint iteration count when checkpointed; null otherwise. */
  checkpoint_iteration: number | null
  /** Latest checkpoint taken_at timestamp when checkpointed. */
  checkpoint_taken_at: string | null
  /** Idempotency mode (pure | checkpointed | destructive). */
  idempotency: string
  /** Priority (default 0). */
  priority: number
  /**
   * Claim-vs-evidence audit summary attached to the task by the
   * post-task pipeline. Null on tasks that ran before the audit
   * substrate existed and on tasks where the audit failed silently.
   * Surface for ops + the chat-side inline audit card.
   */
  audit: TaskAuditDto | null
}

interface TaskAuditDto {
  severity: 'silent' | 'passive' | 'normal' | 'important'
  summary: string
  destructive: boolean
  at: string
  claims: {
    category: string
    verb: string
    object: string
    status: 'verified' | 'unverified' | 'contradicted'
    note: string
    path?: string
    tool?: string
    target?: string
    count?: number
    reason?: string
  }[]
}

interface ChatMessageDto {
  id: string
  ts: string
  role: 'user' | 'assistant' | 'system'
  content: string
  task_id: string | null
}

// ── Endpoint DTO ──────────────────────────────────────────────────────────

interface EndpointModelDto {
  id: string
  label?: string
}

interface EndpointDto {
  id: string
  name: string
  base_url: string
  api_key_set: boolean
  models: EndpointModelDto[]
  created_at: string
  updated_at: string
}

function toEndpointDto(e: CustomEndpoint): EndpointDto {
  return {
    id: e.id,
    name: e.name,
    base_url: e.base_url,
    api_key_set: e.api_key.length > 0,
    models: e.models.map((m) => ({
      id: m.id,
      ...(m.label !== undefined ? { label: m.label } : {}),
    })),
    created_at: e.created_at,
    updated_at: e.updated_at,
  }
}

function toChatMessageDto(m: ChatMessage): ChatMessageDto {
  return {
    id: m.id,
    ts: m.ts,
    role: m.role,
    content: m.content,
    task_id: m.task_id,
  }
}

function buildChatTaskBody(
  recent: ChatMessage[],
  newUserContent: string,
  agentName: string,
): string {
  if (recent.length === 0) {
    // First turn: just the user's message (no preamble).
    return newUserContent
  }
  const lines: string[] = []
  lines.push(
    `You are continuing a chat with the user. The transcript below is for CONTEXT ONLY ... it shows what was said in earlier turns of this conversation, but tool effects from those turns are not carried into this turn. If a prior turn appears to describe a tool call (file write, brain.write, fs.edit, etc.), that effect either succeeded earlier or did not happen ... you should never assume an effect simply because the transcript discusses it. If the user is asking you to do something, perform the necessary tool calls IN THIS TURN. After any tool calls, write a short final answer summarizing what you actually did (or could not do).`,
  )
  lines.push('')
  lines.push('--- recent transcript ---')
  for (const m of recent) {
    const speaker = m.role === 'user' ? 'user' : agentName
    lines.push(`${speaker}: ${m.content.replace(/\n/g, ' ')}`)
  }
  lines.push('--- end transcript ---')
  lines.push('')
  lines.push(`user: ${newUserContent}`)
  return lines.join('\n')
}

interface WatchAndAppendArgs {
  home: string
  agent: string
  taskId: string
  chat: ChatStore
  log: Logger | undefined
}

/**
 * Background watcher that polls the task store for `taskId` and, when
 * the task reaches a terminal state, appends an assistant message
 * into the chat log. Idempotent ... if the same taskId is already in
 * the chat log, the watcher exits without re-appending.
 */
async function watchAndAppendChatReply(args: WatchAndAppendArgs): Promise<void> {
  const { home, agent, taskId, chat, log } = args
  const taskStore = new TaskStore(home, agent)
  // Bounded poll: 5-second cadence, 20-minute timeout. Most chat
  // turns finish in under 30s.
  const deadline = Date.now() + 20 * 60_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000))
    let task: TaskRecord | null
    try {
      task = await taskStore.get(taskId)
    } catch {
      task = null
    }
    if (!task) continue
    const state = task.frontmatter.state
    if (state === 'pending' || state === 'running' || state.startsWith('blocked_')) {
      continue
    }
    // Terminal. Append once. Same caveat as the multi-chat watcher:
    // only count assistant-role messages, since tool envelopes
    // (credential_request, future notification_ask) inserted during the
    // task carry the same taskId and would otherwise block the reply.
    const messages = await chat.list()
    const already = messages.some((m) => m.role === 'assistant' && m.task_id === taskId)
    if (already) return
    let content: string
    if (state === 'done' && task.frontmatter.outcome) {
      content = task.frontmatter.outcome.summary
    } else if (state === 'errored' && task.frontmatter.error) {
      content = `(error · ${task.frontmatter.error.class}) ${task.frontmatter.error.message}`
    } else {
      content = `(task ended in state '${state}' with no outcome)`
    }
    await chat.append({ role: 'assistant', content, taskId })
    log?.info('chat reply appended', { agent, taskId, state })
    return
  }
  log?.warn('chat reply watcher timed out', { agent, taskId })
}

// ── Multi-chat helpers ─────────────────────────────────────────────────────

interface MultiChatThreadDto {
  id: string
  title: string
  created_at: string
  updated_at: string
  unread: boolean
  archived: boolean
  snippet: string
  last_user_at: string | null
}

function toMultiChatThreadDto(t: ChatThread): MultiChatThreadDto {
  return {
    id: t.id,
    title: t.title,
    created_at: t.created_at,
    updated_at: t.updated_at,
    unread: t.unread,
    archived: t.archived,
    snippet: t.snippet,
    last_user_at: t.last_user_at,
  }
}

interface MultiChatMessageDto {
  id: string
  chat_id: string
  ts: string
  role: 'user' | 'assistant' | 'system'
  body: string
  mode: 'pure' | 'checkpointed' | 'destructive' | null
  attachments: {
    id: string
    kind: 'file' | 'image'
    name: string
    size: number
    mime: string
  }[]
  task_id: string | null
  /**
   * Runtime-side discriminator for system-authored messages. Currently
   * just `audit` (claim-vs-evidence audit card); future system kinds
   * pick their own enum value.
   */
  kind: 'audit' | 'credential_request' | null
}

function toMultiChatMessageDto(m: MultiChatMessage): MultiChatMessageDto {
  return {
    id: m.id,
    chat_id: m.chat_id,
    ts: m.ts,
    role: m.role,
    body: m.body,
    mode: m.mode,
    attachments: m.attachments,
    task_id: m.task_id,
    kind: m.kind,
  }
}

interface WatchAndAppendThreadArgs {
  home: string
  agent: string
  chatId: string
  taskId: string
  store: MultiChatStore
  broadcast: (
    event:
      | 'chat.message'
      | 'chat.created'
      | 'chat.renamed'
      | 'chat.archived'
      | 'chat.read'
      | 'chat.audit_flag',
    agentName: string,
    chatId: string,
    payload: Record<string, unknown>,
  ) => void
  log: Logger | undefined
}

/**
 * Multi-chat counterpart to watchAndAppendChatReply. Polls the task
 * store for `taskId` and, when terminal, appends an assistant
 * message into the multi-chat thread + broadcasts a chat.message WS
 * event. Idempotent ... if a message with this taskId already exists
 * in the thread, exits without appending.
 */
async function watchAndAppendChatThreadReply(args: WatchAndAppendThreadArgs): Promise<void> {
  const { home, agent, chatId, taskId, store, broadcast, log } = args
  const taskStore = new TaskStore(home, agent)
  const deadline = Date.now() + 20 * 60_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000))
    let task: TaskRecord | null
    try {
      task = await taskStore.get(taskId)
    } catch {
      task = null
    }
    if (!task) continue
    const state = task.frontmatter.state
    if (state === 'pending' || state === 'running' || state.startsWith('blocked_')) {
      continue
    }
    // Idempotency check: only count prior ASSISTANT-role messages. Tools
    // like `credential_request` insert system-role envelope messages with
    // the same taskId; counting those would make the watcher bail and the
    // assistant's final reply would never appear in the thread (the
    // operator only sees the tool-strip and never the "got it" message).
    const messages = await store.listMessages(chatId)
    const already = messages.some((m) => m.role === 'assistant' && m.task_id === taskId)
    if (already) return
    let body: string
    if (state === 'done' && task.frontmatter.outcome) {
      body = task.frontmatter.outcome.summary
    } else if (state === 'errored' && task.frontmatter.error) {
      body = `(error · ${task.frontmatter.error.class}) ${task.frontmatter.error.message}`
    } else {
      body = `(task ended in state '${state}' with no outcome)`
    }
    const msg = await store.appendMessage({
      chatId,
      role: 'assistant',
      body,
      taskId,
    })
    broadcast('chat.message', agent, chatId, { message: toMultiChatMessageDto(msg) })
    log?.info('multi-chat reply appended', { agent, chatId, taskId, state })
    // Claim-vs-evidence audit surfacing. The audit pass writes its
    // result to task.frontmatter.audit before the task transitions to
    // 'done'; we render it as a system-role chat card with
    // `kind: 'audit'` whenever severity routes above 'silent'. The
    // body is a stable JSON envelope so the web renderer can show the
    // structured card; clients that don't recognize the kind fall
    // back to displaying the body verbatim.
    const audit = task.frontmatter.audit
    if (audit && audit.severity !== 'silent') {
      try {
        const auditMsg = await store.appendMessage({
          chatId,
          role: 'system',
          kind: 'audit',
          body: JSON.stringify({
            envelope: 'audit_card_v1',
            task_id: taskId,
            severity: audit.severity,
            summary: audit.summary,
            destructive: audit.destructive,
            at: audit.at,
            claims: audit.claims,
          }),
          taskId,
        })
        broadcast('chat.audit_flag', agent, chatId, {
          message: toMultiChatMessageDto(auditMsg),
          severity: audit.severity,
          summary: audit.summary,
        })
      } catch (err) {
        log?.warn('multi-chat audit card append failed', {
          agent,
          chatId,
          taskId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return
  }
  log?.warn('multi-chat reply watcher timed out', { agent, chatId, taskId })
}

function toTaskDetailDto(rec: TaskRecord): TaskDetailDto {
  const list = toTaskListDto(rec)
  const fm = rec.frontmatter
  return {
    ...list,
    body: rec.body,
    outcome_summary: fm.outcome?.summary ?? null,
    error_message: fm.error?.message ?? null,
    error_class: fm.error?.class ?? null,
    detector_detail: fm.detector_block?.detail ?? null,
    detector_trip_id: fm.detector_block?.trip_id ?? null,
    checkpoint_iteration: fm.checkpoint?.iteration ?? null,
    checkpoint_taken_at: fm.checkpoint?.taken_at ?? null,
    idempotency: fm.idempotency,
    priority: fm.priority,
    audit: fm.audit
      ? {
          severity: fm.audit.severity,
          summary: fm.audit.summary,
          destructive: fm.audit.destructive,
          at: fm.audit.at,
          claims: fm.audit.claims.map((c) => {
            const out: TaskAuditDto['claims'][number] = {
              category: c.category,
              verb: c.verb,
              object: c.object,
              status: c.status,
              note: c.note,
            }
            if (c.path !== undefined) out.path = c.path
            if (c.tool !== undefined) out.tool = c.tool
            if (c.target !== undefined) out.target = c.target
            if (c.count !== undefined) out.count = c.count
            if (c.reason !== undefined) out.reason = c.reason
            return out
          }),
        }
      : null,
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
