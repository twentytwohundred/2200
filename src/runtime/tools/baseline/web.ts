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
 * web.search delegates to `searchWeb` (Brave / Gemini / Google, bring-your-
 * own-key). It reads the search keys from `runtime.env` at call time, so a key
 * added in Settings → Web Search works on the NEXT search without restarting
 * the daemon or the agent. When nothing is configured it returns a clear,
 * actionable status rather than silently empty.
 */
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../../mcp/tool.js'
import { defaultRuntimeEnvPath, loadRuntimeEnv } from '../../config/runtime-env.js'
import { mergeLiveSearchKeys, searchWeb } from '../web-search.js'

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

/**
 * Where to read live search keys from. The default is the canonical
 * `~/.config/2200/runtime.env` (what Settings writes); `TWENTYTWOHUNDRED_RUNTIME_ENV`
 * overrides it (used by tests, and for non-default daemon homes).
 */
function searchRuntimeEnvPath(): string {
  return process.env['TWENTYTWOHUNDRED_RUNTIME_ENV'] ?? defaultRuntimeEnvPath()
}

/**
 * The env the search providers should resolve against: the spawn-time
 * `process.env` with the current runtime.env search keys overlaid, so a key
 * added in Settings applies without a restart. Any read/parse failure falls
 * back to `process.env` ... a bad runtime.env must never break search.
 */
async function liveSearchEnv(): Promise<NodeJS.ProcessEnv> {
  try {
    return mergeLiveSearchKeys(process.env, await loadRuntimeEnv(searchRuntimeEnvPath()))
  } catch {
    return process.env
  }
}

export const webSearch = defineTool({
  name: 'web_search',
  description:
    'Search the web (Brave / Gemini / Google, whichever is configured) and return ranked ' +
    'results (url, title, snippet). If web search is not configured, the result `status` ' +
    'explains how to enable it.',
  idempotency: 'pure',
  argsSchema: WebSearchArgsSchema,
  execute: async (args) => {
    const outcome = await searchWeb(args.query, args.max_results, await liveSearchEnv())
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
