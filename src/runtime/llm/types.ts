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
  inputTokens: number
  outputTokens: number
  /**
   * Optional dollar estimate. v1 leaves this null; the cost-behavior
   * layer computes it later from a price-per-model table.
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
