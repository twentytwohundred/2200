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
}
