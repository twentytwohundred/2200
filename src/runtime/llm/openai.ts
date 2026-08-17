/**
 * OpenAI LLM provider.
 *
 * Talks to OpenAI's Chat Completions API
 * (https://platform.openai.com/docs/api-reference/chat) directly via
 * fetch. Same shape works for any OpenAI-compatible endpoint (DeepSeek,
 * MiniMax, Moonshot, Ollama, user-hosted models) when constructed with
 * `baseUrl` overridden to the vendor's URL.
 *
 * Auth: `Authorization: Bearer <KEY>`.
 */
import { LlmError } from './errors.js'
import type { LLMProvider } from './provider.js'
import type { CompletionRequest, CompletionResponse, Message, NativeToolCall } from './types.js'

const DEFAULT_BASE_URL = 'https://api.openai.com'

export interface OpenAIProviderOptions {
  /**
   * Resolved API key. The provider does not log this. Static credential ...
   * for rotating credentials (e.g. an OAuth subscription bearer that refreshes
   * out from under a long-running Agent) pass `apiKeyProvider` instead so the
   * key is read fresh per request.
   */
  apiKey?: string
  /**
   * Resolve the bearer FRESH on every request. Use for credentials that
   * rotate while the provider is alive ... the fleet `xai-subscription` OAuth
   * bearer is ~6h-lived and the background refresh rotates it, so an Agent
   * that cached it at spawn would 403 once the cached copy expired. Reading it
   * per call (cheap: decrypt one small sealed file) means the Agent always
   * uses the current token without a restart. Takes precedence over `apiKey`.
   */
  apiKeyProvider?: () => string | Promise<string>
  /**
   * Override base URL. Defaults to https://api.openai.com. Use this for
   * OpenAI-compatible endpoints: pass the vendor's URL (e.g.,
   * `https://api.deepseek.com`) and use the same provider class. The
   * provider appends `/v1/chat/completions` to this base unless
   * `endpointUrl` is set.
   */
  baseUrl?: string
  /**
   * Full chat-completions URL override. When set, the provider hits this
   * URL directly and ignores `baseUrl`. Useful for vendors whose
   * OpenAI-compatible endpoint sits at a non-standard path (e.g. Gemini's
   * `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`).
   */
  endpointUrl?: string
  /** Provider name override; defaults to "openai". Useful for openai-compatible vendors. */
  providerName?: string
  /** Inject a fetch implementation (testing). Defaults to global fetch. */
  fetchImpl?: typeof fetch
}

interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: object
  }
}

interface OpenAIChatRequest {
  model: string
  messages: { role: string; content: string }[]
  max_tokens?: number
  temperature?: number
  tools?: OpenAITool[]
  tool_choice?: 'auto' | 'none' | 'required'
}

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    /** JSON-encoded arguments string (per OpenAI's spec). */
    arguments: string
  }
}

interface OpenAIChatResponse {
  id: string
  choices: {
    message: {
      role: string
      content: string | null
      tool_calls?: OpenAIToolCall[]
    }
    finish_reason: string | null
  }[]
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    /**
     * DeepSeek-style cache hit count. DeepSeek returns this top-level on
     * `usage`. Other OpenAI-compatible vendors may not populate it.
     */
    prompt_cache_hit_tokens?: number
    /**
     * OpenAI-native style: cache hit nested under `prompt_tokens_details`.
     * The provider populates `cachedTokens` from whichever shape arrives.
     */
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

export class OpenAIProvider implements LLMProvider {
  readonly name: string
  readonly baseUrl: string
  readonly endpointUrl: string
  private readonly apiKey: string
  private readonly apiKeyProvider?: () => string | Promise<string>
  private readonly fetchImpl: typeof fetch
  // Set to `true` once we observe an upstream that rejects native
  // tool-use specs (vLLM without --enable-auto-tool-choice is the
  // canonical case). Subsequent calls skip the tools[] field
  // entirely so the loop falls back to the textual JSON-block tool
  // protocol. Cached on the provider instance to avoid burning a
  // round-trip per request once we know the server can't do
  // native tool use.
  private nativeToolsDisabled = false

