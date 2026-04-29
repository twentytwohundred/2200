/**
 * Typed HTTP client over the runtime's v1 API.
 *
 * The frontend never imports runtime types ... it talks to the runtime
 * over the documented HTTP+WebSocket surface only. The wire shapes
 * defined here are the frontend's view of the contract; the runtime's
 * types are independent (see wiki/conventions/runtime-api.md).
 */
import { getToken } from './auth'

export interface ListEnvelope<T> {
  items: T[]
  cursor: { next: string | null; limit: number }
}

export interface ApiErrorBody {
  code: string
  message: string
  status: number
  details?: Record<string, unknown>
  request_id: string
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId: string
  readonly details: Record<string, unknown> | undefined

  constructor(body: ApiErrorBody) {
    super(body.message)
    this.status = body.status
    this.code = body.code
    this.requestId = body.request_id
    this.details = body.details
  }
}

export class NetworkError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'NetworkError'
  }
}

export interface Agent {
  name: string
  status: string
  pid: number | null
  current_task_id: string | null
}

export interface Notification {
  id: string
  ts: string
  tier: string
  agent: string
  kind: string
  state: string
  requires_response: boolean
  response: string | null
  resolved_at: string | null
  body: string
}

export interface Me {
  kind: 'user' | 'agent'
  name: string
  token_id: string
}

export interface RuntimeHealth {
  healthy: boolean
  components: Record<string, string>
}

export interface RuntimeVersion {
  api: string
  runtime: string
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {
    accept: 'application/json',
  }
  if (token) headers.authorization = `Bearer ${token}`
  if (opts.body !== undefined) headers['content-type'] = 'application/json; charset=utf-8'

  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers,
  }
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body)
  if (opts.signal) init.signal = opts.signal

  let res: Response
  try {
    res = await fetch(path, init)
  } catch (err) {
    throw new NetworkError(err)
  }

  const text = await res.text()
  let parsed: unknown = text
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text)
    } catch {
      /* keep as text; the caller will surface */
    }
  }

  if (!res.ok) {
    const errorBody = extractErrorBody(parsed)
    if (errorBody) throw new ApiError(errorBody)
    throw new ApiError({
      code: 'http_error',
      message: typeof parsed === 'string' ? parsed : `HTTP ${String(res.status)}`,
      status: res.status,
      request_id: 'unknown',
    })
  }

  return parsed as T
}

function extractErrorBody(parsed: unknown): ApiErrorBody | null {
  if (!parsed || typeof parsed !== 'object' || !('error' in parsed)) return null
  const body: unknown = parsed.error
  if (!body || typeof body !== 'object') return null
  const fields = body as Partial<ApiErrorBody>
  if (typeof fields.code !== 'string') return null
  if (typeof fields.message !== 'string') return null
  if (typeof fields.status !== 'number') return null
  if (typeof fields.request_id !== 'string') return null
  return {
    code: fields.code,
    message: fields.message,
    status: fields.status,
    request_id: fields.request_id,
    ...(fields.details ? { details: fields.details } : {}),
  }
}

export const api = {
  me: () => request<Me>('/api/v1/me'),
  health: () => request<RuntimeHealth>('/api/v1/runtime/health'),
  version: () => request<RuntimeVersion>('/api/v1/runtime/version'),
  agents: () => request<ListEnvelope<Agent>>('/api/v1/agents'),
  agent: (name: string) => request<Agent>(`/api/v1/agents/${encodeURIComponent(name)}`),
  notifications: (params?: { state?: string; tier?: string; agent?: string }) => {
    const qs = new URLSearchParams()
    if (params?.state) qs.set('state', params.state)
    if (params?.tier) qs.set('tier', params.tier)
    if (params?.agent) qs.set('agent', params.agent)
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    return request<ListEnvelope<Notification>>(`/api/v1/notifications${suffix}`)
  },
}

/** Internal handle for tests and hooks that need to share the request helper. */
export { request as __request }
