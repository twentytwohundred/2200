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
  // Subscription-credentialed sibling of xai. Same transport (OpenAI-
  // compatible chat-completions against api.x.ai), different credential
  // source (OAuth bearer from the fleet token store, NOT XAI_API_KEY).
  // Operators pick this provider explicitly from the Subscriptions
  // category in the model picker; auto-fallback to the API-key path
  // would hide the choice and is deliberately not wired.
  'xai-subscription': { baseUrl: 'https://api.x.ai' },
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

  // xAI subscription credential. Operators pick `xai-subscription`
  // explicitly from the Subscriptions category in the model picker;
  // distinct from the API-key `xai` provider so the choice is visible
  // in the Agent's Identity. Fails loud if not signed in ... the
  // operator picked subscription and the cure is to sign in via
  // Settings ▸ "Sign in with X / SuperGrok", not to silently fall
  // back to a different credential.
  if (opts.providerName === 'xai-subscription') {
    if (!opts.home) {
      throw new LlmError(
        'CONFIG_ERROR',
        'xai-subscription requires a 2200 home directory; provide opts.home when resolving',
        opts.providerName,
      )
    }
    const { readOAuthToken } = await import('../oauth/token-store.js')
    const token = await readOAuthToken(opts.home, 'xai-oauth').catch(() => null)
    if (!token) {
      throw new LlmError(
        'CONFIG_ERROR',
        'xai-subscription is not signed in. Open Settings and click "Sign in with X / SuperGrok" (or run `2200 oauth xai login`).',
        opts.providerName,
      )
    }
    if (token.metadata.expires_at_ms <= Date.now()) {
      throw new LlmError(
        'CONFIG_ERROR',
        'xai-subscription token is expired and the background refresh has not landed a fresh one yet. Try again in ~60s, or re-sign-in from Settings.',
        opts.providerName,
      )
    }
    const vendor = OPENAI_COMPATIBLE_VENDORS['xai-subscription']
    if (!vendor) {
      throw new LlmError(
        'CONFIG_ERROR',
        'internal: xai-subscription vendor config missing',
        opts.providerName,
      )
    }
    return new OpenAIProvider({
      apiKey: token.bearer,
      baseUrl: vendor.baseUrl,
      providerName: 'xai-subscription',
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    })
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
  /**
   * Settings-UI category. Drives optgroup placement in the model picker
   * and section grouping in Settings ▸ Models & API Keys.
   *
   *   - 'subscription': Sign-in-with-subscription (xAI / SuperGrok).
   *     Credential lives in the fleet OAuth token store.
   *   - 'api-key':      Paste-an-API-key providers (anthropic, openai,
   *                     deepseek, xai, ...). Credential lives in
   *                     runtime.env or per-Agent vault.
   *   - 'local':        Self-hosted (Ollama / LM Studio / vLLM). No
   *                     credential typically required.
   */
  category: 'subscription' | 'api-key' | 'local'
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
      category: 'api-key',
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
      category: name === 'xai-subscription' ? 'subscription' : 'api-key',
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
    category: 'local',
  })
  return out
}

/** Display labels for the cloud providers; the names alone are too terse for a settings UI. */
const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  kimi: 'Moonshot Kimi',
  openrouter: 'OpenRouter',
  xai: 'xAI (Grok, API key)',
  'xai-subscription': 'xAI / Grok (SuperGrok subscription)',
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
    case 'xai-subscription':
      // The xai-subscription provider does NOT read this; its
      // credential comes from the fleet OAuth token store. The entry
      // exists only so listKnownProviders has something non-empty to
      // hand to the Settings UI, which displays it (and the UI uses
      // the category field to decide that this is an OAuth provider,
      // not a paste-a-key one).
      return { source: 'env', id: 'XAI_API_KEY' }
    case 'gemini':
      return { source: 'env', id: 'GEMINI_API_KEY' }
    default:
      // Compose a plausible env var name from the provider; users can
      // override with an explicit SecretRef on the Identity.
      return { source: 'env', id: `${providerName.toUpperCase()}_API_KEY` }
  }
}
