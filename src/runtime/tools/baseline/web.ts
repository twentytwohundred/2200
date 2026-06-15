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
 * web.search delegates to the Brave Search API (`searchWeb`), keyed by
 * BRAVE_API_KEY in the runtime env. When no key is configured it returns a
 * clear, actionable status (how to enable) rather than silently empty.
 */
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../../mcp/tool.js'
import { searchWeb } from '../web-search.js'

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
  name: 'web_fetch',
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
  name: 'web_search',
  description:
    'Search the web via the Brave Search API and return ranked results (url, title, snippet). ' +
    'If web search is not configured, the result `status` explains how to enable it.',
  idempotency: 'pure',
  argsSchema: WebSearchArgsSchema,
  execute: async (args) => {
    const outcome = await searchWeb(args.query, args.max_results)
    return {
      results: outcome.results,
      provider: outcome.provider,
      status: outcome.status,
      query: args.query,
      max_results: args.max_results,
    }
  },
})

export const webTools: ToolDefinition[] = [webFetch, webSearch]
