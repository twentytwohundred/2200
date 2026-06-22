/**
 * Ranking for the onboarding default-provider pick. The load-bearing case is
 * the regression this fixes: a SuperGrok-only install (subscription OAuth, no
 * API key) must default onboarding to `xai-subscription`, NOT fall through to
 * the keyless `local` fallback (Ollama at localhost, usually not running).
 */
import { describe, expect, it } from 'vitest'
import { pickOnboardingProvider } from '../../../src/runtime/onboarding/pick-provider.js'
import type { ProviderCatalogEntry } from '../../../src/runtime/llm/registry.js'

function entry(
  name: string,
  category: ProviderCatalogEntry['category'],
  opts: { defaultEnvKey?: string; keyOptional?: boolean } = {},
): ProviderCatalogEntry {
  return {
    name,
    label: name,
    defaultEnvKey: opts.defaultEnvKey ?? `${name.toUpperCase()}_API_KEY`,
    kind: category === 'local' ? 'local' : 'openai-compatible',
    baseUrl: 'https://example.test',
    baseUrlEditable: category === 'local',
    baseUrlEnvKey: category === 'local' ? 'LOCAL_BASE_URL' : '',
    keyOptional: opts.keyOptional ?? false,
    category,
  }
}

// Mirrors the real catalog order: api-key providers first, subscription in the
// middle, the keyOptional `local` fallback last.
const CATALOG: ProviderCatalogEntry[] = [
  entry('anthropic', 'api-key'),
  entry('deepseek', 'api-key'),
  entry('xai-subscription', 'subscription'),
  entry('local', 'local', { defaultEnvKey: 'LOCAL_API_KEY', keyOptional: true }),
]

describe('pickOnboardingProvider', () => {
  it('picks the subscription for a SuperGrok-only install (no API key)', () => {
    const chosen = pickOnboardingProvider(CATALOG, {}, true)
    expect(chosen?.name).toBe('xai-subscription')
  })

  it('does NOT fall through to the keyless local fallback when a subscription is active', () => {
    const chosen = pickOnboardingProvider(CATALOG, {}, true)
    expect(chosen?.name).not.toBe('local')
  })

  it('falls back to local when nothing is configured (no keys, no subscription)', () => {
    const chosen = pickOnboardingProvider(CATALOG, {}, false)
    expect(chosen?.name).toBe('local')
  })

  it('a set API key wins over the subscription (catalog order: api-key first)', () => {
    const chosen = pickOnboardingProvider(CATALOG, { ANTHROPIC_API_KEY: 'sk-x' }, true)
    expect(chosen?.name).toBe('anthropic')
  })

  it('an inactive subscription does not count as configured', () => {
    // OAuth token expired/absent → subscriptionActive false → not chosen.
    const chosen = pickOnboardingProvider(CATALOG, {}, false)
    expect(chosen?.name).toBe('local')
  })

  it('returns null when there is no credential and no keyOptional fallback', () => {
    const noFallback = CATALOG.filter((p) => !p.keyOptional)
    expect(pickOnboardingProvider(noFallback, {}, false)).toBeNull()
  })
})
