/**
 * API-key validation for the cloud providers we support.
 *
 * Hits a cheap, idempotent endpoint (typically `GET /v1/models`) with
 * the pasted key and classifies the result. Used during first-run to
 * catch typos at paste time so the operator doesn't surface them
 * later as confusing LLM errors when an Agent tries to chat.
 *
 * Result classification:
 *   - `ok`           : 2xx response. Key is valid.
 *   - `auth_failed`  : 401 / 403. Key is wrong or revoked.
 *   - `network_error`: fetch threw (DNS, offline, etc). Caller decides
 *                      whether to soft-yes (save the key, warn) or
 *                      hard-no (require operator to retry online).
 *   - `unexpected`   : non-2xx, non-auth response. Surfaced as text so
 *                      the operator can read what the provider said.
 */
import type { ProviderCatalogEntry } from './registry.js'

export type ValidateKeyResult =
  | { ok: true }
  | { ok: false; reason: 'auth_failed'; status: number; message: string }
  | { ok: false; reason: 'network_error'; message: string }
  | { ok: false; reason: 'unexpected'; status: number; message: string }

export interface ValidateKeyArgs {
  provider: ProviderCatalogEntry
  apiKey: string
  /** Inject for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch
}

const ANTHROPIC_VERSION = '2023-06-01'

export async function validateProviderKey(args: ValidateKeyArgs): Promise<ValidateKeyResult> {
  const fetchImpl = args.fetchImpl ?? fetch
  const trimmed = args.apiKey.trim()
  if (trimmed.length === 0) {
    return { ok: false, reason: 'auth_failed', status: 0, message: 'empty key' }
  }
  // Per-provider request shape. Most providers expose `GET /v1/models`
  // which is free / unbilled and returns a quick 401 on bad auth.
  // Anthropic uses the `x-api-key` header convention rather than
  // Bearer; everyone else takes a Bearer token.
  const url = `${args.provider.baseUrl.replace(/\/+$/, '')}/v1/models`
  const headers: Record<string, string> = {}
  if (args.provider.kind === 'anthropic') {
    headers['x-api-key'] = trimmed
    headers['anthropic-version'] = ANTHROPIC_VERSION
  } else {
    headers['Authorization'] = `Bearer ${trimmed}`
  }
  let resp: Response
  try {
    resp = await fetchImpl(url, { method: 'GET', headers })
  } catch (err) {
    return {
      ok: false,
      reason: 'network_error',
      message: err instanceof Error ? err.message : String(err),
    }
  }
  if (resp.ok) return { ok: true }
  if (resp.status === 401 || resp.status === 403) {
    return {
      ok: false,
      reason: 'auth_failed',
      status: resp.status,
      message: await readBodySnippet(resp),
    }
  }
  return {
    ok: false,
    reason: 'unexpected',
    status: resp.status,
    message: await readBodySnippet(resp),
  }
}

/**
 * Validate a local / self-hosted OpenAI-compatible endpoint (Ollama, LM
 * Studio, vLLM, llama.cpp, ...) by hitting its `/v1/models`. The key is
 * OPTIONAL: a tailnet/LAN-hosted server is usually authed at the network
 * layer, so we send no `Authorization` header when no key is given. A `401/
 * 403` means the server actually wants a key. Normalizes the two base-URL
 * shapes (`…:11434` and `…:11434/v1`) the way the OpenAI provider does.
 */
export async function validateLocalEndpoint(args: {
  baseUrl: string
  apiKey?: string
  fetchImpl?: typeof fetch
}): Promise<ValidateKeyResult> {
  const fetchImpl = args.fetchImpl ?? fetch
  const base = args.baseUrl.trim().replace(/\/+$/, '')
  if (base.length === 0) {
    return { ok: false, reason: 'unexpected', status: 0, message: 'empty base URL' }
  }
  const url = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`
  const headers: Record<string, string> = {}
  const key = (args.apiKey ?? '').trim()
  if (key.length > 0) headers['Authorization'] = `Bearer ${key}`
  let resp: Response
  try {
    resp = await fetchImpl(url, { method: 'GET', headers })
  } catch (err) {
    return {
      ok: false,
      reason: 'network_error',
      message: err instanceof Error ? err.message : String(err),
    }
  }
  if (resp.ok) return { ok: true }
  if (resp.status === 401 || resp.status === 403) {
    return {
      ok: false,
      reason: 'auth_failed',
      status: resp.status,
      message: await readBodySnippet(resp),
    }
  }
  return {
    ok: false,
    reason: 'unexpected',
    status: resp.status,
    message: await readBodySnippet(resp),
  }
}

async function readBodySnippet(resp: Response): Promise<string> {
  try {
    const text = await resp.text()
    return text.length > 400 ? `${text.slice(0, 400)}...` : text
  } catch {
    return `(unable to read response body)`
  }
}
