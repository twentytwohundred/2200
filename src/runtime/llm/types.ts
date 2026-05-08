/**
 * Shared types for the LLM provider abstraction.
 *
 * v1 supports non-streaming text completion. Streaming, tool calls,
 * structured output, and vision land later when Epic 2's Agent loop and
 * the plan/run/perm wrapping consume them.
 */

export type Role = 'user' | 'assistant' | 'system' | 'tool'

export interface Message {
  role: Role
  content: string
}

/**
 * Tool specification passed to a provider that supports native
 * tool-use protocols (Anthropic's `tool_use`, OpenAI's
 * `function_calling`). Providers that don't support native tool-use
 * (DeepSeek, xAI, OpenAI-compatible local) ignore this field and
 * the agent loop falls back to fenced-text parsing.
 *
 * `parametersJsonSchema` is a JSON Schema (draft 2020-12) describing
 * the tool's argument shape. The agent loop derives this from each
 * tool's Zod schema via `z.toJSONSchema()`.
 */
export interface NativeToolSpec {
  name: string
  description: string
  parametersJsonSchema: object
}

/**
 * Native tool call as emitted by the provider's tool-use surface.
 * Structurally equivalent to a fenced-text tool call but parsed by
 * the provider rather than by our regex. The agent loop treats
 * native calls and fenced calls identically once normalized.
 */
export interface NativeToolCall {
  /** Provider-assigned call id (Anthropic: tool_use.id, OpenAI: tool_calls[i].id). Optional. */
  id?: string
  name: string
  args: Record<string, unknown>
}

export interface CompletionRequest {
  /** Just the model_id portion; the provider knows its own base URL. */
  modelId: string
  /** System prompt; concatenated as appropriate per provider. */
  systemPrompt?: string
  messages: Message[]
  /** Hard cap on response tokens. Default: provider-specific. */
  maxTokens?: number
  /** Sampling temperature in [0, 2]. Default: 1. */
  temperature?: number
  /**
   * Tools the model is permitted to call via native tool-use. When
   * present and the provider supports native tool-use, these get
   * forwarded as `tools: [...]` (Anthropic) or `tools: [...]` with
   * `tool_choice: 'auto'` (OpenAI). Providers that don't support
   * native tool-use silently ignore this field and the agent loop
   * relies on fenced-text parsing of the response text.
   */
  tools?: NativeToolSpec[]
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error'

export interface CostMetrics {
  /** Tokens charged at the standard input rate (cache misses + new content). */
  inputTokens: number
  outputTokens: number
  /**
   * Tokens served from a prompt cache. Anthropic returns these as
   * `cache_read_input_tokens`; DeepSeek returns them as
   * `prompt_cache_hit_tokens`. Providers that do not break out cached
   * input leave this undefined. Cached tokens are typically priced at a
   * 90% discount from standard input rate; the pricing layer applies
   * the per-model `cached_input_per_mtok_usd` line.
   */
  cachedTokens?: number
  /**
   * Optional dollar estimate. v1 leaves this null at the provider
   * level; the cost layer (`pricing.ts`) computes it later from a
   * price-per-model table. The Agent loop populates this on the
   * `model_call_end` event when emitting telemetry.
   */
  estDollars?: number
}

export interface CompletionResponse {
  text: string
  finishReason: FinishReason
  costMetrics: CostMetrics
  /** Provider-assigned response id, when available. Useful for audit. */
  providerResponseId?: string
  /**
   * Tool calls the provider parsed from its native tool-use surface.
   * Present on responses from providers that support native tool-use
   * (Anthropic, OpenAI) when `request.tools` was non-empty AND the
   * model emitted tool calls. Absent otherwise; the agent loop then
   * scans `text` for fenced ```tool blocks (the universal fallback).
   */
  toolCalls?: NativeToolCall[]
}
