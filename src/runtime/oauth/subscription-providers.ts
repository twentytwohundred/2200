/**
 * Fleet-scoped subscription-OAuth provider registry.
 *
 * One entry per "bring your subscription" sign-in (SuperGrok, ChatGPT).
 * Every surface that used to import xai-config directly ... the LLM
 * registry, the refresh service, the `/api/v1/oauth/*` HTTP routes,
 * the `2200 oauth <provider>` CLI subcommands, first-run ... looks the
 * provider up here instead, so adding (or killing) a subscription
 * provider is a data change in this file, not a fork of six call
 * sites.
 *
 * The seam is behavioral, not config-shaped, because the two live
 * providers do not share a wire protocol: xAI is textbook RFC 8628;
 * OpenAI's device surface is its own JSON shape with a loopback
 * (authorization-code + PKCE) fallback for accounts that have not
 * enabled device sign-in. Each def exposes start / poll-once /
 * refresh functions plus display strings; the generic drivers in the
 * CLI, HTTP routes, and first-run do the rest.
 *
 * See wiki/decisions/2026-07-10-oauth-ecosystem-openai-subscription.md.
 */
import {
  initDeviceAuthorization,
  pollDeviceTokenOnce,
  refreshDeviceFlowToken,
  type DeviceFlowPrompt,
  type DeviceTokenPollOutcome,
} from './device-flow.js'
import { OAuthError } from './types.js'
import { generatePkce } from './pkce.js'
import {
  accessTokenExpiryMs,
  extractChatgptAccountId,
  fetchOpenAiDiscovery,
  openaiLoopbackProvider,
  OPENAI_LOOPBACK_REDIRECT,
  OPENAI_OAUTH_CLIENT_ID,
  OPENAI_OAUTH_REFRESH_SKEW_SECONDS,
  pollOpenAiDeviceTokenOnce,
  startOpenAiDeviceFlow,
} from './openai-config.js'
import { readOAuthToken, saveOAuthToken, type OAuthTokenRecord } from './token-store.js'
import type { OAuthProviderConfig, OAuthTokenResponse } from './types.js'
import {
  fetchXaiDiscovery,
  xaiDeviceFlowProvider,
  XAI_OAUTH_REFRESH_SKEW_SECONDS,
} from './xai-config.js'

/** Common options threaded through every flow function (test seams). */
export interface SubscriptionFlowOptions {
  fetchImpl?: typeof fetch
  nowFn?: () => number
}

/**
 * Result of starting a device-code-style sign-in. `pollState` is the
 * opaque per-provider state each subsequent poll needs; it is a flat
 * string record so the browser-driven session manager can hold it
 * without knowing provider internals.
 */
export interface SubscriptionSignInStart {
  readonly userCode: string
  readonly verificationUri: string
  readonly verificationUriComplete?: string
  readonly expiresAtMs: number
  readonly intervalSec: number
  readonly pollState: Record<string, string>
}

export interface SubscriptionOAuthProviderDef {
  /** Token-store key + registry slug, e.g. 'xai-oauth'. */
  readonly slug: string
  /** LLM provider name operators pick in the model picker, e.g. 'xai-subscription'. */
  readonly llmProvider: string
  /** URL/CLI segment: `/api/v1/oauth/<route>/...`, `2200 oauth <route> ...`. */
  readonly route: string
  /** Full display label for settings surfaces. */
  readonly label: string
  /** Short label for prose ("your <shortLabel> subscription"). */
  readonly shortLabel: string
  /** Call-to-action for buttons/prompts, e.g. 'Sign in with ChatGPT'. */
  readonly signInCta: string
  /** CLI command that starts a sign-in, for error messages. */
  readonly signInCommand: string
  /** Provider-specific note to show alongside the user code. */
  readonly consentNote: string
  /** Refresh when the bearer has this many seconds (or fewer) left. */
  readonly refreshSkewSeconds: number
  /**
   * Pricing-table namespace whose model list feeds the picker's
   * Subscriptions optgroup. Defaults to `llmProvider`; xAI aliases to
   * 'xai' because the subscription reaches the same model ids as the
   * API-key provider.
   */
  readonly modelsPricingAlias?: string
  /** Start a device-code sign-in. Throws when the surface rejects the mint. */
  startDeviceFlow(opts?: SubscriptionFlowOptions): Promise<SubscriptionSignInStart>
  /** One token poll for a previously started sign-in. */
  pollDeviceFlowOnce(
    pollState: Record<string, string>,
    opts?: SubscriptionFlowOptions,
  ): Promise<DeviceTokenPollOutcome>
  /** Public-client refresh grant against the provider token endpoint. */
  refreshTokens(refreshToken: string, opts?: SubscriptionFlowOptions): Promise<OAuthTokenResponse>
  /** Bearer expiry for a token response, unix ms. */
  tokenExpiresAtMs(tokens: OAuthTokenResponse, nowMs: number): number
  /** Upstream account identifier worth recording as metadata, if extractable. */
  subjectFromTokens?(tokens: OAuthTokenResponse): string | undefined
  /**
   * Loopback (authorization-code + PKCE) fallback for accounts where
   * device-code is unavailable. Absent when the provider has no such
   * flow (xAI's device grant is never account-gated).
   */
  readonly loopback?: {
    readonly redirect: {
      readonly port: number
      readonly path: string
      readonly urlHostname: string
    }
    providerConfig(opts?: SubscriptionFlowOptions): Promise<OAuthProviderConfig>
    readonly clientId: string
  }
}

