/**
 * MCP connector Fastify listener.
 *
 * Lives on a dedicated port (default 2201, configurable via
 * TWENTYTWOHUNDRED_CONNECTOR_PORT). Separate from the web UI listener
 * for blast-radius isolation: the web UI listener is loopback-bound
 * and never reachable through the user's tunnel; the connector
 * listener is bound to 0.0.0.0 and is exactly what the tunnel points
 * at.
 *
 * Auth model: bearer-only. Every request must present
 * `Authorization: Bearer <stored-bearer>`. Compare is constant-time
 * after a length check. No fallback-allow ... if the vault has no
 * token, the listener does not bind in the first place.
 *
 * Threat-model notes (Grok review, 2026-05-22):
 *  - Once the user pastes the bearer into grok.com/connectors, the
 *    provider holds a copy. The bearer is "long-lived but revocable
 *    from our side," not "secret from the provider."
 *  - Replay within a single HTTPS connection is by design. The MCP
 *    transport's session-id mechanism is separate from the bearer
 *    and is the right place for protocol-level replay concerns.
 *  - Fastify's bodyLimit + connection limits provide a baseline DoS
 *    floor; tune in follow-ups if real usage surfaces a problem.
 */
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify'
import { timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'
import type { ConnectorAuditEmitter, ConnectorAuthRejectionContext } from './audit.js'
import type { ConnectorMcpServerHandle, ConnectorMcpServerDeps } from './server.js'
import { createConnectorMcpServer } from './server.js'
import { readBearer } from './bearer-store.js'
import { mountOAuthServer, verifyOAuthBearer } from './oauth/server.js'
import { isAccessTokenShape } from './oauth/token-store.js'

export interface StartConnectorListenerArgs {
  /** 2200 home directory; used by the bearer-store and audit emitter. */
  home: string
  /** Listening port. 0 means "OS-assigned"; useful for tests. */
  port: number
  /** Audit emitter shared with the supervisor's notification path. */
  audit: ConnectorAuditEmitter
  /** Override the bind host. Default 0.0.0.0 (public; behind user's tunnel). */
  host?: string
  /** Hard cap on request body bytes. Default 8 MiB ... PR 2 widened from 1 MiB to fit contribute_to_thread payloads. */
  bodyLimitBytes?: number
  /**
   * Supervisor-side dependencies for the MCP tool surface
   * (snapshot reader for `get_fleet_context`; known-agent set
   * for `contribute_to_thread` agent-target validation).
   */
  serverDeps: Omit<ConnectorMcpServerDeps, 'home' | 'audit'>
}

export interface ConnectorListenerHandle {
  readonly port: number
  readonly host: string
  /** Stop accepting new connections; close MCP server; resolve when done. */
  close(reason?: string): Promise<void>
}

const DEFAULT_HOST = '0.0.0.0'
// 8 MiB body limit. PR 2 widened from 1 MiB to fit
// `contribute_to_thread` payloads (research blobs, long transcripts,
// source lists). Operators can raise further via the supervisor's
// `connector.bodyLimitBytes` option (env: `TWENTYTWOHUNDRED_CONNECTOR_BODY_LIMIT_BYTES`).
// Note: this listener is public-internet-facing (behind the user's
// tunnel) — a larger body limit is a larger DoS surface. The decision
// record at wiki/decisions/2026-05-23-mcp-connector-phase1-as-shipped.md
// captures the trade-off.
const DEFAULT_BODY_LIMIT_BYTES = 8 * 1024 * 1024

/**
 * Start the connector listener. Throws if no bearer is provisioned ...
 * the supervisor's lifecycle code is responsible for checking
 * hasBearer() before calling start.
 */
export async function startConnectorListener(
  args: StartConnectorListenerArgs,
): Promise<ConnectorListenerHandle> {
  const bearerRecord = await readBearer(args.home)
  if (bearerRecord === null) {
    throw new Error(
      'connector listener start refused: no bearer token in vault. Run `2200 connector token regenerate` first.',
    )
  }
  const storedTokenBytes = Buffer.from(bearerRecord.token, 'utf-8')

  // forceCloseConnections: ensures fastify.close() does not hang on
  // an open SSE stream during regenerate-bounce. The MCP transport
  // gets closed first in `close()` below so streams terminate cleanly
  // from the server side; forceCloseConnections is the belt to the
  // suspenders for any keep-alive that slipped through.
  //
  // connectionTimeout: 60s covers MCP initialize + first request. A
  // slow client cannot tie up a connection slot forever. SSE streams
  // are kept alive by data flow, not by this timeout.
  const fastify = Fastify({
    bodyLimit: args.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES,
    forceCloseConnections: true,
    connectionTimeout: 60_000,
  })

  // OAuth /token + /revoke arrive as form-urlencoded by convention.
  // Fastify v5 rejects unknown content types by default; register a
  // pass-through parser that hands the raw string to the route, which
  // then parses k=v&... pairs itself (see parseTokenBody in oauth/server.ts).
  fastify.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      done(null, body)
    },
  )

  // The OAuth Authorization Server endpoints advertise their own
  // issuer URL (RFC 8414 metadata). Since the listener doesn't know
  // its public-facing URL (the tunnel decides), derive it from each
  // request's Host / X-Forwarded-Host header on the fly. Captured
  // here so all OAuth handlers can read the most-recent value.
  let lastSeenIssuer: string | null = null
  fastify.addHook('onRequest', (req, _reply, done) => {
    const xfh = req.headers['x-forwarded-host']
    const host = typeof xfh === 'string' ? xfh : req.headers.host
    const xfp = req.headers['x-forwarded-proto']
    const proto = typeof xfp === 'string' ? xfp : 'https'
    if (typeof host === 'string' && host.length > 0) {
      lastSeenIssuer = `${proto}://${host}`
    }
    done()
  })

  // Mount the OAuth Authorization Server endpoints (Phase 2 PR-A1).
  // These live on `/oauth/*` + `/.well-known/oauth-authorization-server`
  // and are PUBLIC (the AS itself is the auth gate; protecting it with
  // bearer auth would chicken-and-egg the OAuth flow).
  mountOAuthServer(fastify, {
    home: args.home,
    audit: args.audit,
    issuerBaseUrl: () => lastSeenIssuer ?? `http://127.0.0.1:${String(args.port)}`,
  })

  // Pre-handler: routes-that-need-bearer-auth path.
  //
  // OAuth endpoints (`/oauth/*`, `/.well-known/*`) are PUBLIC — they
  // are themselves the auth gate. Every other route requires either
  // the static bearer (Phase 1 / PR 1a) OR a valid OAuth access token
  // (Phase 2 PR-A1). Both paths coexist on `/mcp`; the listener tries
  // OAuth first (token prefix disambiguates), then falls through to
  // the static-bearer check.
  fastify.addHook('preHandler', async (req, reply) => {
    if (isPublicAuthRoute(req.url)) return

    const auth = req.headers.authorization
    const presented = extractBearer(auth)
    // Try OAuth access token first — disambiguated by prefix.
    if (presented !== null && isAccessTokenShape(presented)) {
      const result = await verifyOAuthBearer(args.home, presented)
      if (result.ok) return // OAuth-authenticated; proceed to route
      await args.audit
        .emitAuthRejected({
          sourceIp: clientIp(req),
          reason: 'value_mismatch',
        })
        .catch(() => undefined)
      await reply
        .code(401)
        .header('content-type', 'application/json')
        .send({ error: 'unauthorized' })
      return
    }

    // Static-bearer path (PR 1a).
    const rejection: ConnectorAuthRejectionContext | null = classifyBearer(auth, storedTokenBytes)
    if (rejection !== null) {
      await args.audit
        .emitAuthRejected({
          sourceIp: clientIp(req),
          reason: rejection.reason,
        })
        .catch(() => undefined) // audit must never break the response path
      // 401 with no body distinguishing why. Keep the response uniform
      // so an attacker can't probe the error class to learn anything.
      await reply
        .code(401)
        .header('content-type', 'application/json')
        .send({ error: 'unauthorized' })
    }
  })

  // The MCP endpoint accepts POST (client → server), GET (SSE stream
  // for server → client notifications), and DELETE (session close).
  // Fastify routes all three under one ALL handler; the transport
  // dispatches by method internally.
  fastify.all('/mcp', async (req: FastifyRequest, reply: FastifyReply) => {
    const peek = peekMcpEnvelope(req.body)
    const ip = clientIp(req)
    // Audit fires BEFORE the transport handoff. The MCP transport
    // holds SSE streams open well past the JSON-RPC result so
    // emitting on transport-resolve would defer the audit until the
    // stream closes (review-pointed-out 2026-05-22). "Call received"
    // is the right semantic at request-receipt time.
    args.audit
      .emitCallReceived({
        sourceIp: ip,
        method: peek.method ?? 'unknown',
        ...(peek.toolName !== undefined ? { toolName: peek.toolName } : {}),
      })
      .catch(() => undefined)
    reply.hijack()
    // Per-request fresh MCP server + transport (stateless mode, locked
    // 2026-05-23 after the grok.com empirical smoke). Building the
    // McpServer is JS-only (no I/O) so the per-request cost is small;
    // the alternative — shared server with multiple sessions — pulls
    // in session tracking that grok-connectors-manager doesn't honor.
    let perRequestHandle: ConnectorMcpServerHandle | null = null
    try {
      perRequestHandle = await createConnectorMcpServer({
        home: args.home,
        audit: args.audit,
        ...args.serverDeps,
      })
      await perRequestHandle.transport.handleRequest(req.raw, reply.raw, req.body)
    } catch (err) {
      try {
        if (!reply.raw.headersSent) {
          reply.raw.statusCode = 500
          reply.raw.end()
        }
      } catch {
        // best-effort
      }
      args.audit
        .emitCallErrored({
          sourceIp: ip,
          method: peek.method ?? 'unknown',
          ...(peek.toolName !== undefined ? { toolName: peek.toolName } : {}),
          errorSummary: err instanceof Error ? err.message : String(err),
        })
        .catch(() => undefined)
    } finally {
      if (perRequestHandle !== null) {
        await perRequestHandle.close().catch(() => undefined)
      }
    }
  })

  const host = args.host ?? DEFAULT_HOST
  const boundAddress = await fastify.listen({ port: args.port, host })
  const url = new URL(boundAddress)
  const actualPort = Number.parseInt(url.port, 10)

  await args.audit
    .emitListenerStateChanged({ state: 'started', port: actualPort })
    .catch(() => undefined)

  let closing = false
  return {
    port: actualPort,
    host,
    async close(reason?: string): Promise<void> {
      if (closing) return
      closing = true
      try {
        // forceCloseConnections + per-request transport lifecycle:
        // each /mcp handler creates and closes its own ConnectorMcpServerHandle
        // (stateless mode, per the locked 2026-05-23 SDK pattern). On
        // listener close we just shut down fastify; any in-flight
        // per-request handles get force-closed via the Fastify config.
        await fastify.close()
      } finally {
        await args.audit
          .emitListenerStateChanged({
            state: 'stopped',
            port: actualPort,
            ...(reason !== undefined ? { reason } : {}),
          })
          .catch(() => undefined)
      }
    },
  }
}

