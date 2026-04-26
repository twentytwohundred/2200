/**
 * Typed LLM errors. Providers map vendor-specific failure modes onto
 * this taxonomy so callers (the Agent loop, the cost-behavior detectors)
 * can reason about errors without provider-specific knowledge.
 */

export type LlmErrorCode =
  | 'AUTH_FAILED' // 401, bad API key, expired
  | 'RATE_LIMITED' // 429
  | 'MODEL_NOT_FOUND' // 404 with model id, or provider rejects
  | 'CONTEXT_OVERFLOW' // request exceeded model's context window
  | 'PROVIDER_ERROR' // 5xx from the provider
  | 'NETWORK_ERROR' // fetch failed before reaching the provider
  | 'INVALID_RESPONSE' // got a 200 but the response shape is unexpected
  | 'CONFIG_ERROR' // misconfiguration on our side (bad base URL, missing field)

export class LlmError extends Error {
  constructor(
    public readonly code: LlmErrorCode,
    message: string,
    public readonly providerName: string,
    public readonly modelId?: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'LlmError'
  }
}