const XAI_DEF: SubscriptionOAuthProviderDef = {
  slug: 'xai-oauth',
  llmProvider: 'xai-subscription',
  route: 'xai',
  label: 'xAI / Grok (SuperGrok subscription)',
  shortLabel: 'SuperGrok',
  signInCta: 'Sign in with X / SuperGrok',
  signInCommand: '2200 oauth xai login',
  consentNote:
    'The consent screen says "Grok Build" because integrators share xAI\'s CLI OAuth client. That is expected; you are not installing a new app.',
  refreshSkewSeconds: XAI_OAUTH_REFRESH_SKEW_SECONDS,
  modelsPricingAlias: 'xai',
  async startDeviceFlow(opts = {}) {
    const discovery = await fetchXaiDiscovery(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {})
    const provider = xaiDeviceFlowProvider(discovery)
    const pkce = generatePkce()
    const initArgs: Parameters<typeof initDeviceAuthorization>[0] = {
      provider,
      codeChallenge: pkce.challenge,
      codeChallengeMethod: pkce.method,
    }
    if (opts.fetchImpl) initArgs.fetchImpl = opts.fetchImpl
    if (opts.nowFn) initArgs.nowFn = opts.nowFn
    const init = await initDeviceAuthorization(initArgs)
    return {
      userCode: init.userCode,
      verificationUri: init.verificationUri,
      ...(init.verificationUriComplete
        ? { verificationUriComplete: init.verificationUriComplete }
        : {}),
      expiresAtMs: init.expiresAtMs,
      intervalSec: init.intervalSec,
      pollState: {
        token_url: provider.tokenUrl,
        client_id: provider.clientId,
        device_code: init.deviceCode,
        code_verifier: pkce.verifier,
      },
    }
  },
  async pollDeviceFlowOnce(pollState, opts = {}) {
    const args: Parameters<typeof pollDeviceTokenOnce>[0] = {
      tokenUrl: pollState['token_url'] ?? '',
      clientId: pollState['client_id'] ?? '',
      deviceCode: pollState['device_code'] ?? '',
      codeVerifier: pollState['code_verifier'] ?? '',
    }
    if (opts.fetchImpl) args.fetchImpl = opts.fetchImpl
    return pollDeviceTokenOnce(args)
  },
  async refreshTokens(refreshToken, opts = {}) {
    const discovery = await fetchXaiDiscovery(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {})
    const provider = xaiDeviceFlowProvider(discovery)
    const args: Parameters<typeof refreshDeviceFlowToken>[0] = {
      provider: { tokenUrl: provider.tokenUrl, clientId: provider.clientId },
      refreshToken,
    }
    if (opts.fetchImpl) args.fetchImpl = opts.fetchImpl
    return refreshDeviceFlowToken(args)
  },
  tokenExpiresAtMs(tokens, nowMs) {
    return tokens.expires_in !== undefined ? nowMs + tokens.expires_in * 1000 : nowMs + 3600_000
  },
}

