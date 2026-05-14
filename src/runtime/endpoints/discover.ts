/**
 * Discover models exposed by an OpenAI-compatible chat-completions
 * server. The convention is `GET <base_url>/models` returning
 * `{ data: [{ id, ... }], object: "list" }`. vLLM, TGI, LM Studio,
 * llama.cpp-server, Ollama (via /v1) and several aggregators all
 * implement this shape.
 *
 * The optional bearer is forwarded as `Authorization: Bearer <token>`.
 * No auth is sent when the token is the empty string ... common on
 * trusted homelab LANs.
 *
 * If the call succeeds but the body isn't shaped like the OpenAI list
 * response, we surface an EndpointDiscoveryError with kind:
 * `unexpected_shape` so the UI can show a helpful "this URL doesn't
 * speak OpenAI-compatible /models" message and the user can either
 * fix the URL or enter model ids manually.
 */
import { z } from 'zod'

export const DiscoveredModelSchema = z.object({
  id: z.string().min(1),
  object: z.string().optional(),
  owned_by: z.string().optional(),
  created: z.number().optional(),
})
export type DiscoveredModel = z.infer<typeof DiscoveredModelSchema>

const ModelsResponseSchema = z.object({
  object: z.string().optional(),
  data: z.array(DiscoveredModelSchema),
})

export type DiscoveryErrorKind =
  | 'network'
  | 'http_status'
  | 'parse_error'
  | 'unexpected_shape'
  | 'timeout'

export class EndpointDiscoveryError extends Error {
  readonly kind: DiscoveryErrorKind
  readonly status?: number
  constructor(kind: DiscoveryErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'EndpointDiscoveryError'
    this.kind = kind
    if (status !== undefined) this.status = status
  }
}

export interface DiscoverArgs {
  baseUrl: string
  apiKey?: string
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch
  /** Abort timeout in ms; defaults to 8000. */
  timeoutMs?: number
}

/**
 * Hit `<baseUrl>/models` and parse the response. Returns the list of
 * model ids (and optional metadata). Throws EndpointDiscoveryError on
 * any failure mode.
 */
export async function discoverModels(args: DiscoverArgs): Promise<DiscoveredModel[]> {
  const url = joinUrl(args.baseUrl, 'models')
  const headers: Record<string, string> = { accept: 'application/json' }
  if (args.apiKey !== undefined && args.apiKey.length > 0) {
    headers['authorization'] = `Bearer ${args.apiKey}`
  }
  const fetchImpl = args.fetchImpl ?? fetch
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, args.timeoutMs ?? 8000)

  let res: Response
  try {
    res = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal })
  } catch (err) {
    clearTimeout(timeout)
    if (err instanceof Error && err.name === 'AbortError') {
      throw new EndpointDiscoveryError('timeout', `request to ${url} timed out`)
    }
    throw new EndpointDiscoveryError(
      'network',
      `cannot reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    clearTimeout(timeout)
  }

  if (!res.ok) {
    const text = await safeReadText(res)
    throw new EndpointDiscoveryError(
      'http_status',
      `${url} returned HTTP ${String(res.status)}${text ? `: ${text.slice(0, 200)}` : ''}`,
      res.status,
    )
  }

  let body: unknown
  try {
    body = await res.json()
  } catch (err) {
    throw new EndpointDiscoveryError(
      'parse_error',
      `${url} did not return JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const parsed = ModelsResponseSchema.safeParse(body)
  if (!parsed.success) {
    throw new EndpointDiscoveryError(
      'unexpected_shape',
      `${url} did not return an OpenAI-compatible /models response. Expected {"data":[{"id":"..."}]}.`,
    )
  }
  return parsed.data.data
}

/**
 * Strip trailing slashes from base then append the path segment.
 */
function joinUrl(base: string, path: string): string {
  const trimmed = base.replace(/\/+$/, '')
  return `${trimmed}/${path.replace(/^\/+/, '')}`
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
