/**
 * Codex Responses adapter ... the `openai-subscription` transport.
 *
 * A ChatGPT subscription bearer does NOT work against api.openai.com;
 * it works only against the ChatGPT Codex backend, which speaks the
 * OpenAI Responses API shape (not chat-completions) and validates a
 * Codex system-prompt scaffold. This adapter translates 2200's
 * `CompletionRequest` onto that wire and normalizes the result back
 * into a `CompletionResponse`.
 *
 * INTERIM ... UNVERIFIED WIRE. The shape below comes from OpenAI's
 * open-source Codex CLI and community integrations; it has NOT yet
 * returned a real completion from a live ChatGPT subscription token.
 * Per the one-candle discipline it stays flagged until it does. Every
 * transport detail (URL, headers, scaffold, body flags) lives in
 * `CODEX_RESPONSES_WIRE` so verification-day corrections are a
 * one-place edit. Kill switch: remove the `openai-subscription`
 * branch in `registry.ts`; nothing else references this module.
 *
 * See wiki/decisions/2026-07-10-oauth-ecosystem-openai-subscription.md.
 */
import { LlmError } from './errors.js'
import { mapHttpError } from './openai.js'
import type { LLMProvider } from './provider.js'
import type { CompletionRequest, CompletionResponse, Message } from './types.js'

/**
 * The whole Codex Responses transport, in one place.
 *
 *   - `url`: the ChatGPT backend Responses endpoint. Subscription
 *     bearers are only honored here.
 *   - `instructions`: the mandated Codex scaffold. The backend
 *     validates this per model family; verification day may require
 *     the full verbatim Codex CLI instructions (Apache-2.0,
 *     github.com/openai/codex) instead of this opening stanza.
 *   - `store: false` + `include reasoning.encrypted_content`: required
 *     constraints for stateless third-party use ... the backend keeps
 *     no conversation state, so reasoning context rides along
 *     encrypted in the response.
 *   - `stream: true`: the backend is SSE-first; we aggregate the
 *     stream and return the terminal response object. A JSON body is
 *     also tolerated in case the backend answers non-streaming.
 *   - `extraHeaders.originator`: how OpenAI attributes shared-client
 *     traffic; same value the sanctioned harnesses send.
 */
export const CODEX_RESPONSES_WIRE = {
  url: 'https://chatgpt.com/backend-api/codex/responses',
  accountIdHeader: 'chatgpt-account-id',
  extraHeaders: {
    originator: 'codex_cli_rs',
    'OpenAI-Beta': 'responses=experimental',
  },
  instructions:
    "You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI on a user's computer.",
  store: false,
  stream: true,
  include: ['reasoning.encrypted_content'],
} as const

/** Bearer + account id, resolved fresh per request (rotating subscription token). */
export interface CodexCredentials {
  readonly bearer: string
  readonly accountId: string
}

export interface CodexResponsesProviderOptions {
  /**
   * Resolve credentials FRESH on every request, mirroring the
   * `apiKeyProvider` pattern in OpenAIProvider: the fleet bearer
   * rotates via the background refresh, so capturing it at construction
   * would 403 once the cached copy expires.
   */
  credentialProvider: () => Promise<CodexCredentials>
  /** Provider identity in telemetry. Default 'openai-subscription'. */
  providerName?: string
  /** Endpoint override (testing). Default: the wire config URL. */
  endpointUrl?: string
  /** Inject a fetch implementation (testing). Defaults to global fetch. */
  fetchImpl?: typeof fetch
}

interface ResponsesInputMessage {
  type: 'message'
  role: 'user' | 'assistant' | 'developer'
  content: { type: 'input_text' | 'output_text'; text: string }[]
}

/** Terminal Responses-API response object (subset we consume). */
interface ResponsesApiResponse {
  id?: string
  status?: string
  incomplete_details?: { reason?: string }
  output?: {
    type?: string
    content?: { type?: string; text?: string }[]
  }[]
  usage?: {
    input_tokens?: number
    output_tokens?: number
    input_tokens_details?: { cached_tokens?: number }
  }
  error?: { message?: string; code?: string }
}

export class CodexResponsesProvider implements LLMProvider {
  readonly name: string
  readonly baseUrl: string
  private readonly endpointUrl: string
  private readonly credentialProvider: () => Promise<CodexCredentials>
  private readonly fetchImpl: typeof fetch

