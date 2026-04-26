/**
 * LLM provider registry.
 *
 * Resolves a `(providerName, secretRef?)` pair to a constructed
 * `LLMProvider`. The registry is the boundary between the Identity
 * file's declarative `model.provider` field and the actual SDK-level
 * client.
 *
 * v1 supports `anthropic` and `openai` natively. Anything else falls
 * into the OpenAI-compatible bucket and uses the OpenAIProvider with a
 * vendor-specific base URL when one is configured. Per
 * [[2026-04-26-model-field-format]] reserved providers `local` and
 * `user` route to the OpenAI-compatible path; their endpoints are
 * configured per-instance (not in this PR; lands when the Identity
 * gains a `provider_endpoint` field).
 *
 * SecretRef defaults: when an Identity does not specify
 * `provider_secret`, the registry falls back to a per-provider default
 * env var (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.). Users get a
 * working setup just by exporting the env var.
 */
import { resolveSecret } from '../secrets/resolver.js'
import type { SecretRef } from '../secrets/types.js'
import { AnthropicProvider } from './anthropic.js'
import { LlmError } from './errors.js'
import { OpenAIProvider } from './openai.js'
import type { LLMProvider } from './provider.js'

export interface ProviderResolveOptions {
  /** Provider name from the Identity's model.provider field. */
  providerName: string
  /** Optional explicit secret reference; falls back to a default env var. */
  secret?: SecretRef
  /** Inject fetch (testing). */
  fetchImpl?: typeof fetch
}

/**
 * Resolve a provider name + optional SecretRef to a constructed
 * `LLMProvider`. Resolves the secret at construction time so the
 * provider holds the literal key in memory; it never re-reads from the
 * secret source per request.
 *
 * Throws `LlmError(code: 'CONFIG_ERROR')` for an unknown provider that
 * we cannot map to any client. Throws SecretResolveError on secret
 * resolution failure.
 */
export async function resolveProvider(opts: ProviderResolveOptions): Promise<LLMProvider> {
  const secretRef = opts.secret ?? defaultSecretFor(opts.providerName)
  const apiKey = await resolveSecret(secretRef)

  if (opts.providerName === 'anthropic') {
    return new AnthropicProvider({
      apiKey,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    })
  }
  if (opts.providerName === 'openai') {
    return new OpenAIProvider({
      apiKey,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    })
  }

  // Reserved providers and unknown names are deferred to a future PR
  // that adds the per-vendor base-URL registry. Until then, we surface a
  // clear configuration error.
  throw new LlmError(
    'CONFIG_ERROR',
    `provider '${opts.providerName}' is not supported at v1. Anthropic and OpenAI are the v1 providers; OpenAI-compatible vendors (DeepSeek, MiniMax, Moonshot, local endpoints, user-defined endpoints) land in a follow-up PR.`,
    opts.providerName,
  )
}

/** Default env var for providers that ship without an explicit SecretRef. */
function defaultSecretFor(providerName: string): SecretRef {
  switch (providerName) {
    case 'anthropic':
      return { source: 'env', id: 'ANTHROPIC_API_KEY' }
    case 'openai':
      return { source: 'env', id: 'OPENAI_API_KEY' }
    case 'deepseek':
      return { source: 'env', id: 'DEEPSEEK_API_KEY' }
    case 'minimax':
      return { source: 'env', id: 'MINIMAX_API_KEY' }
    case 'moonshot':
      return { source: 'env', id: 'MOONSHOT_API_KEY' }
    default:
      // Compose a plausible env var name from the provider; users can
      // override with an explicit SecretRef on the Identity.
      return { source: 'env', id: `${providerName.toUpperCase()}_API_KEY` }
  }
}
