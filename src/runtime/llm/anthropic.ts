/**
 * Anthropic LLM provider.
 *
 * Talks to Anthropic's Messages API
 * (https://docs.anthropic.com/en/api/messages) directly via fetch. No SDK
 * dependency; we own the request and response shapes so we can map them
 * onto the project's typed `CompletionRequest` / `CompletionResponse`.
 *
 * Auth: Bearer-style via the `x-api-key` header. Per Anthropic's spec,
 * the `anthropic-version` header is required and locked here at the
 * documented value `2023-06-01`. When Anthropic ships a breaking API
 * version the constant bumps with a follow-up decision record.
 */
import { LlmError } from './errors.js'
import type { LLMProvider } from './provider.js'
import type { CompletionRequest, CompletionResponse, Message } from './types.js'

const DEFAULT_BASE_URL = 'https://api.anthropic.com'
const ANTHROPIC_VERSION = '2023-06-01'

export interface AnthropicProviderOptions {
  /** Resolved API key. The provider does not log this. */
  apiKey: string
  /** Override base URL. Defaults to https://api.anthropic.com. */
  baseUrl?: string
  /** Inject a fetch implementation (testing). Defaults to global fetch. */
  fetchImpl?: typeof fetch
}

interface AnthropicMessagesRequest {
  model: string
  max_tokens: number
  messages: { role: 'user' | 'assistant'; content: string }[]
  system?: string
  temperature?: number
}

interface AnthropicMessagesResponse {
  id: string
  content: { type: string; text?: string }[]
  stop_reason: string | null
  usage: { input_tokens: number; output_tokens: number }
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic'
  readonly baseUrl: string
  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch

  constructor(opts: AnthropicProviderOptions) {
    this.apiKey = opts.apiKey
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const body: AnthropicMessagesRequest = {
      model: request.modelId,
      max_tokens: request.maxTokens ?? 4096,
      messages: toAnthropicMessages(request.messages),
    }
    if (request.systemPrompt !== undefined) body.system = request.systemPrompt
    if (request.temperature !== undefined) body.temperature = request.temperature

    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    } catch (err) {
      throw new LlmError(
        'NETWORK_ERROR',
        `network error contacting Anthropic: ${err instanceof Error ? err.message : String(err)}`,
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
        `Anthropic returned non-JSON response: ${err instanceof Error ? err.message : String(err)}`,
        this.name,
        request.modelId,
      )
    }

    if (!isAnthropicResponse(parsed)) {
      throw new LlmError(
        'INVALID_RESPONSE',
        'Anthropic response did not match expected shape',
        this.name,
        request.modelId,
        parsed,
      )
    }

    const text = parsed.content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text ?? '')
      .join('')

    return {
      text,
      finishReason: mapAnthropicStopReason(parsed.stop_reason),
      costMetrics: {
        inputTokens: parsed.usage.input_tokens,
        outputTokens: parsed.usage.output_tokens,
      },
      providerResponseId: parsed.id,
    }
  }
}

function toAnthropicMessages(
  messages: Message[],
): { role: 'user' | 'assistant'; content: string }[] {
  // Anthropic's Messages API only accepts user/assistant in the messages
  // array; system goes in the top-level `system` field.
  //
  // We use fenced ```tool blocks (not Anthropic's native tool_use API),
  // so tool results come back to us as `role: 'tool'` messages from the
  // loop. We surface them to Anthropic as `user` messages tagged
  // `tool_result:` so the model can see what its previous tool call
  // returned. Without this, multi-turn tool use is broken: the model
  // sees its own call but never the result, and the next turn produces
  // empty / confused output.
  //
  // Consecutive same-role messages (e.g. two tool results in a row) are
  // merged into one because Anthropic rejects role repetitions.
  const out: { role: 'user' | 'assistant'; content: string }[] = []
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
    // system messages: silently dropped; system prompt is set via the
    // top-level `system` field on the request.
  }
  return out
}

function isAnthropicResponse(value: unknown): value is AnthropicMessagesResponse {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v['id'] === 'string' &&
    Array.isArray(v['content']) &&
    typeof v['usage'] === 'object' &&
    v['usage'] !== null
  )
}

function mapAnthropicStopReason(reason: string | null): CompletionResponse['finishReason'] {
  switch (reason) {
    case 'end_turn':
      return 'stop'
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'tool_calls'
    case 'stop_sequence':
      return 'stop'
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