/**
 * Classify the Authorization header. Returns null on accept; otherwise
 * a structured rejection reason for audit. The compare is constant
 * time on equal-length inputs; mismatched lengths short-circuit (length
 * is not a secret) but still return the same uniform 401 response to
 * the caller.
 */
/**
 * True iff the URL targets a route that should bypass the bearer
 * preHandler — the OAuth AS endpoints and its discovery metadata
 * are themselves the auth gate; protecting them with bearer auth
 * would chicken-and-egg the flow.
 */
function isPublicAuthRoute(url: string): boolean {
  // Fastify routes don't carry the query string in `req.url` matching
  // semantics, but `req.url` includes it. Strip it before prefix
  // checks.
  const path = url.split('?')[0] ?? url
  if (path.startsWith('/oauth/')) return true
  if (path === '/.well-known/oauth-authorization-server') return true
  return false
}

/** Pull the bearer string out of the Authorization header. Null if absent / not Bearer. */
function extractBearer(authHeader: string | string[] | undefined): string | null {
  const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader
  if (!raw?.startsWith('Bearer ')) return null
  return raw.slice('Bearer '.length).trim()
}

function classifyBearer(
  authHeader: string | string[] | undefined,
  storedTokenBytes: Buffer,
): ConnectorAuthRejectionContext | null {
  const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader
  if (raw === undefined || raw === '') {
    return { sourceIp: '', reason: 'missing_header' }
  }
  if (!raw.startsWith('Bearer ')) {
    return { sourceIp: '', reason: 'bad_prefix' }
  }
  const presented = raw.slice('Bearer '.length).trim()
  const presentedBytes = Buffer.from(presented, 'utf-8')
  if (presentedBytes.length !== storedTokenBytes.length) {
    return { sourceIp: '', reason: 'length_mismatch' }
  }
  if (!timingSafeEqual(presentedBytes, storedTokenBytes)) {
    return { sourceIp: '', reason: 'value_mismatch' }
  }
  return null
}

