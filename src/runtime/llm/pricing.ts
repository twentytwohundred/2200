/**
 * LLM pricing layer.
 *
 * Computes the dollar cost of a model call from its token counts and a
 * per-model price table. Token counts come from each provider's
 * `CompletionResponse.costMetrics`; the table is seeded from
 * `default-pricing.json` and overridable per-instance (override hook
 * lands in PR D when this is wired into the BudgetTracker; for now
 * `loadPricingTable()` returns the bundled default).
 *
 * Lookup is by `<provider>/<model_id>`; the provider is normalized
 * lowercase and the composite key matches the format in
 * [[2026-04-26-model-field-format]]. Models not in the table yield
 * `null` from `computeCostUsd` rather than throwing... the caller
 * decides whether to record an unknown-cost call or fall through.
 *
 * Unit prices are USD per million tokens. The math is straight
 * proportional: `tokens / 1_000_000 * rate`. Three rate columns:
 *   - `input_per_mtok_usd` — standard input rate (cache misses).
 *   - `output_per_mtok_usd` — generated output.
 *   - `cached_input_per_mtok_usd` — discounted rate for cache hits.
 *     Optional in the table; if absent, cached tokens fall through to
 *     the standard input rate.
 */
import { z } from 'zod'
import defaultPricingJson from './default-pricing.json' with { type: 'json' }

export const PricingEntrySchema = z.object({
  input_per_mtok_usd: z.number().nonnegative(),
  output_per_mtok_usd: z.number().nonnegative(),
  cached_input_per_mtok_usd: z.number().nonnegative().optional(),
})
export type PricingEntry = z.infer<typeof PricingEntrySchema>

export const PricingTableSchema = z.object({
  schema_version: z.literal(1),
  as_of: z.string(),
  currency: z.string().default('USD'),
  comment: z.string().optional(),
  models: z.record(z.string(), PricingEntrySchema),
})
export type PricingTable = z.infer<typeof PricingTableSchema>

/**
 * Inputs for a single cost computation. Token counts come straight from
 * a provider's `CostMetrics`; cachedTokens is the optional cache-hit
 * count from prompt-cache-aware providers.
 */
export interface ComputeCostInput {
  provider: string
  modelId: string
  inputTokens: number
  outputTokens: number
  cachedTokens?: number
}

/**
 * Compose the table key for a (provider, model_id) pair. Same format
 * as the model-field convention.
 */
export function pricingKey(provider: string, modelId: string): string {
  return `${provider.toLowerCase()}/${modelId}`
}

/**
 * Compute the cost of a single model call in USD. Returns null if the
 * (provider, model_id) pair is not in the supplied table.
 *
 * Token-count contract (normalized by every provider in
 * `src/runtime/llm/`):
 *   - `inputTokens` is the uncached portion of input tokens.
 *   - `cachedTokens` (optional) is the cache-hit portion.
 *   - Total prompt = inputTokens + (cachedTokens ?? 0).
 *
 * Cached tokens are billed at `cached_input_per_mtok_usd` when set in
 * the table; otherwise they fall through to the standard input rate
 * (the table entry is silent on caching). Output tokens are always
 * billed at `output_per_mtok_usd`.
 */
export function computeCostUsd(input: ComputeCostInput, table: PricingTable): number | null {
  const key = pricingKey(input.provider, input.modelId)
  const entry = table.models[key]
  if (!entry) return null

  const cached = input.cachedTokens ?? 0
  const inputCost = (input.inputTokens / 1_000_000) * entry.input_per_mtok_usd
  const outputCost = (input.outputTokens / 1_000_000) * entry.output_per_mtok_usd
  const cachedRate = entry.cached_input_per_mtok_usd ?? entry.input_per_mtok_usd
  const cachedCost = (cached / 1_000_000) * cachedRate

  return inputCost + outputCost + cachedCost
}

/**
 * Load the bundled default pricing table. The override path (a
 * per-instance JSON file under `<home>/config/pricing.json`) is wired
 * up in PR D when the BudgetTracker is introduced. For now this
 * function returns the validated default unconditionally.
 */
export function loadPricingTable(): PricingTable {
  return PricingTableSchema.parse(defaultPricingJson)
}

/**
 * Get the bundled default table without validating again. Useful for
 * tests that want to inspect the seed table without reloading from
 * JSON. Falls back to running the parser if validation has not run yet
 * for this process.
 */
let cachedDefault: PricingTable | null = null
export function defaultPricingTable(): PricingTable {
  cachedDefault ??= loadPricingTable()
  return cachedDefault
}
