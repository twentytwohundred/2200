/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) with PKCE.
 *
 * Parallel surface to `flow.ts` (Authorization Code with PKCE +
 * loopback callback) for headless installs where opening a browser
 * back to `127.0.0.1:<port>` is awkward: typical 2200 user runs on a
 * Mac Mini / mini PC / homelab box, often over SSH.
 *
 * Shape of the flow:
 *
 *   1. Generate PKCE pair (S256). Mandatory for xAI (only method the
 *      issuer advertises). Public clients without S256 would be
 *      rejected by the token endpoint.
 *   2. POST to `device_authorization_endpoint` with client_id,
 *      scope, code_challenge, code_challenge_method=S256. Receive
 *      device_code, user_code, verification_uri, verification_uri_complete,
 *      expires_in, interval.
 *   3. Print the verification URI + user_code so the operator can
 *      complete the consent in any browser on any device. The shell
 *      stays attached and polls.
 *   4. Poll the token endpoint with grant_type=urn:ietf:params:oauth:grant-type:device_code,
 *      device_code, client_id, code_verifier. Respect RFC 8628 error
 *      semantics: `authorization_pending` => keep polling at current
 *      interval; `slow_down` => bump interval by +5s; `expired_token`,
 *      `access_denied`, anything else => abort.
 *   5. Token response carries access_token + refresh_token (when
 *      `offline_access` was requested) + expires_in.
 *
 * This module is pure I/O building blocks: an init request, a single
 * token poll, and the refresh grant. Pacing/loop policy lives in the
 * subscription registry's drivers; callers own vault writes and
 * refresh scheduling.
 */
import { OAuthError, type OAuthTokenResponse } from './types.js'

/** Endpoint set for a device-flow-capable OAuth provider. */
export interface DeviceFlowProviderConfig {
  /** Slug, e.g. 'xai-oauth'. */
  readonly name: string
  /** RFC 8628 device authorization endpoint. */
  readonly deviceAuthorizationUrl: string
  /** Token endpoint (also used for refresh). */
  readonly tokenUrl: string
  /** Optional revocation endpoint. */
  readonly revocationUrl?: string
  /** Public client id. No secret needed; PKCE binds the request. */
  readonly clientId: string
  /** Scopes to request. Include `offline_access` to get a refresh token. */
  readonly scopes: readonly string[]
  /** Default ' ' per OAuth 2.0; overridable per provider. */
  readonly scopeSeparator?: string
}

/** Raw device-authorization response from the provider. */
interface DeviceAuthorizationResponse {
  device_code: string
  user_code: string
  /** URL the user opens. May or may not include the code pre-filled. */
  verification_uri: string
  /** Some providers include a `_complete` variant with the user_code embedded. */
  verification_uri_complete?: string
  /** Seconds until device_code expires. */
  expires_in: number
  /** Seconds between polls (default 5 per spec). */
  interval?: number
}

/** Information surfaced to the caller mid-flow so they can guide the user. */
export interface DeviceFlowPrompt {
  readonly userCode: string
  readonly verificationUri: string
  readonly verificationUriComplete: string | undefined
  readonly expiresAt: Date
}

/** Parsed + normalized result of the device-authorization (init) request. */
export interface DeviceFlowInitResult {
  readonly deviceCode: string
  readonly userCode: string
  readonly verificationUri: string
  readonly verificationUriComplete: string | undefined
  readonly expiresAtMs: number
  readonly intervalSec: number
}

/**
 * Outcome of a single token-endpoint poll. Shared vocabulary between
 * the blocking sign-in driver (`runSubscriptionDeviceFlow`) and the browser-driven
 * per-poll HTTP route, so RFC 8628 error semantics live in exactly
 * one place.
 *
 *   - transient:  network blip; keep polling (a brief outage must not
 *                 kill a flow the user already approved in a browser)
 *   - pending:    authorization_pending; keep polling
 *   - slow_down:  bump the interval +5s, keep polling
 *   - completed:  provider returned tokens
 *   - failed:     terminal provider error (expired_token, access_denied, ...)
 */
export type DeviceTokenPollOutcome =
  | { status: 'transient'; message: string }
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'completed'; tokens: OAuthTokenResponse }
  | { status: 'failed'; error: string; description?: string }

/**
 * Run the RFC 8628 device-authorization (init) request and normalize
 * the response. PKCE is bound at init: pass the S256 challenge; keep
 * the matching verifier for the token polls.
 */