interface McpEnvelopePeek {
  method?: string
  toolName?: string
}

/** Best-effort introspection of the JSON-RPC envelope for audit. */
function peekMcpEnvelope(body: unknown): McpEnvelopePeek {
  if (typeof body !== 'object' || body === null) return {}
  const obj = body as Record<string, unknown>
  const method = typeof obj['method'] === 'string' ? obj['method'] : undefined
  let toolName: string | undefined
  if (method === 'tools/call') {
    const params = obj['params']
    if (typeof params === 'object' && params !== null) {
      const p = params as Record<string, unknown>
      if (typeof p['name'] === 'string') toolName = p['name']
    }
  }
  return {
    ...(method !== undefined ? { method } : {}),
    ...(toolName !== undefined ? { toolName } : {}),
  }
}

/**
 * Resolve a best-effort client IP from a Fastify request.
 *
 * Trust assumption: this listener sits behind the operator's own
 * tunnel (ngrok / cloudflared / Tailscale Funnel / etc.) — the
 * immediate hop is the tunnel terminator, which is the source of
 * truth for `req.ip`. `X-Forwarded-For` is what the tunnel injects
 * with the real upstream client. This is fine in the supported
 * configurations because there is exactly one trusted intermediary.
 *
 * Footgun: if an operator put a different reverse proxy in front
 * that does NOT scrub a client-supplied XFF header, an attacker
 * could spoof `sourceIp` in Inbox audit events. The audit values
 * are never used for auth or routing decisions (only for operator
 * visibility), so the blast radius is "the Inbox event names a
 * fake IP" — annoying, not exploitable. Documented here so a future
 * deployment outside the supported tunnel set knows the assumption.
 */
function clientIp(req: FastifyRequest): string {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0]
    if (first !== undefined) return first.trim()
  }
  return req.ip
}
