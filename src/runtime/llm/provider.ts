/**
 * LLMProvider abstraction.
 *
 * Every model the runtime can call sits behind this interface. The Agent
 * loop and any caller that needs a completion uses `provider.complete()`
 * without knowing which vendor the underlying SDK talks to. New providers
 * (Anthropic, OpenAI, OpenAI-compatible, local) implement this interface
 * and register with the provider registry.
 *
 * v1 surface: non-streaming text completion. The interface is small on
 * purpose; streaming, tool-call dispatch, structured output, and vision
 * land later when Epic 2's Agent loop and the plan/run/perm wrapping
 * consume them.
 */
import type { CompletionRequest, CompletionResponse } from './types.js'

export interface LLMProvider {
  /** Provider identity, e.g. "anthropic", "openai". */
  readonly name: string

  /** Default base URL the provider talks to. Useful for diagnostics. */
  readonly baseUrl: string

  /** Run a completion. Throws `LlmError` on failure. */
  complete(request: CompletionRequest): Promise<CompletionResponse>
}
