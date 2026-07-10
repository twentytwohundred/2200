/**
 * Model catalog (Epic 10 Phase A).
 *
 * Static, hand-curated list of models the runtime knows about. Each
 * entry describes:
 *   - tier (frontier / fast / economy / specialist)
 *   - status (active / deprecated / retired)
 *   - recommended_successor (when status !== 'active')
 *   - display_name (humanized)
 *
 * Phase A is hand-curated. Phase B can grow a polling layer that
 * auto-tags status from provider APIs. Phase C is where quality
 * drift detection lives.
 *
 * The catalog feeds `2200 model list / status / migrate` and the
 * Phase B notification flow. The runtime does NOT auto-migrate
 * Agents at v1; a deprecated model continues to work until the user
 * (or, eventually, an auto-migration policy) runs `2200 model migrate`.
 *
 * Update process:
 * - Add new entries when a vendor announces a new model. Mark old
 *   models `deprecated` with the new model as `recommended_successor`.
 * - Mark models `retired` when the vendor returns a non-200 for them.
 * - Keep tiers stable: a model's tier is set at catalog-add and does
 *   not change. A new tier-mate is a new entry.
 */

export type ModelStatus = 'active' | 'deprecated' | 'retired'
export type ModelTier = 'frontier' | 'fast' | 'economy' | 'specialist'

export interface CatalogEntry {
  /** "<provider>/<model_id>" canonical id. */
  readonly id: string
  readonly provider: string
  readonly model_id: string
  readonly tier: ModelTier
  readonly status: ModelStatus
  readonly display_name: string
  /** When `status !== 'active'`, the recommended successor. Format: same as `id`. */
  readonly recommended_successor?: string
  /** Free-form notes shown by `2200 model list`. */
  readonly notes?: string
  /** Optional: declared support for a follow-up reasoner model in the same family. */
  readonly companion_reasoner?: string
}

/**
 * Hand-curated catalog. Order is irrelevant; lookups are by id.
 *
 * Conventions in use:
 * - Anthropic: `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`
 *   (per CLAUDE.md model IDs as of 2026-04-29).
 * - DeepSeek: `deepseek-chat`, `deepseek-reasoner`. v4 shipped
 *   2026-04-24 (project memory).
 * - OpenAI: `gpt-5`, `gpt-5-mini` (placeholder names for the family
 *   structure; replace with real ids when v1 picks an OpenAI line).
 */
