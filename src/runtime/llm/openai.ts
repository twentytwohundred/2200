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
import type { CompletionRequest, CompletionResponse, Message } from './types.js'

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

interface OpenAIChatRequest {
  model: string
  messages: { role: string; content: string }[]
  max_tokens?: number
  temperature?: number
}

interface OpenAIChatResponse {
  id: string
  choices: {
    message: { role: string; content: string | null }
    finish_reason: string | null
  }[]
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
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
    const messages: OpenAIChatRequest['messages'] = []
    if (request.systemPrompt !== undefined) {
      messages.push({ role: 'system', content: request.systemPrompt })
    }
    for (const m of request.messages) {
      messages.push(toOpenAIMessage(m))
    }

    const body: OpenAIChatRequest = {
      model: request.modelId,
      messages,
    }
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens
    if (request.temperature !== undefined) body.temperature = request.temperature

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

    return {
      text: firstChoice.message.content ?? '',
      finishReason: mapOpenAIFinishReason(firstChoice.finish_reason),
      costMetrics: {
        inputTokens: parsed.usage.prompt_tokens,
        outputTokens: parsed.usage.completion_tokens,
      },
      providerResponseId: parsed.id,
    }
  }
}

function toOpenAIMessage(m: Message): { role: string; content: string } {
  // OpenAI accepts user/assistant/system/tool roles; pass through.
  return { role: m.role, content: m.content }
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
    `unexpected status ${String(status)}`,
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
