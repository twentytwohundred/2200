/**
 * LLM provider registry.
 *
 * Resolves a `(providerName, secretRef?)` pair to a constructed
 * `LLMProvider`. The registry is the boundary between the Identity
 * file's declarative `model.provider` field and the actual SDK-level
 * client.
 *
 * Native adapters
 *   anthropic   → AnthropicProvider (Messages API)
 *
 * OpenAI-compatible adapters (all use OpenAIProvider with vendor baseUrl)
 *   openai      → https://api.openai.com
 *   deepseek    → https://api.deepseek.com
 *   kimi        → https://api.moonshot.ai            (Moonshot AI's Kimi)
 *   openrouter  → https://openrouter.ai/api          (model aggregator)
 *   gemini      → https://generativelanguage.googleapis.com (custom path)
 *
 * SecretRef defaults: when an Identity does not specify
 * `provider_secret`, the registry falls back to a per-provider default
 * env var (ANTHROPIC_API_KEY, KIMI_API_KEY, etc.). Operators get a
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

interface OpenAICompatibleConfig {
  baseUrl: string
  endpointUrl?: string
}

/**
 * Per-vendor baseUrl + (optional) full endpoint override for
 * OpenAI-compatible providers. Adding a new vendor is one entry here
 * plus one entry in `defaultSecretFor`.
 */
const OPENAI_COMPATIBLE_VENDORS: Record<string, OpenAICompatibleConfig> = {
  openai: { baseUrl: 'https://api.openai.com' },
  deepseek: { baseUrl: 'https://api.deepseek.com' },
  kimi: { baseUrl: 'https://api.moonshot.ai' },
  openrouter: { baseUrl: 'https://openrouter.ai/api' },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com',
    endpointUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  },
}

/**
 * Resolve a provider name + optional SecretRef to a constructed
 * `LLMProvider`. Resolves the secret at construction time so the
 * provider holds the literal key in memory; it never re-reads from the
 * secret source per request.
 *
 * Throws `LlmError(code: 'CONFIG_ERROR')` for an unknown provider.
 * Throws SecretResolveError on secret resolution failure.
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

  const vendor = OPENAI_COMPATIBLE_VENDORS[opts.providerName]
  if (vendor) {
    return new OpenAIProvider({
      apiKey,
      baseUrl: vendor.baseUrl,
      providerName: opts.providerName,
      ...(vendor.endpointUrl ? { endpointUrl: vendor.endpointUrl } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    })
  }

  throw new LlmError(
    'CONFIG_ERROR',
    `provider '${opts.providerName}' is not supported. Known providers: anthropic, ${Object.keys(OPENAI_COMPATIBLE_VENDORS).join(', ')}.`,
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
    case 'kimi':
      return { source: 'env', id: 'KIMI_API_KEY' }
    case 'openrouter':
      return { source: 'env', id: 'OPENROUTER_API_KEY' }
    case 'gemini':
      return { source: 'env', id: 'GEMINI_API_KEY' }
    default:
      // Compose a plausible env var name from the provider; users can
      // override with an explicit SecretRef on the Identity.
      return { source: 'env', id: `${providerName.toUpperCase()}_API_KEY` }
  }
}
