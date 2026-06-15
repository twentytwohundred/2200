/**
 * Tests for the Build-an-Agent interview's default provider choice.
 *
 * Why this matters: a migrated operator already has credentials (their
 * migrated API keys, an xAI/SuperGrok sign-in). The interview must default
 * to one of THOSE ... and ideally the one an existing Agent already uses ...
 * not to a generic keyOptional provider (OpenRouter) with a free-text model
 * field, which is what they got before.
 */
import { describe, expect, it } from 'vitest'
import {
  pickDefaultProvider,
  type PickableLike,
} from '../../src/screens/onboarding/pickDefaultProvider'
import type { ProviderSettingsItem } from '../../src/lib/api'

function provider(over: Partial<ProviderSettingsItem> & { name: string }): ProviderSettingsItem {
  return {
    label: over.name,
    defaultEnvKey: `${over.name.toUpperCase()}_API_KEY`,
    kind: 'openai-compatible',
    baseUrl: '',
    baseUrlEditable: false,
    baseUrlEnvKey: '',
    keyOptional: false,
    key_set: false,
    key_masked: null,
    agents_using: [],
    suggested_models: [],
    category: 'api-key',
    ...over,
  }
}

const pickable = (...names: { name: string; models?: string[] }[]): PickableLike[] =>
  names.map((n) => ({ name: n.name, models: n.models ?? [`${n.name}-model`] }))

describe('pickDefaultProvider', () => {
  it('prefers the provider an existing Agent already uses', () => {
    const items = [
      provider({ name: 'openrouter', keyOptional: true }),
      provider({ name: 'anthropic', key_set: true }),
      provider({
        name: 'xai',
        key_set: true,
        agents_using: ['skippy'],
        suggested_models: ['xai/grok-4.3'],
      }),
    ]
    const got = pickDefaultProvider(
      items,
      pickable(
        { name: 'openrouter' },
        { name: 'anthropic' },
        { name: 'xai', models: ['xai/grok-4.3'] },
      ),
    )
    expect(got).toEqual({ name: 'xai', model: 'xai/grok-4.3' })
  })

  it('prefers a configured subscription (OAuth) when no Agent-in-use match', () => {
    const items = [
      provider({ name: 'openrouter', keyOptional: true }),
      provider({ name: 'anthropic', key_set: true }),
      provider({ name: 'xai-subscription', key_set: true, category: 'subscription' }),
    ]
    const got = pickDefaultProvider(
      items,
      pickable({ name: 'openrouter' }, { name: 'anthropic' }, { name: 'xai-subscription' }),
    )
    expect(got?.name).toBe('xai-subscription')
  })

  it('falls back to any provider with a credential set', () => {
    const items = [
      provider({ name: 'openrouter', keyOptional: true }),
      provider({ name: 'deepseek', key_set: true }),
    ]
    const got = pickDefaultProvider(items, pickable({ name: 'openrouter' }, { name: 'deepseek' }))
    expect(got?.name).toBe('deepseek')
  })

  it('falls back to the first pickable option when nothing is configured', () => {
    const items = [provider({ name: 'openrouter', keyOptional: true })]
    const got = pickDefaultProvider(items, pickable({ name: 'openrouter' }))
    expect(got?.name).toBe('openrouter')
  })

  it('never returns a configured provider that is not actually pickable', () => {
    // key_set provider exists but isn't in the pickable list (e.g. filtered
    // out) ... fall through to a pickable one rather than a dead choice.
    const items = [provider({ name: 'xai', key_set: true, agents_using: ['skippy'] })]
    const got = pickDefaultProvider(items, pickable({ name: 'openrouter' }))
    expect(got?.name).toBe('openrouter')
  })

  it('returns null when there is nothing pickable at all', () => {
    expect(pickDefaultProvider([], [])).toBeNull()
  })
})