  constructor(opts: CodexResponsesProviderOptions) {
    this.credentialProvider = opts.credentialProvider
    this.endpointUrl = opts.endpointUrl ?? CODEX_RESPONSES_WIRE.url
    this.baseUrl = this.endpointUrl
    this.name = opts.providerName ?? 'openai-subscription'
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const creds = await this.credentialProvider()

    // Native tool-use is deliberately not wired on this transport yet:
    // the agent loop's fenced-text tool protocol (its universal
    // fallback) works on every provider, and halving the unverified
    // wire surface matters more than native calls until a live token
    // has exercised the adapter. `request.tools` is ignored, exactly
    // like the providers that don't support native tool-use.
    const body: Record<string, unknown> = {
      model: request.modelId,
      instructions: CODEX_RESPONSES_WIRE.instructions,
      input: toResponsesInput(request.messages, request.systemPrompt),
      store: CODEX_RESPONSES_WIRE.store,
      stream: CODEX_RESPONSES_WIRE.stream,
      include: CODEX_RESPONSES_WIRE.include,
    }
    if (request.maxTokens !== undefined) body['max_output_tokens'] = request.maxTokens
    if (request.temperature !== undefined) body['temperature'] = request.temperature

    let response: Response
    try {
      response = await this.fetchImpl(this.endpointUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${creds.bearer}`,
          [CODEX_RESPONSES_WIRE.accountIdHeader]: creds.accountId,
          ...CODEX_RESPONSES_WIRE.extraHeaders,
          'content-type': 'application/json',
          accept: 'text/event-stream',
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
      const text = await response.text().catch(() => '')
      throw mapHttpError(this.name, request.modelId, response.status, text)
    }

    const contentType = response.headers.get('content-type') ?? ''
    const raw = await response.text()
    const terminal = contentType.includes('text/event-stream')
      ? extractTerminalFromSse(raw)
      : (safeJsonParse(raw) as ResponsesApiResponse | null)

    if (!terminal) {
      throw new LlmError(
        'INVALID_RESPONSE',
        `${this.name} returned a stream with no terminal response event`,
        this.name,
        request.modelId,
        raw.slice(0, 500),
      )
    }
    if (terminal.error?.message) {
      throw new LlmError(
        'PROVIDER_ERROR',
        `${this.name} response failed: ${terminal.error.message}`,
        this.name,
        request.modelId,
        terminal,
      )
    }

    const text = collectOutputText(terminal)
    const usage = terminal.usage
    const cached = usage?.input_tokens_details?.cached_tokens
    const inputTotal = usage?.input_tokens ?? 0
    // Same normalization as the chat-completions adapter: report the
    // uncached portion as inputTokens, cache hits separately.
    const costMetrics: CompletionResponse['costMetrics'] = {
      inputTokens: cached !== undefined ? Math.max(0, inputTotal - cached) : inputTotal,
      outputTokens: usage?.output_tokens ?? 0,
    }
    if (cached !== undefined) costMetrics.cachedTokens = cached

    const result: CompletionResponse = {
      text,
      finishReason:
        terminal.status === 'incomplete' &&
        terminal.incomplete_details?.reason === 'max_output_tokens'
          ? 'length'
          : 'stop',
      costMetrics,
    }
    if (terminal.id) result.providerResponseId = terminal.id
    return result
  }
}

/**
 * Build the Responses-API input array. The mandated Codex scaffold
 * occupies `instructions`, so 2200's own system prompt rides as the
 * leading developer-role message; tool results become user messages
 * tagged `tool_result:` (same convention as the chat-completions
 * adapter, and what the fenced-text tool protocol expects).
 */
function toResponsesInput(
  messages: Message[],
  systemPrompt: string | undefined,
): ResponsesInputMessage[] {
  const out: ResponsesInputMessage[] = []
  if (systemPrompt !== undefined) {
    out.push({
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: systemPrompt }],
    })
  }
  for (const m of messages) {
    if (m.role === 'assistant') {
      out.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: m.content }],
      })
    } else if (m.role === 'user' || m.role === 'tool') {
      out.push({
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: m.role === 'tool' ? `tool_result:\n${m.content}` : m.content,
          },
        ],
      })
    }
    // system messages from the loop are dropped; system content goes in
    // the developer message above.
  }
  return out
}

/**
 * Pull the terminal response object out of an SSE stream. The
 * Responses API emits incremental events (`response.output_text.delta`
 * etc.) and a terminal `response.completed` / `response.failed` /
 * `response.incomplete` event carrying the full response object; we
 * only need the terminal one since 2200's v1 surface is non-streaming.
 */
function extractTerminalFromSse(raw: string): ResponsesApiResponse | null {
  let terminal: ResponsesApiResponse | null = null
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice('data:'.length).trim()
    if (!payload || payload === '[DONE]') continue
    const parsed = safeJsonParse(payload) as {
      type?: string
      response?: ResponsesApiResponse
    } | null
    if (!parsed?.type) continue
    if (
      (parsed.type === 'response.completed' ||
        parsed.type === 'response.failed' ||
        parsed.type === 'response.incomplete') &&
      parsed.response
    ) {
      terminal = parsed.response
    }
  }
  return terminal
}

function collectOutputText(response: ResponsesApiResponse): string {
  const parts: string[] = []
  for (const item of response.output ?? []) {
    if (item.type !== 'message') continue
    for (const c of item.content ?? []) {
      if (c.type === 'output_text' && typeof c.text === 'string') parts.push(c.text)
    }
  }
  return parts.join('')
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