export async function initDeviceAuthorization(args: {
  provider: DeviceFlowProviderConfig
  codeChallenge: string
  codeChallengeMethod: string
  scopes?: readonly string[]
  fetchImpl?: typeof fetch
  nowFn?: () => number
}): Promise<DeviceFlowInitResult> {
  const fetchImpl = args.fetchImpl ?? fetch
  const now = args.nowFn ?? (() => Date.now())
  const scopes = args.scopes ?? args.provider.scopes
  const scopeSeparator = args.provider.scopeSeparator ?? ' '

  const initBody = new URLSearchParams()
  initBody.set('client_id', args.provider.clientId)
  initBody.set('scope', scopes.join(scopeSeparator))
  initBody.set('code_challenge', args.codeChallenge)
  initBody.set('code_challenge_method', args.codeChallengeMethod)

  let initRes
  try {
    initRes = await fetchImpl(args.provider.deviceAuthorizationUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: initBody.toString(),
    })
  } catch (err) {
    throw new OAuthError(
      `device authorization request to ${args.provider.deviceAuthorizationUrl} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      'TOKEN_EXCHANGE_FAILED',
    )
  }
  if (!initRes.ok) {
    const text = await initRes.text().catch(() => '')
    throw new OAuthError(
      `device authorization request failed: HTTP ${String(initRes.status)} ${text.slice(0, 500)}`,
      'TOKEN_EXCHANGE_FAILED',
    )
  }
  const initJson = (await initRes.json().catch(() => null)) as DeviceAuthorizationResponse | null
  if (
    !initJson ||
    typeof initJson.device_code !== 'string' ||
    typeof initJson.user_code !== 'string' ||
    typeof initJson.verification_uri !== 'string'
  ) {
    throw new OAuthError(
      'device authorization response missing device_code, user_code, or verification_uri',
      'INVALID_RESPONSE',
    )
  }
  const expiresInSec = Number.isFinite(initJson.expires_in) ? initJson.expires_in : 900
  return {
    deviceCode: initJson.device_code,
    userCode: initJson.user_code,
    verificationUri: initJson.verification_uri,
    verificationUriComplete: initJson.verification_uri_complete,
    expiresAtMs: now() + expiresInSec * 1000,
    intervalSec: clampInterval(initJson.interval),
  }
}

/**
 * One RFC 8628 token-endpoint poll. Pure request/normalize; the caller
 * owns pacing (sleep between polls) and interval bookkeeping.
 */
export async function pollDeviceTokenOnce(args: {
  tokenUrl: string
  clientId: string
  deviceCode: string
  codeVerifier: string
  fetchImpl?: typeof fetch
}): Promise<DeviceTokenPollOutcome> {
  const fetchImpl = args.fetchImpl ?? fetch
  const pollBody = new URLSearchParams()
  pollBody.set('grant_type', 'urn:ietf:params:oauth:grant-type:device_code')
  pollBody.set('device_code', args.deviceCode)
  pollBody.set('client_id', args.clientId)
  pollBody.set('code_verifier', args.codeVerifier)

  let pollRes
  try {
    pollRes = await fetchImpl(args.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: pollBody.toString(),
    })
  } catch (err) {
    return { status: 'transient', message: err instanceof Error ? err.message : String(err) }
  }

  const pollJson = (await pollRes.json().catch(() => null)) as
    | OAuthTokenResponse
    | { error: string; error_description?: string }
    | null

  if (pollRes.ok && pollJson && 'access_token' in pollJson && pollJson.access_token) {
    return { status: 'completed', tokens: pollJson }
  }

  const errorCode =
    pollJson && typeof pollJson === 'object' && 'error' in pollJson && pollJson.error
      ? pollJson.error
      : 'unknown'
  if (errorCode === 'authorization_pending') return { status: 'pending' }
  if (errorCode === 'slow_down') return { status: 'slow_down' }
  const desc =
    pollJson && typeof pollJson === 'object' && 'error_description' in pollJson
      ? (pollJson.error_description ?? '')
      : ''
  return { status: 'failed', error: errorCode, ...(desc ? { description: desc } : {}) }
}

/**
 * Exchange a refresh_token for a fresh access token. Used by the
 * refresh service and by any caller that detects an expired bearer.
 *
 * The xAI token endpoint accepts the public-client refresh grant
 * without a client_secret. The `code_verifier` is NOT replayed on
 * refresh; PKCE is bound only to the initial token mint.
 */
export async function refreshDeviceFlowToken(args: {
  provider: Pick<DeviceFlowProviderConfig, 'tokenUrl' | 'clientId'>
  refreshToken: string
  /** Override fetch (testing). */
  fetchImpl?: typeof fetch
}): Promise<OAuthTokenResponse> {
  const fetchImpl = args.fetchImpl ?? fetch
  const body = new URLSearchParams()
  body.set('grant_type', 'refresh_token')
  body.set('refresh_token', args.refreshToken)
  body.set('client_id', args.provider.clientId)

  let res
  try {
    res = await fetchImpl(args.provider.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    })
  } catch (err) {
    throw new OAuthError(
      `refresh token request to ${args.provider.tokenUrl} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      'TOKEN_EXCHANGE_FAILED',
    )
  }
  const json = (await res.json().catch(() => null)) as
    | OAuthTokenResponse
    | { error: string; error_description?: string }
    | null
  if (!res.ok || !json || !('access_token' in json) || !json.access_token) {
    const errorCode = json && typeof json === 'object' && 'error' in json ? json.error : 'unknown'
    const desc =
      json && typeof json === 'object' && 'error_description' in json
        ? (json.error_description ?? '')
        : ''
    throw new OAuthError(
      `refresh-token exchange failed: ${errorCode}${desc ? ` — ${desc}` : ''}`,
      'TOKEN_EXCHANGE_FAILED',
    )
  }
  return json
}

/** Per RFC 8628 §3.5: minimum 5 second polling interval. */
export function clampInterval(seconds: number | undefined): number {
  if (!Number.isFinite(seconds) || seconds === undefined || seconds < 5) return 5
  if (seconds > 60) return 60
  return seconds
}
