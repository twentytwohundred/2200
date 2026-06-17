/**
 * Fleet default model + credential resolver ... the single source of truth for
 * "what the fleet runs on."
 *
 * It derives the default from the operator's ACTIVE subscription (today: a
 * non-expired xAI SuperGrok OAuth token in the sealed fleet token store). No
 * model literal lives at any call site ... the model id comes from the model
 * catalog, the credential from the OAuth token store, and the vendor base URL
 * from the provider registry. Call sites ask this resolver; this resolver asks
 * those registries.
 *
 * Its first job: wire the OpenPub pub-server's own LLM (the Bartender persona +
 * conversation-memory fragment generation) onto the SAME subscription the
 * fleet's Agents use. The pub-server was getting no credential, so those calls
 * 401'd ... and the failed memory-fragment broadcasts destabilized agent
 * WebSocket connections and kicked them out of the room. Giving it a valid
 * subscription credential stops that.
 */
import { readOAuthToken } from '../oauth/token-store.js'
import { CATALOG } from '../models/catalog.js'
import { OPENAI_COMPATIBLE_VENDORS } from '../llm/registry.js'

/**
 * LLM config for the pub-server, expressed in its env vocabulary (it reads
 * LLM_PROVIDER / LLM_BASE_URL / LLM_API_KEY / LLM_MODEL). `provider` is the
 * pub-server's adapter selector ('openai' = its OpenAI-compatible adapter,
 * correct for any OpenAI-compatible vendor incl. api.x.ai), NOT a model.
 */
export interface PubServerLlmConfig {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
}

export interface FleetDefaults {
  /** True when an active (non-expired) fleet subscription is signed in. */
  subscriptionActive: boolean
  /**
   * Pub-server LLM wiring derived from the active subscription, or null when no
   * subscription is active (callers then omit the LLM_* env so the pub-server's
   * patched guards turn the bartender + fragments into clean no-ops, not 401s).
   */
  pubServerLlm: PubServerLlmConfig | null
}

/** The xAI frontier model id from the catalog ... no inline model literal. */
function fleetSubscriptionModelId(): string | null {
  const entry = CATALOG.find(
    (e) => e.provider === 'xai' && e.tier === 'frontier' && e.status === 'active',
  )
  return entry?.model_id ?? null
}

/**
 * Resolve the fleet defaults for a home. Reads the sealed xai-oauth token; if
 * present and non-expired, the subscription is active and we build the
 * pub-server LLM wiring from it (catalog model + registry baseUrl + live
 * bearer). The OAuth bearer is short-lived; a long-running pub-server that got
 * it at spawn must be restarted when the token refreshes (the supervisor does
 * this on the refresh-service's fleet-token-refreshed signal).
 */
export async function resolveFleetDefaults(home: string): Promise<FleetDefaults> {
  const token = await readOAuthToken(home, 'xai-oauth').catch(() => null)
  if (!token || token.metadata.expires_at_ms <= Date.now()) {
    return { subscriptionActive: false, pubServerLlm: null }
  }
  const model = fleetSubscriptionModelId()
  const vendor = OPENAI_COMPATIBLE_VENDORS['xai-subscription']
  if (!model || !vendor) {
    // Subscription is present but the catalog/registry wiring is missing.
    // Don't ship a half-config that would 401; degrade to "no pub LLM".
    return { subscriptionActive: true, pubServerLlm: null }
  }
  return {
    subscriptionActive: true,
    pubServerLlm: {
      provider: 'openai',
      baseUrl: vendor.baseUrl,
      apiKey: token.bearer,
      model,
    },
  }
}