const OPENAI_DEF: SubscriptionOAuthProviderDef = {
  slug: 'openai-oauth',
  llmProvider: 'openai-subscription',
  route: 'openai',
  label: 'OpenAI / ChatGPT (Plus/Pro subscription)',
  shortLabel: 'ChatGPT',
  signInCta: 'Sign in with ChatGPT',
  signInCommand: '2200 oauth openai login',
  consentNote:
    'Device sign-in must be enabled on your ChatGPT account (Settings → Security → "Device code authentication"). If the code page rejects the code, enable that toggle or use the browser sign-in fallback.',
  refreshSkewSeconds: OPENAI_OAUTH_REFRESH_SKEW_SECONDS,
  async startDeviceFlow(opts = {}) {
    const startOpts: Parameters<typeof startOpenAiDeviceFlow>[0] = {}
    if (opts.fetchImpl) startOpts.fetchImpl = opts.fetchImpl
    if (opts.nowFn) startOpts.nowFn = opts.nowFn
    const start = await startOpenAiDeviceFlow(startOpts)
    return {
      userCode: start.userCode,
      verificationUri: start.verificationUri,
      expiresAtMs: start.expiresAtMs,
      intervalSec: start.intervalSec,
      pollState: {
        device_auth_id: start.pollState.deviceAuthId,
        user_code: start.pollState.userCode,
        code_verifier: start.pollState.codeVerifier,
      },
    }
  },
  async pollDeviceFlowOnce(pollState, opts = {}) {
    return pollOpenAiDeviceTokenOnce(
      {
        deviceAuthId: pollState['device_auth_id'] ?? '',
        userCode: pollState['user_code'] ?? '',
        codeVerifier: pollState['code_verifier'] ?? '',
      },
      opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {},
    )
  },
  async refreshTokens(refreshToken, opts = {}) {
    const discovery = await fetchOpenAiDiscovery(
      opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {},
    )
    const args: Parameters<typeof refreshDeviceFlowToken>[0] = {
      provider: { tokenUrl: discovery.token_endpoint, clientId: OPENAI_OAUTH_CLIENT_ID },
      refreshToken,
    }
    if (opts.fetchImpl) args.fetchImpl = opts.fetchImpl
    return refreshDeviceFlowToken(args)
  },
  tokenExpiresAtMs(tokens, nowMs) {
    if (tokens.expires_in !== undefined) return nowMs + tokens.expires_in * 1000
    return accessTokenExpiryMs(tokens.access_token) ?? nowMs + 3600_000
  },
  subjectFromTokens(tokens) {
    return extractChatgptAccountId(tokens.access_token) ?? undefined
  },
  loopback: {
    redirect: OPENAI_LOOPBACK_REDIRECT,
    async providerConfig(opts = {}) {
      const discovery = await fetchOpenAiDiscovery(
        opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {},
      )
      return openaiLoopbackProvider(discovery)
    },
    clientId: OPENAI_OAUTH_CLIENT_ID,
  },
}

/** Display order: this is the order Settings and first-run present the peer cards. */
export const SUBSCRIPTION_OAUTH_PROVIDERS: readonly SubscriptionOAuthProviderDef[] = [
  XAI_DEF,
  OPENAI_DEF,
]

export function subscriptionProviderBySlug(slug: string): SubscriptionOAuthProviderDef | undefined {
  return SUBSCRIPTION_OAUTH_PROVIDERS.find((d) => d.slug === slug)
}

export function subscriptionProviderByRoute(
  route: string,
): SubscriptionOAuthProviderDef | undefined {
  return SUBSCRIPTION_OAUTH_PROVIDERS.find((d) => d.route === route)
}

export function subscriptionProviderByLlmName(
  llmProvider: string,
): SubscriptionOAuthProviderDef | undefined {
  return SUBSCRIPTION_OAUTH_PROVIDERS.find((d) => d.llmProvider === llmProvider)
}

/** True iff a non-expired token for the def's slug sits in the fleet store. */
export async function hasActiveSubscription(
  home: string,
  slug: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  try {
    const token = await readOAuthToken(home, slug)
    return token !== null && token.metadata.expires_at_ms > nowMs
  } catch {
    return false
  }
}

/**
 * LLM provider names (e.g. 'xai-subscription') with an active
 * subscription credential. The onboarding default-pick and the
 * Settings providers DTO consume this.
 */
