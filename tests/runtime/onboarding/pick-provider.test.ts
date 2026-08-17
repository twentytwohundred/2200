/**
 * Ranking for the onboarding default-provider pick. The load-bearing case is
 * the regression this fixes: a subscription-only install (SuperGrok or ChatGPT
 * OAuth, no API key) must default onboarding to that subscription provider,
 * NOT fall through to the keyless `local` fallback (Ollama at localhost,
 * usually not running). With two subscription providers, "active" is
 * per-provider: an active ChatGPT sign-in must not make an inactive
 * xai-subscription look configured.
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

// Mirrors the real catalog order: api-key providers first, subscriptions in
// the middle, the keyOptional `local` fallback last.
const CATALOG: ProviderCatalogEntry[] = [
  entry('anthropic', 'api-key'),
  entry('deepseek', 'api-key'),
  entry('xai-subscription', 'subscription'),
  entry('openai-subscription', 'subscription'),
  entry('local', 'local', { defaultEnvKey: 'LOCAL_API_KEY', keyOptional: true }),
]

const NONE = new Set<string>()

describe('pickOnboardingProvider', () => {
  it('picks the subscription for a SuperGrok-only install (no API key)', () => {
    const chosen = pickOnboardingProvider(CATALOG, {}, new Set(['xai-subscription']))
    expect(chosen?.name).toBe('xai-subscription')
  })

  it('picks the ChatGPT subscription when it is the only active credential', () => {
    const chosen = pickOnboardingProvider(CATALOG, {}, new Set(['openai-subscription']))
    expect(chosen?.name).toBe('openai-subscription')
  })

  it('an active subscription for one provider does not configure the other', () => {
    // Only ChatGPT is signed in; xai-subscription (earlier in catalog
    // order) must be skipped, not matched by a blanket boolean.
    const chosen = pickOnboardingProvider(CATALOG, {}, new Set(['openai-subscription']))
    expect(chosen?.name).not.toBe('xai-subscription')
  })

  it('does NOT fall through to the keyless local fallback when a subscription is active', () => {
    const chosen = pickOnboardingProvider(CATALOG, {}, new Set(['xai-subscription']))
    expect(chosen?.name).not.toBe('local')
  })

  it('falls back to local when nothing is configured (no keys, no subscription)', () => {
    const chosen = pickOnboardingProvider(CATALOG, {}, NONE)
    expect(chosen?.name).toBe('local')
  })

  it('a set API key wins over the subscription (catalog order: api-key first)', () => {
    const chosen = pickOnboardingProvider(
      CATALOG,
      { ANTHROPIC_API_KEY: 'sk-x' },
      new Set(['xai-subscription']),
    )
    expect(chosen?.name).toBe('anthropic')
  })

  it('an inactive subscription does not count as configured', () => {
    // OAuth token expired/absent → provider not in the active set → not chosen.
    const chosen = pickOnboardingProvider(CATALOG, {}, NONE)
    expect(chosen?.name).toBe('local')
  })

  it('returns null when there is no credential and no keyOptional fallback', () => {
    const noFallback = CATALOG.filter((p) => !p.keyOptional)
    expect(pickOnboardingProvider(noFallback, {}, NONE)).toBeNull()
  })
})