  constructor(opts: OpenAIProviderOptions) {
    if (opts.apiKey === undefined && opts.apiKeyProvider === undefined) {
      throw new Error('OpenAIProvider requires either apiKey or apiKeyProvider')
    }
    this.apiKey = opts.apiKey ?? ''
    if (opts.apiKeyProvider) this.apiKeyProvider = opts.apiKeyProvider
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL
    // Handle the two conventional baseUrl shapes:
    //   1. Without `/v1` suffix (legacy 2200 shape):
    //        http://host:8000   -> http://host:8000/v1/chat/completions
    //   2. With `/v1` suffix (standard OpenAI client shape that most
    //      vLLM / Ollama / LM Studio docs print):
    //        http://host:8000/v1 -> http://host:8000/v1/chat/completions
    // Without this normalization, a baseUrl ending in `/v1` was
    // producing `/v1/v1/chat/completions` and the upstream returned
    // a confusing "model not found (404)" because the URL didn't
    // route to the chat endpoint at all.
    const base = this.baseUrl.replace(/\/+$/, '')
    this.endpointUrl =
      opts.endpointUrl ??
      (base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`)
    this.name = opts.providerName ?? 'openai'
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const messages = toOpenAIMessages(request.messages, request.systemPrompt)

    const body: OpenAIChatRequest = {
      model: request.modelId,
      messages,
    }
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens
    if (request.temperature !== undefined) body.temperature = request.temperature
    // Native tool-use surface. OpenAI-compatible vendors that DO
    // implement function calling (OpenAI itself, kimi, openrouter
    // pass-through, gemini's openai-compatible endpoint) accept this
    // shape; vendors that do NOT implement it (DeepSeek, xAI, local
    // Ollama) silently ignore the field. The agent loop's fenced-text
    // parser is the universal fallback.
    const wantsNativeTools =
      !this.nativeToolsDisabled && request.tools !== undefined && request.tools.length > 0
    if (wantsNativeTools && request.tools) {
      body.tools = request.tools.map<OpenAITool>((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parametersJsonSchema,
        },
      }))
      body.tool_choice = 'auto'
    }

    // Resolve the bearer ONCE per complete() ... fresh when apiKeyProvider is
    // set (rotating subscription token), static otherwise. Used for both the
    // initial request and the native-tools-disabled retry below.
    const apiKey = this.apiKeyProvider ? await this.apiKeyProvider() : this.apiKey

    const post = async (): Promise<Response> => {
      try {
        return await this.fetchImpl(this.endpointUrl, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        })
      } catch (err) {
        throw new LlmError(
          'NETWORK_ERROR',
          `network error contacting ${this.name}: ${err instanceof Error ? err.message : String(err)}`,
          this.name,
          request.modelId,
        )
      }
    }

    let response = await post()

    // Native-tool-use fallback. Some OpenAI-compatible servers
    // (vLLM without --enable-auto-tool-choice, llama.cpp without
    // the chat-format flag, older Ollama builds) reject the
    // tools / tool_choice fields with a 400. When we see that
    // specific error, drop the native tool spec, retry, and cache
    // the determination so we don't keep round-tripping. The
    // agent loop's textual JSON-block parser then handles tool
    // calls via the system-prompt protocol instead.
    if (wantsNativeTools && response.status === 400 && !this.nativeToolsDisabled) {
      const body400 = await safeReadText(response)
      if (looksLikeNativeToolUseRejection(body400)) {
        // Log a single warning so the operator knows we degraded.
        process.stderr.write(
          `[llm/${this.name}] upstream rejected native tool-use (${this.endpointUrl}); ` +
            `falling back to textual tool protocol. Configure your server with ` +
            `--enable-auto-tool-choice and --tool-call-parser to enable native tools. ` +
            `Reason: ${body400.slice(0, 200)}\n`,
        )
        this.nativeToolsDisabled = true
        delete body.tools
        delete body.tool_choice
        response = await post()
      } else {
        throw mapHttpError(this.name, request.modelId, response.status, body400)
      }
    }

    if (!response.ok) {
      throw mapHttpError(this.name, request.modelId, response.status, await safeReadText(response))
    }

    let parsed: unknown
    try {
      parsed = await response.json()
    } catch (err) {
      throw new LlmError(
        'INVALID_RESPONSE',
        `${this.name} returned non-JSON response: ${err instanceof Error ? err.message : String(err)}`,
        this.name,
        request.modelId,
      )
    }

    if (!isOpenAIResponse(parsed)) {
      throw new LlmError(
        'INVALID_RESPONSE',
        `${this.name} response did not match expected shape`,
        this.name,
        request.modelId,
        parsed,
      )
    }

    const firstChoice = parsed.choices[0]
    if (!firstChoice) {
      throw new LlmError(
        'INVALID_RESPONSE',
        `${this.name} response had no choices`,
        this.name,
        request.modelId,
      )
    }

    // OpenAI-compatible vendors report `prompt_tokens` as the TOTAL
    // (cache hits + uncached). Anthropic's convention (which our
    // CostMetrics shape follows) is that `inputTokens` is the
    // uncached portion only and `cachedTokens` is the cache hits.
    // Normalize here by subtracting the cached count from the total.
    // Vendors that do not report cached counts (Kimi, OpenRouter
    // pass-through) leave `cachedTokens` undefined and `inputTokens`
    // is the full prompt_tokens.
    const cached = readCachedTokens(parsed.usage)
    const inputUncached =
      cached !== undefined
        ? Math.max(0, parsed.usage.prompt_tokens - cached)
        : parsed.usage.prompt_tokens
    const costMetrics: CompletionResponse['costMetrics'] = {
      inputTokens: inputUncached,
      outputTokens: parsed.usage.completion_tokens,
    }
    if (cached !== undefined) {
      costMetrics.cachedTokens = cached
    }
    const toolCalls: NativeToolCall[] = []
    if (Array.isArray(firstChoice.message.tool_calls)) {
      for (const tc of firstChoice.message.tool_calls) {
        if (typeof tc.function.name !== 'string') continue
        let args: unknown
        try {
          args = JSON.parse(tc.function.arguments)
        } catch {
          // The model emitted malformed JSON in the arguments string.
          // Skip silently; the loop will treat this as no native call
          // and fall through to text-fenced parsing (which won't find
          // anything either, surfacing the error path naturally).
          continue
        }
        if (typeof args !== 'object' || args === null) continue
        toolCalls.push({
          id: tc.id,
          name: tc.function.name,
          args: args as Record<string, unknown>,
        })
      }
    }

    const result: CompletionResponse = {
      text: firstChoice.message.content ?? '',
      finishReason: mapOpenAIFinishReason(firstChoice.finish_reason),
      costMetrics,
      providerResponseId: parsed.id,
    }
    if (toolCalls.length > 0) result.toolCalls = toolCalls
    return result
  }
}

/**
 * Pull cached-token count from whichever shape the OpenAI-compatible
 * vendor returns: top-level `prompt_cache_hit_tokens` (DeepSeek) or
 * nested `prompt_tokens_details.cached_tokens` (OpenAI). Returns
 * undefined when neither is present (e.g., Kimi, OpenRouter pass-through).
 */
function readCachedTokens(usage: OpenAIChatResponse['usage']): number | undefined {
  if (typeof usage.prompt_cache_hit_tokens === 'number') {
    return usage.prompt_cache_hit_tokens
  }
  const nested = usage.prompt_tokens_details?.cached_tokens
  if (typeof nested === 'number') return nested
  return undefined
}

/**
 * Build the OpenAI-compatible messages array.
 *
 * We use fenced ```tool blocks (not native function calling), so tool
 * results come back to us as `role: 'tool'` messages from the loop.
 * OpenAI-style APIs reject tool messages without a `tool_call_id`
 * (we don't have one... not using their function-calling protocol),
 * and stricter models like deepseek-reasoner reject them outright.
 *
 * Surface tool results as `user` messages tagged `tool_result:`. This
 * mirrors what the AnthropicProvider does and is correct for our
 * fenced-block tool protocol.
 *
 * Consecutive same-role messages are merged because reasoner-class
 * models (deepseek-reasoner in particular) require strict
 * user/assistant alternation.
 */
function toOpenAIMessages(
  messages: Message[],
  systemPrompt: string | undefined,
): { role: string; content: string }[] {
  const out: { role: string; content: string }[] = []
  if (systemPrompt !== undefined) {
    out.push({ role: 'system', content: systemPrompt })
  }
  const push = (role: 'user' | 'assistant', content: string) => {
    const last = out[out.length - 1]
    if (last?.role === role) {
      last.content = `${last.content}\n\n${content}`
    } else {
      out.push({ role, content })
    }
  }
  for (const m of messages) {
    if (m.role === 'user' || m.role === 'assistant') {
      push(m.role, m.content)
    } else if (m.role === 'tool') {
      push('user', `tool_result:\n${m.content}`)
    }
    // system messages from the loop are dropped; system goes in the
    // top-level systemPrompt above.
  }
  return out
}

function isOpenAIResponse(value: unknown): value is OpenAIChatResponse {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v['id'] === 'string' &&
    Array.isArray(v['choices']) &&
    typeof v['usage'] === 'object' &&
    v['usage'] !== null
  )
}

function mapOpenAIFinishReason(reason: string | null): CompletionResponse['finishReason'] {
  switch (reason) {
    case 'stop':
      return 'stop'
    case 'length':
      return 'length'
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls'
    case 'content_filter':
      return 'content_filter'
    default:
      return 'stop'
  }
}

/**
 * Heuristic: does a 400 response body look like an upstream's
 * specific "native tool-use is disabled / not supported" rejection?
 * We pattern-match on the canonical vLLM message (which is the
 * server most likely to hit this in 2200 testing on homelab boxes)
 * plus a couple of generic indicators. If yes, the OpenAIProvider
 * caller retries the request without the tools / tool_choice fields
 * and falls back to the textual JSON-block tool protocol.
 *
 * Examples we want to match:
 *   - vLLM: `"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set`
 *   - llama.cpp:  `tool_choice is not supported`
 *   - generic: `tools are not supported`
 */
function looksLikeNativeToolUseRejection(bodyText: string): boolean {
  const lower = bodyText.toLowerCase()
  if (lower.includes('--enable-auto-tool-choice')) return true
  if (lower.includes('--tool-call-parser')) return true
  if (lower.includes('tool_choice') && lower.includes('not support')) return true
  if (lower.includes('tools are not supported')) return true
  if (lower.includes('tools" is not supported')) return true
  if (lower.includes('"tools": not supported')) return true
  return false
}

/**
 * Map an HTTP error status to the LlmError vocabulary. Shared with the
 * Codex Responses adapter (`codex-responses.ts`), which fronts a
 * different transport but the same status semantics.
 */
export function mapHttpError(
  providerName: string,
  modelId: string,
  status: number,
  bodyText: string,
): LlmError {
  if (status === 401 || status === 403) {
    return new LlmError('AUTH_FAILED', `auth failed (${String(status)})`, providerName, modelId, {
      bodyText,
    })
  }
  if (status === 404) {
    return new LlmError(
      'MODEL_NOT_FOUND',
      `model not found (${String(status)})`,
      providerName,
      modelId,
      { bodyText },
    )
  }
  if (status === 429) {
    return new LlmError('RATE_LIMITED', `rate limited (${String(status)})`, providerName, modelId, {
      bodyText,
    })
  }
  if (status >= 500) {
    return new LlmError(
      'PROVIDER_ERROR',
      `provider error (${String(status)})`,
      providerName,
      modelId,
      { bodyText },
    )
  }
  return new LlmError(
    'PROVIDER_ERROR',
    `unexpected status ${String(status)}: ${bodyText.slice(0, 300)}`,
    providerName,
    modelId,
    { bodyText },
  )
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}
