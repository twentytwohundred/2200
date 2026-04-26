/**
 * JSON-RPC 2.0 server over a `Connection`.
 *
 * Reads NDJSON from a transport `Connection`, validates each incoming message
 * as a JSON-RPC request, dispatches to a registered handler, and writes the
 * response (or error) back to the same connection.
 *
 * Validation is two-stage: (1) the JSON-RPC envelope is checked via
 * `JsonRpcRequestSchema`, then (2) the method-specific `params` schema from
 * `METHODS` is applied. Both failures produce JSON-RPC error responses with
 * the standard error codes.
 *
 * Handlers throw on internal errors; the server catches and surfaces as
 * `HANDLER_ERROR`. Handlers should validate any cross-cutting state (like
 * "is this Agent allowed to call this method") themselves; the server only
 * enforces protocol-level validity.
 */
import {
  JsonRpcErrorCodes,
  JsonRpcRequestSchema,
  METHODS,
  type JsonRpcResponse,
  type MethodName,
  type ParamsOf,
  type ResultOf,
} from './protocol.js'
import type { Connection } from './transport.js'
import { createLogger, type Logger } from '../util/logger.js'

export type Handler<M extends MethodName> = (
  params: ParamsOf<M>,
  ctx: HandlerContext,
) => Promise<ResultOf<M>> | ResultOf<M>

export interface HandlerContext {
  /** The connection the request arrived on. Useful for binding handlers to a peer's identity. */
  readonly connection: Connection
  /** The JSON-RPC request id (echoed back in the response). */
  readonly requestId: number | string
}

export type Handlers = {
  [M in MethodName]?: Handler<M>
}

export class JsonRpcServer {
  private readonly handlers: Handlers
  private readonly log: Logger

  constructor(handlers: Handlers, log?: Logger) {
    this.handlers = handlers
    this.log = log ?? createLogger('json-rpc-server')
  }

  /**
   * Run the server loop on a single connection. Returns when the connection
   * closes or an unrecoverable read error occurs. Errors during individual
   * request processing are caught and returned as JSON-RPC errors; they do
   * not terminate the loop.
   */
  async serve(connection: Connection): Promise<void> {
    for await (const line of connection.read()) {
      if (connection.closed) break
      // Process each line concurrently so a slow handler does not block the
      // next request on the same connection. Handlers MUST be safe under
      // concurrent invocation per their own contracts.
      void this.handleLine(connection, line).catch((err: unknown) => {
        this.log.error('unhandled error in handleLine', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }
  }

  private async handleLine(connection: Connection, line: string): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      await this.writeError(connection, null, JsonRpcErrorCodes.PARSE_ERROR, 'parse error')
      return
    }

    const reqResult = JsonRpcRequestSchema.safeParse(parsed)
    if (!reqResult.success) {
      const id =
        parsed && typeof parsed === 'object' && 'id' in parsed
          ? (((parsed as Record<string, unknown>)['id'] as number | string | null | undefined) ??
            null)
          : null
      await this.writeError(
        connection,
        id ?? null,
        JsonRpcErrorCodes.INVALID_REQUEST,
        'invalid request envelope',
        reqResult.error.issues,
      )
      return
    }

    const req = reqResult.data
    const methodDef = (METHODS as Record<string, (typeof METHODS)[MethodName] | undefined>)[
      req.method
    ]
    if (!methodDef) {
      await this.writeError(
        connection,
        req.id,
        JsonRpcErrorCodes.METHOD_NOT_FOUND,
        `method not found: ${req.method}`,
      )
      return
    }

    const paramsResult = methodDef.params.safeParse(req.params ?? {})
    if (!paramsResult.success) {
      await this.writeError(
        connection,
        req.id,
        JsonRpcErrorCodes.INVALID_PARAMS,
        'invalid params',
        paramsResult.error.issues,
      )
      return
    }

    const handler = this.handlers[req.method as MethodName]
    if (!handler) {
      await this.writeError(
        connection,
        req.id,
        JsonRpcErrorCodes.METHOD_NOT_FOUND,
        `no handler registered for ${req.method}`,
      )
      return
    }

    try {
      // Cast: the validator above ensures `paramsResult.data` matches the
      // ParamsOf<M> for `req.method`; TypeScript cannot narrow the handler
      // union without runtime branching on `req.method`. Both the handler
      // and the params are widened to `unknown`/`any`-equivalent at this
      // boundary; the validation guarantees their compatibility.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const typedHandler = handler as (params: any, ctx: HandlerContext) => unknown
      const result = await typedHandler(paramsResult.data, {
        connection,
        requestId: req.id,
      })
      const resultParse = methodDef.result.safeParse(result)
      if (!resultParse.success) {
        this.log.error('handler returned invalid result', {
          method: req.method,
          issues: resultParse.error.issues,
        })
        await this.writeError(
          connection,
          req.id,
          JsonRpcErrorCodes.INTERNAL_ERROR,
          'handler returned invalid result',
        )
        return
      }
      const response: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: req.id,
        result: resultParse.data,
      }
      await connection.write(JSON.stringify(response))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log.warn('handler threw', { method: req.method, error: message })
      await this.writeError(connection, req.id, JsonRpcErrorCodes.HANDLER_ERROR, message)
    }
  }

  private async writeError(
    connection: Connection,
    id: number | string | null,
    code: number,
    message: string,
    data?: unknown,
  ): Promise<void> {
    if (connection.closed) return
    // JSON-RPC requires `id` on every response, even for parse errors. When
    // we cannot determine the request's id (parse error before envelope), we
    // pass null per the spec.
    const response: JsonRpcResponse & { id: number | string } = {
      jsonrpc: '2.0',
      id: id ?? 0,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    }
    try {
      await connection.write(JSON.stringify(response))
    } catch {
      // peer may have disconnected; ignore
    }
  }
}