export async function activeSubscriptionLlmProviders(
  home: string,
  nowMs: number = Date.now(),
): Promise<Set<string>> {
  const out = new Set<string>()
  for (const def of SUBSCRIPTION_OAUTH_PROVIDERS) {
    if (await hasActiveSubscription(home, def.slug, nowMs)) out.add(def.llmProvider)
  }
  return out
}

/**
 * Blocking device-code sign-in driver for a subscription provider:
 * start the flow, surface the code via `onPrompt`, poll to a terminal
 * outcome. The single loop the CLI subcommands and the first-run
 * wizard share; the browser path drives the same start/poll functions
 * per-request instead of blocking.
 */
export async function runSubscriptionDeviceFlow(
  def: SubscriptionOAuthProviderDef,
  opts: {
    onPrompt: (prompt: DeviceFlowPrompt) => void
    /** Overall timeout override; defaults to the provider's code expiry. */
    timeoutSeconds?: number
    fetchImpl?: typeof fetch
    nowFn?: () => number
    sleepFn?: (ms: number) => Promise<void>
  },
): Promise<OAuthTokenResponse> {
  const now = opts.nowFn ?? (() => Date.now())
  const sleep =
    opts.sleepFn ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms)
      }))
  const flowOpts: SubscriptionFlowOptions = {}
  if (opts.fetchImpl) flowOpts.fetchImpl = opts.fetchImpl
  if (opts.nowFn) flowOpts.nowFn = opts.nowFn

  const start = await def.startDeviceFlow(flowOpts)
  opts.onPrompt({
    userCode: start.userCode,
    verificationUri: start.verificationUri,
    verificationUriComplete: start.verificationUriComplete,
    expiresAt: new Date(start.expiresAtMs),
  })

  let intervalSec = start.intervalSec
  const deadline =
    opts.timeoutSeconds !== undefined ? now() + opts.timeoutSeconds * 1000 : start.expiresAtMs

  // First wait so we do not slam the token endpoint immediately.
  await sleep(intervalSec * 1000)

  while (now() < deadline) {
    const outcome = await def.pollDeviceFlowOnce(start.pollState, flowOpts)
    if (outcome.status === 'completed') return outcome.tokens
    if (outcome.status === 'transient' || outcome.status === 'pending') {
      await sleep(intervalSec * 1000)
      continue
    }
    if (outcome.status === 'slow_down') {
      intervalSec = Math.min(intervalSec + 5, 60)
      await sleep(intervalSec * 1000)
      continue
    }
    if (outcome.error === 'expired_token') {
      throw new OAuthError(
        'device code expired before user approval; restart the flow',
        'CALLBACK_TIMEOUT',
      )
    }
    if (outcome.error === 'access_denied') {
      throw new OAuthError('user denied access at the provider consent screen', 'PROVIDER_DENIED')
    }
    throw new OAuthError(
      `device-code sign-in failed: ${outcome.error}${outcome.description ? ` — ${outcome.description}` : ''}`,
      'TOKEN_EXCHANGE_FAILED',
    )
  }

  throw new OAuthError(
    'device-code flow timed out before user approval completed',
    'CALLBACK_TIMEOUT',
  )
}

/**
 * Persist a sign-in's token response to the fleet store. Single write
 * path for the CLI, first-run, and the HTTP routes so the metadata
 * shape (expiry, scopes, subject) cannot drift between them. Throws
 * when the provider returned no refresh token ... without one the
 * background refresh cannot keep the fleet signed in.
 */
export async function saveSubscriptionTokens(
  home: string,
  def: SubscriptionOAuthProviderDef,
  tokens: OAuthTokenResponse,
  nowMs: number = Date.now(),
): Promise<OAuthTokenRecord> {
  if (!tokens.refresh_token) {
    throw new Error(
      `${def.shortLabel} did not return a refresh token; ensure the offline_access scope was granted at consent.`,
    )
  }
  const subject = def.subjectFromTokens?.(tokens)
  const record: OAuthTokenRecord = {
    provider: def.slug,
    bearer: tokens.access_token,
    refreshToken: tokens.refresh_token,
    metadata: {
      ...(subject ? { subject } : {}),
      granted_scopes: tokens.scope ? tokens.scope.split(/\s+/) : [],
      expires_at_ms: def.tokenExpiresAtMs(tokens, nowMs),
      created_at: new Date(nowMs).toISOString(),
    },
  }
  await saveOAuthToken(home, record)
  return record
}