export const CATALOG: readonly CatalogEntry[] = [
  // Anthropic
  {
    id: 'anthropic/claude-opus-4-7',
    provider: 'anthropic',
    model_id: 'claude-opus-4-7',
    tier: 'frontier',
    status: 'active',
    display_name: 'Claude Opus 4.7',
    notes: 'Primary frontier model on 2200. Hobby host model.',
  },
  {
    id: 'anthropic/claude-sonnet-4-6',
    provider: 'anthropic',
    model_id: 'claude-sonnet-4-6',
    tier: 'fast',
    status: 'active',
    display_name: 'Claude Sonnet 4.6',
    notes: 'Workhorse fast tier. Good for high-volume agents and tool-heavy loops.',
  },
  {
    id: 'anthropic/claude-haiku-4-5-20251001',
    provider: 'anthropic',
    model_id: 'claude-haiku-4-5-20251001',
    tier: 'economy',
    status: 'active',
    display_name: 'Claude Haiku 4.5',
    notes: 'Economy tier. Cheap baseline for low-stakes loops and triage.',
  },

  // DeepSeek
  {
    id: 'deepseek/deepseek-chat',
    provider: 'deepseek',
    model_id: 'deepseek-chat',
    tier: 'fast',
    status: 'active',
    display_name: 'DeepSeek Chat',
    notes: 'Fast tier. Pairs with deepseek-reasoner for follow-ups.',
    companion_reasoner: 'deepseek-reasoner',
  },
  {
    id: 'deepseek/deepseek-reasoner',
    provider: 'deepseek',
    model_id: 'deepseek-reasoner',
    tier: 'specialist',
    status: 'active',
    display_name: 'DeepSeek Reasoner',
    notes: 'Specialist tier. Slower, deeper. Used as followup_model_id in chained agents.',
  },
  {
    id: 'deepseek/deepseek-v4',
    provider: 'deepseek',
    model_id: 'deepseek-v4',
    tier: 'frontier',
    status: 'active',
    display_name: 'DeepSeek v4',
    notes: 'Shipped 2026-04-24; parity-with-Opus claims for coding workloads worth watching.',
  },

  // Kimi (Moonshot)
  {
    id: 'kimi/moonshot-v1-128k',
    provider: 'kimi',
    model_id: 'moonshot-v1-128k',
    tier: 'fast',
    status: 'active',
    display_name: 'Kimi (Moonshot v1, 128k)',
    notes: 'Fast tier with long context. Used for note-summarization workloads.',
  },

  // Gemini
  {
    id: 'gemini/gemini-2-5-pro',
    provider: 'gemini',
    model_id: 'gemini-2-5-pro',
    tier: 'frontier',
    status: 'active',
    display_name: 'Gemini 2.5 Pro',
  },

  // OpenRouter (aggregator; users specify the upstream model_id directly)
  {
    id: 'openrouter/auto',
    provider: 'openrouter',
    model_id: 'auto',
    tier: 'fast',
    status: 'active',
    display_name: 'OpenRouter Auto',
    notes: 'Aggregator default. Pricing varies; useful for fallback policies.',
  },

  // OpenAI ChatGPT subscription (Codex family). A ChatGPT Plus/Pro
  // subscription bearer serves ONLY the Codex model line via the
  // ChatGPT backend ... not OpenAI's full API catalog ... so these are
  // registered under the `openai-subscription` provider, distinct from
  // the API-key `openai` provider above. Coding-tuned but
  // general-capable. Model ids are from the public Codex line as of
  // the 2026-07-10 decision record; the list is confirmed on the first
  // live completion (the adapter is interim-flagged until then).
  {
    id: 'openai-subscription/gpt-5.1-codex',
    provider: 'openai-subscription',
    model_id: 'gpt-5.1-codex',
    tier: 'frontier',
    status: 'active',
    display_name: 'GPT-5.1 Codex (ChatGPT subscription)',
    notes:
      'Coding-tuned, general-capable. Served by the ChatGPT backend on a Plus/Pro subscription.',
  },
  {
    id: 'openai-subscription/gpt-5.1-codex-max',
    provider: 'openai-subscription',
    model_id: 'gpt-5.1-codex-max',
    tier: 'specialist',
    status: 'active',
    display_name: 'GPT-5.1 Codex Max (ChatGPT subscription)',
    notes: 'Long-horizon coding specialist. Heavier rate-limit draw on a subscription.',
  },
  {
    id: 'openai-subscription/gpt-5.1-codex-mini',
    provider: 'openai-subscription',
    model_id: 'gpt-5.1-codex-mini',
    tier: 'economy',
    status: 'active',
    display_name: 'GPT-5.1 Codex Mini (ChatGPT subscription)',
    notes: 'Smaller Codex variant; stretches subscription rate limits further.',
  },

  // xAI (Grok). Reachable two ways with the SAME model id: `xai-subscription`
  // (SuperGrok OAuth bearer ... the fleet-default credential) or `xai`
  // (XAI_API_KEY, metered). The catalog is the single registry of known model
  // ids; the fleet-default resolver reads grok from here rather than inlining
  // a literal at any call site.
  {
    id: 'xai/grok-4.3',
    provider: 'xai',
    model_id: 'grok-4.3',
    tier: 'frontier',
    status: 'active',
    display_name: 'Grok 4.3',
    notes: 'xAI frontier. Fleet default when a SuperGrok subscription is signed in.',
  },
]

/**
 * The catalog version (manual bump). Surfaces in the CLI so an
 * operator can tell which catalog snapshot their runtime knows about.
 */
export const CATALOG_VERSION = '0.1.0'

export interface CatalogIndex {
  byId: ReadonlyMap<string, CatalogEntry>
  byTier: ReadonlyMap<ModelTier, readonly CatalogEntry[]>
}

let cachedIndex: CatalogIndex | null = null

export function index(): CatalogIndex {
  if (cachedIndex) return cachedIndex
  const byId = new Map<string, CatalogEntry>()
  const byTier = new Map<ModelTier, CatalogEntry[]>()
  for (const e of CATALOG) {
    byId.set(e.id, e)
    let tierBucket = byTier.get(e.tier)
    if (!tierBucket) {
      tierBucket = []
      byTier.set(e.tier, tierBucket)
    }
    tierBucket.push(e)
  }
  cachedIndex = { byId, byTier }
  return cachedIndex
}

export function findById(id: string): CatalogEntry | undefined {
  return index().byId.get(id)
}

export function findByProviderAndModel(
  provider: string,
  modelId: string,
): CatalogEntry | undefined {
  return findById(`${provider}/${modelId}`)
}

export function listTier(tier: ModelTier): readonly CatalogEntry[] {
  return index().byTier.get(tier) ?? []
}

/**
 * Recommend a current model for a tier. Returns the first `active`
 * entry in the tier, or null if the tier has no active entries.
 *
 * Tie-break: catalog declaration order. Future Phase B: per-tier
 * preference order maintained explicitly in the catalog.
 */
export function recommendedForTier(tier: ModelTier): CatalogEntry | null {
  const entries = listTier(tier)
  for (const e of entries) {
    if (e.status === 'active') return e
  }
  return null
}
