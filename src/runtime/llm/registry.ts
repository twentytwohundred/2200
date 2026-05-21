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
 *   local       → reads LOCAL_BASE_URL (default Ollama at :11434/v1)
 *                  for self-hosted / on-device OpenAI-compatible
 *                  endpoints (Ollama, LM Studio, vLLM, llama.cpp).
 *                  API key optional; defaults to "ollama" when
 *                  LOCAL_API_KEY is unset, since Ollama and most
 *                  local stacks accept any non-empty bearer.
 *
 * SecretRef defaults: when an Identity does not specify
 * `provider_secret`, the registry falls back to a per-provider default
 * env var (ANTHROPIC_API_KEY, KIMI_API_KEY, etc.). Operators get a
 * working setup just by exporting the env var.
 */
import { EndpointStore } from '../endpoints/store.js'
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
  /**
   * 2200 home directory. Required when resolving custom endpoints
   * (`provider: "endpoint:<slug>"`); the registry reads the matching
   * entry from `<home>/config/endpoints.json`. Optional for built-in
   * providers, which do not need disk access.
   */
  home?: string
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
  xai: { baseUrl: 'https://api.x.ai' },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com',
    endpointUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  },
}

/**
 * Default base URL for the `local` provider when `LOCAL_BASE_URL`
 * is unset. Points at Ollama's OpenAI-compatible endpoint, the most
 * common default on a developer workstation. LM Studio, vLLM, and
 * llama.cpp's server expose the same shape on different ports;
 * users override via `LOCAL_BASE_URL`.
 */
const LOCAL_DEFAULT_BASE_URL = 'http://localhost:11434/v1'

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
  // Custom endpoints registered via the Settings UI. `endpoint:<slug>`
  // resolves through the EndpointStore at `<home>/config/endpoints.json`.
  // Each endpoint carries its own base_url + optional bearer; we wrap
  // them in OpenAIProvider since the discovery / chat-completions surface
  // they expose is the OpenAI-compatible /v1 shape.
  if (opts.providerName.startsWith('endpoint:')) {
    if (!opts.home) {
      throw new LlmError(
        'CONFIG_ERROR',
        'custom endpoints require a 2200 home directory; provide opts.home when resolving',
        opts.providerName,
      )
    }
    const id = opts.providerName.slice('endpoint:'.length)
    const store = new EndpointStore(opts.home)
    const entry = await store.get(id)
    if (!entry) {
      throw new LlmError(
        'CONFIG_ERROR',
        `custom endpoint "${id}" is not registered. Add it under Settings → Endpoints.`,
        opts.providerName,
      )
    }
    return new OpenAIProvider({
      apiKey: entry.api_key.length > 0 ? entry.api_key : 'local',
      baseUrl: entry.base_url,
      providerName: opts.providerName,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    })
  }

  // The `local` provider is special-cased: API key is optional (Ollama
  // accepts any non-empty bearer; vLLM/LM Studio default to no auth)
  // and the baseUrl is read from process env at resolve time so that
  // editing LOCAL_BASE_URL only requires an agent restart, not a code
  // change.
  if (opts.providerName === 'local') {
    const apiKey = process.env['LOCAL_API_KEY'] ?? 'ollama'
    const baseUrl = process.env['LOCAL_BASE_URL'] ?? LOCAL_DEFAULT_BASE_URL
    return new OpenAIProvider({
      apiKey,
      baseUrl,
      providerName: 'local',
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    })
  }

  // xAI OAuth subscription credential takes priority over the env API
  // key when present. Fleet-wide: one signed-in subscription serves
  // every Agent whose model.provider is "xai". The bearer is read
  // lazily so it picks up refreshes the refresh-service made without
  // requiring an Agent restart on every token rotation.
  if (opts.providerName === 'xai' && opts.secret === undefined && opts.home) {
    const { readOAuthToken } = await import('../oauth/token-store.js')
    const token = await readOAuthToken(opts.home, 'xai-oauth').catch(() => null)
    if (token && token.metadata.expires_at_ms > Date.now()) {
      const vendor = OPENAI_COMPATIBLE_VENDORS['xai']
      if (vendor) {
        return new OpenAIProvider({
          apiKey: token.bearer,
          baseUrl: vendor.baseUrl,
          providerName: 'xai',
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        })
      }
    }
  }

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
    `provider '${opts.providerName}' is not supported. Known providers: anthropic, local, ${Object.keys(OPENAI_COMPATIBLE_VENDORS).join(', ')}.`,
    opts.providerName,
  )
}

/**
 * Catalog entry for a built-in provider. Used by the settings/web
 * surface to list providers, their default env-var key, the kind of
 * adapter (native Anthropic vs OpenAI-compatible vs local), and
 * whether the URL is user-configurable.
 */
export interface ProviderCatalogEntry {
  /** Provider name as it appears in `model.provider`. */
  name: string
  /** Human-readable label for the settings UI. */
  label: string
  /** Default env var that holds the API key. */
  defaultEnvKey: string
  /** Adapter family. */
  kind: 'anthropic' | 'openai-compatible' | 'local'
  /** Configured base URL (constant for cloud providers; env-driven for local). */
  baseUrl: string
  /** True when the user can change the base URL. Only `local` is mutable today. */
  baseUrlEditable: boolean
  /**
   * Env var that holds the base URL when editable. Empty string for
   * fixed-URL providers.
   */
  baseUrlEnvKey: string
  /** True when the API key is optional (e.g. local Ollama). */
  keyOptional: boolean
}

/**
 * Return the static list of built-in providers in display order.
 * Settings UI surfaces this list; the `local` entry's `baseUrl`
 * reflects the current `LOCAL_BASE_URL` env (or the default).
 */
export function listKnownProviders(): ProviderCatalogEntry[] {
  const out: ProviderCatalogEntry[] = [
    {
      name: 'anthropic',
      label: 'Anthropic',
      defaultEnvKey: 'ANTHROPIC_API_KEY',
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      baseUrlEditable: false,
      baseUrlEnvKey: '',
      keyOptional: false,
    },
  ]
  for (const [name, cfg] of Object.entries(OPENAI_COMPATIBLE_VENDORS)) {
    out.push({
      name,
      label: PROVIDER_LABELS[name] ?? name,
      defaultEnvKey: defaultSecretFor(name).id,
      kind: 'openai-compatible',
      baseUrl: cfg.baseUrl,
      baseUrlEditable: false,
      baseUrlEnvKey: '',
      keyOptional: false,
    })
  }
  out.push({
    name: 'local',
    label: 'Local (Ollama / LM Studio / vLLM)',
    defaultEnvKey: 'LOCAL_API_KEY',
    kind: 'local',
    baseUrl: process.env['LOCAL_BASE_URL'] ?? LOCAL_DEFAULT_BASE_URL,
    baseUrlEditable: true,
    baseUrlEnvKey: 'LOCAL_BASE_URL',
    keyOptional: true,
  })
  return out
}

/** Display labels for the cloud providers; the names alone are too terse for a settings UI. */
const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  kimi: 'Moonshot Kimi',
  openrouter: 'OpenRouter',
  xai: 'xAI (Grok)',
  gemini: 'Google Gemini',
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
    case 'xai':
      return { source: 'env', id: 'XAI_API_KEY' }
    case 'gemini':
      return { source: 'env', id: 'GEMINI_API_KEY' }
    default:
      // Compose a plausible env var name from the provider; users can
      // override with an explicit SecretRef on the Identity.
      return { source: 'env', id: `${providerName.toUpperCase()}_API_KEY` }
  }
}
