/**
 * web.* baseline tools (fetch, search).
 *
 * Per [[2026-04-25-tool-baseline]]:
 *   web.fetch (GET)  -> pure
 *   web.search       -> pure
 *
 * web.fetch uses the runtime's `fetch`. v1 follows GET semantics only
 * (POST/PUT/DELETE land in a future tool because they're destructive
 * and need explicit perm-check treatment).
 *
 * web.search delegates to the configured WebSearchProvider per
 * [[2026-04-26-web-search-provider]] (Tavily v1 default + Brave fallback,
 * abstraction first). The provider is constructed at Agent boot from
 * the user's `provider_secret` config; the tool reads it via context.
 *
 * v1 web.search is a stub that returns no results when no provider is
 * registered. The Agent loop or Identity wires the real provider in a
 * follow-up PR; the tool ships now to lock the dispatch shape.
 */
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../../mcp/tool.js'

// ---------------------------------------------------------------------------
// web.fetch
// ---------------------------------------------------------------------------

const WebFetchArgsSchema = z.object({
  url: z.url(),
  /** Hard cap on response bytes (defaults to 5 MiB). */
  max_bytes: z
    .number()
    .int()
    .positive()
    .max(50 * 1024 * 1024)
    .default(5 * 1024 * 1024),
  /** Override timeout (ms). Default 30s. */
  timeout_ms: z.number().int().positive().max(120_000).default(30_000),
})

export const webFetch = defineTool({
  name: 'web.fetch',
  description: 'GET a URL and return its body as text. Bounded by max_bytes and timeout_ms.',
  idempotency: 'pure',
  argsSchema: WebFetchArgsSchema,
  execute: async (args) => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, args.timeout_ms)
    try {
      const response = await fetch(args.url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
      })
      // Buffer everything, then truncate. v1 trades streaming for type
      // safety; max_bytes cap protects against huge responses.
      const buffer = await response.arrayBuffer()
      const truncated = buffer.byteLength > args.max_bytes
      const bytes = truncated ? buffer.slice(0, args.max_bytes) : buffer
      const decoder = new TextDecoder('utf-8', { fatal: false })
      return {
        status: response.status,
        body: decoder.decode(bytes),
        truncated,
        bytes: bytes.byteLength,
        content_type: response.headers.get('content-type'),
      }
    } finally {
      clearTimeout(timer)
    }
  },
})

// ---------------------------------------------------------------------------
// web.search (v1 stub awaiting provider wiring)
// ---------------------------------------------------------------------------

const WebSearchArgsSchema = z.object({
  query: z.string().min(1),
  max_results: z.number().int().positive().max(20).default(10),
})

export const webSearch = defineTool({
  name: 'web.search',
  description:
    'Search the web. v1 returns an empty result set if no provider is configured; provider wiring lands with the Agent loop integration PR.',
  idempotency: 'pure',
  argsSchema: WebSearchArgsSchema,
  execute: (args) => {
    // v1: no provider plumbed through ctx yet; return empty results
    // and a status note so the call is observable in records. The
    // Tavily/Brave wiring per the locked decision lands when the Agent
    // loop integrates the provider into the tool dispatch context.
    return Promise.resolve({
      results: [] as { url: string; title: string; snippet: string; rank: number }[],
      status: 'no provider configured at v1; see web-search-provider decision record',
      query: args.query,
      max_results: args.max_results,
    })
  },
})

export const webTools: ToolDefinition[] = [webFetch, webSearch]
