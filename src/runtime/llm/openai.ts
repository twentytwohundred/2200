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
  /** Resolved API key. The provider does not log this. */
  apiKey: string
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
  private readonly fetchImpl: typeof fetch

  constructor(opts: OpenAIProviderOptions) {
    this.apiKey = opts.apiKey
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL
    this.endpointUrl = opts.endpointUrl ?? `${this.baseUrl}/v1/chat/completions`
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
    if (request.tools && request.tools.length > 0) {
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

    let response: Response
    try {
      response = await this.fetchImpl(this.endpointUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
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

function mapHttpError(
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
