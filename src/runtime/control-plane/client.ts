/**
 * JSON-RPC 2.0 client over a `Connection`.
 *
 * Sends requests with auto-incrementing `id`s and resolves the matching
 * response. Validates the response result against the method's result
 * schema; mismatches reject the call promise with a structured error.
 *
 * Concurrent requests on the same connection are supported: outstanding
 * requests are tracked by `id`, and responses are routed to the right
 * waiter. On connection close, all outstanding requests reject.
 */
import {
  JsonRpcResponseSchema,
  METHODS,
  type MethodName,
  type ParamsOf,
  type ResultOf,
} from './protocol.js'
import type { Connection } from './transport.js'
import { createLogger, type Logger } from '../util/logger.js'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  method: MethodName
}

export class JsonRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message)
    this.name = 'JsonRpcError'
  }
}

export class JsonRpcClient {
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly readPromise: Promise<void>
  private isClosed = false
  private readonly log: Logger

  constructor(
    private readonly connection: Connection,
    log?: Logger,
  ) {
    this.log = log ?? createLogger('json-rpc-client')
    this.readPromise = this.runReadLoop()
  }

  private async runReadLoop(): Promise<void> {
    try {
      for await (const line of this.connection.read()) {
        this.handleLine(line)
      }
    } catch (err) {
      this.log.warn('read loop error', {
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      this.markClosed(new Error('connection closed'))
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.log.warn('received non-JSON line', { length: line.length })
      return
    }
    const respResult = JsonRpcResponseSchema.safeParse(parsed)
    if (!respResult.success) {
      this.log.warn('received invalid response envelope', {
        issues: respResult.error.issues,
      })
      return
    }
    const resp = respResult.data
    const id = typeof resp.id === 'number' ? resp.id : null
    if (id === null) {
      // String-id responses are valid per spec but we never emit them; ignore.
      return
    }
    const pending = this.pending.get(id)
    if (!pending) {
      this.log.warn('received response for unknown id', { id })
      return
    }
    this.pending.delete(id)
    if (resp.error) {
      pending.reject(new JsonRpcError(resp.error.code, resp.error.message, resp.error.data))
      return
    }
    const methodDef = METHODS[pending.method]
    const resultParse = methodDef.result.safeParse(resp.result)
    if (!resultParse.success) {
      pending.reject(
        new JsonRpcError(-32603, 'response result failed validation', resultParse.error.issues),
      )
      return
    }
    pending.resolve(resultParse.data)
  }

  private markClosed(err: Error): void {
    if (this.isClosed) return
    this.isClosed = true
    for (const pending of this.pending.values()) {
      pending.reject(err)
    }
    this.pending.clear()
  }

  async call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    if (this.isClosed) {
      throw new JsonRpcError(-32603, 'client is closed')
    }
    const id = this.nextId++
    const request = {
      jsonrpc: '2.0' as const,
      id,
      method,
      params,
    }
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
    })
    try {
      await this.connection.write(JSON.stringify(request))
    } catch (err) {
      this.pending.delete(id)
      throw err
    }
    return (await promise) as ResultOf<M>
  }

  async close(): Promise<void> {
    this.markClosed(new Error('client closed by caller'))
    await this.connection.close()
    await this.readPromise
  }
}
