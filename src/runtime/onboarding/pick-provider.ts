/**
 * Choose the default LLM provider for a Build-an-Agent onboarding session
 * when the caller (CLI legacy path, or a misconfigured client) names none.
 *
 * The runtime counterpart to the web's `pickDefaultProvider`. Kept pure +
 * injectable so the ranking is unit-tested without an HTTP server or the
 * global runtime.env path.
 *
 * A subscription provider (`xai-subscription`) is "configured" when its fleet
 * OAuth token is present + unexpired ... it never carries a runtime.env key.
 * The earlier env-key-only check missed it, so a SuperGrok-only install (Sign
 * in with X, no API key) fell through to the keyless `local` fallback (Ollama
 * at localhost, usually not running).
 *
 * Preference order:
 *   1. The first provider with a real credential ... an API key set in env, or
 *      an active subscription. API-key providers come first in the catalog, so
 *      a keyed provider still wins for mixed setups; the subscription only wins
 *      when nothing earlier has a key.
 *   2. The keyOptional fallback (`local`).
 *   3. null ... nothing usable; the caller surfaces a "configure a provider" error.
 */
import type { ProviderCatalogEntry } from '../llm/registry.js'

export function pickOnboardingProvider(
  providers: ProviderCatalogEntry[],
  env: Record<string, string>,
  subscriptionActive: boolean,
): ProviderCatalogEntry | null {
  const credentialed = providers.find((p) =>
    p.category === 'subscription' ? subscriptionActive : (env[p.defaultEnvKey] ?? '').length > 0,
  )
  return credentialed ?? providers.find((p) => p.keyOptional) ?? null
}
