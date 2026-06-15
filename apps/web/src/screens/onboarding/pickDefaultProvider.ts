/**
 * Choose the default provider + model for the Build-an-Agent interview.
 *
 * The interview used to default to whatever provider came first in the
 * pickable list ... which is a `keyOptional` provider like OpenRouter, with
 * a free-text model field, even when the instance already has real
 * credentials configured (migrated API keys, an xAI/SuperGrok sign-in). That
 * made a migrated operator re-pick a provider and type a model id by hand.
 *
 * Preference order, most-faithful-to-the-instance first:
 *   1. A configured provider an existing Agent already uses ... match the
 *      fleet (e.g. the just-migrated Agent's own provider).
 *   2. A configured subscription credential (an explicit OAuth sign-in).
 *   3. Any provider that has a credential set.
 *   4. Fall back to the first pickable option (keyOptional, e.g. OpenRouter).
 *
 * Pure + injectable so the ranking is unit-tested without the React tree.
 */
import type { ProviderSettingsItem } from '../../lib/api'

export interface PickableLike {
  name: string
  models: string[]
}

export function pickDefaultProvider(
  items: ProviderSettingsItem[],
  pickable: PickableLike[],
): { name: string; model: string } | null {
  const byName = (name: string | undefined): PickableLike | undefined =>
    name === undefined ? undefined : pickable.find((o) => o.name === name)

  const inUse = items.find((p) => p.key_set && p.agents_using.length > 0)
  const subscription = items.find((p) => p.key_set && p.category === 'subscription')
  const anyConfigured = items.find((p) => p.key_set)

  const chosen =
    byName(inUse?.name) ?? byName(subscription?.name) ?? byName(anyConfigured?.name) ?? pickable[0]

  if (!chosen) return null
  return { name: chosen.name, model: chosen.models[0] ?? '' }
}
