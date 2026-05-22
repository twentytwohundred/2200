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
import type { ConnectorMcpServerHandle } from './server.js'
import { createConnectorMcpServer } from './server.js'
import { readBearer } from './bearer-store.js'

export interface StartConnectorListenerArgs {
  /** 2200 home directory; used by the bearer-store and audit emitter. */
  home: string
  /** Listening port. 0 means "OS-assigned"; useful for tests. */
  port: number
  /** Audit emitter shared with the supervisor's notification path. */
  audit: ConnectorAuditEmitter
  /** Override the bind host. Default 0.0.0.0 (public; behind user's tunnel). */
  host?: string
  /** Hard cap on request body bytes. Default 1MB ... MCP payloads are small. */
  bodyLimitBytes?: number
}

export interface ConnectorListenerHandle {
  readonly port: number
  readonly host: string
  /** Stop accepting new connections; close MCP server; resolve when done. */
  close(reason?: string): Promise<void>
}

const DEFAULT_HOST = '0.0.0.0'
const DEFAULT_BODY_LIMIT_BYTES = 1 * 1024 * 1024 // 1MB

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

  const mcp: ConnectorMcpServerHandle = await createConnectorMcpServer()

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

  // Pre-handler: constant-time bearer compare. No fallback-allow.
  // Emit audit on rejection (throttled per source IP in the emitter).
  fastify.addHook('preHandler', async (req, reply) => {
    const auth = req.headers.authorization
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
    try {
      await mcp.transport.handleRequest(req.raw, reply.raw, req.body)
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
        // Order matters for clean SSE termination during a regenerate
        // bounce: close the MCP transport FIRST so any held SSE
        // streams terminate from the server side, then fastify.close()
        // completes promptly. forceCloseConnections is a safety net.
        await mcp.close().catch(() => undefined)
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

/** Resolve a best-effort client IP from a Fastify request. */
function clientIp(req: FastifyRequest): string {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0]
    if (first !== undefined) return first.trim()
  }
  return req.ip
}
