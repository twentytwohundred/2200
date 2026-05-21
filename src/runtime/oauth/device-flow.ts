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
 * This module is pure I/O: takes a config, returns a token response.
 * The caller (CLI for `2200 oauth login xai`, daemon HTTP route for
 * web-driven sign-in) is responsible for vault writes and refresh
 * scheduling.
 */
import { generatePkce } from './pkce.js'
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

export interface RunDeviceFlowOptions {
  provider: DeviceFlowProviderConfig
  /** Override scopes; defaults to provider.scopes. */
  scopes?: readonly string[]
  /**
   * Called once we have the user_code and verification URI but before
   * polling begins. The implementation surfaces these to the operator
   * (print to stderr, web UI render, etc.). Synchronous.
   */
  onPrompt: (prompt: DeviceFlowPrompt) => void
  /** Override fetch (testing). Default: global fetch. */
  fetchImpl?: typeof fetch
  /** Override the clock (testing). Default: Date.now. */
  nowFn?: () => number
  /**
   * Override the polling sleep (testing). Default: setTimeout-based.
   * Called between token polls.
   */
  sleepFn?: (ms: number) => Promise<void>
  /**
   * Optional overall timeout in seconds. Defaults to `expires_in` from
   * the device-authorization response (typically 900s = 15 min).
   */
  timeoutSeconds?: number
}

/**
 * Run the device-code flow end to end. Resolves to the token response.
 * Rejects with an OAuthError on any unrecoverable error or timeout.
 */
export async function runDeviceFlow(opts: RunDeviceFlowOptions): Promise<OAuthTokenResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const sleep = opts.sleepFn ?? defaultSleep
  const now = opts.nowFn ?? (() => Date.now())

  const pkce = generatePkce()
  const scopes = opts.scopes ?? opts.provider.scopes
  const scopeSeparator = opts.provider.scopeSeparator ?? ' '
  const scopeString = scopes.join(scopeSeparator)

  // ----------------------------------------------------------------------
  // Step 1: device authorization request.
  // ----------------------------------------------------------------------
  const initBody = new URLSearchParams()
  initBody.set('client_id', opts.provider.clientId)
  initBody.set('scope', scopeString)
  initBody.set('code_challenge', pkce.challenge)
  initBody.set('code_challenge_method', pkce.method)

  let initRes
  try {
    initRes = await fetchImpl(opts.provider.deviceAuthorizationUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: initBody.toString(),
    })
  } catch (err) {
    throw new OAuthError(
      `device authorization request to ${opts.provider.deviceAuthorizationUrl} failed: ${
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
  if (!initJson || typeof initJson.device_code !== 'string') {
    throw new OAuthError('device authorization response missing device_code', 'INVALID_RESPONSE')
  }

  // ----------------------------------------------------------------------
  // Step 2: surface the verification URI + user_code so the operator
  // can complete consent in a browser. The caller decides how to show
  // it (CLI prints, web UI renders inline).
  // ----------------------------------------------------------------------
  const expiresInSec = Number.isFinite(initJson.expires_in) ? initJson.expires_in : 900
  const expiresAt = new Date(now() + expiresInSec * 1000)
  opts.onPrompt({
    userCode: initJson.user_code,
    verificationUri: initJson.verification_uri,
    verificationUriComplete: initJson.verification_uri_complete,
    expiresAt,
  })

  // ----------------------------------------------------------------------
  // Step 3: poll the token endpoint until the user approves or expires.
  // RFC 8628 error semantics:
  //   - authorization_pending: keep waiting at current interval
  //   - slow_down:             bump interval by +5s
  //   - expired_token:         abort (device_code expired)
  //   - access_denied:         abort (user said no)
  //   - anything else:         abort
  // ----------------------------------------------------------------------
  let intervalSec = clampInterval(initJson.interval)
  const overallTimeoutMs = (opts.timeoutSeconds ?? expiresInSec) * 1000
  const deadline = now() + overallTimeoutMs

  // First wait so we do not slam the token endpoint immediately.
  await sleep(intervalSec * 1000)

  while (now() < deadline) {
    const pollBody = new URLSearchParams()
    pollBody.set('grant_type', 'urn:ietf:params:oauth:grant-type:device_code')
    pollBody.set('device_code', initJson.device_code)
    pollBody.set('client_id', opts.provider.clientId)
    pollBody.set('code_verifier', pkce.verifier)

    let pollRes
    try {
      pollRes = await fetchImpl(opts.provider.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: pollBody.toString(),
      })
    } catch {
      // Transient network errors are tolerated: keep polling. We do
      // not want a brief blip to kill a flow the user has already
      // approved in their browser.
      await sleep(intervalSec * 1000)
      continue
    }

    const pollJson = (await pollRes.json().catch(() => null)) as
      | OAuthTokenResponse
      | { error: string; error_description?: string }
      | null

    if (pollRes.ok && pollJson && 'access_token' in pollJson && pollJson.access_token) {
      return pollJson
    }

    const errorCode =
      pollJson && typeof pollJson === 'object' && 'error' in pollJson && pollJson.error
        ? pollJson.error
        : null

    if (errorCode === 'authorization_pending') {
      await sleep(intervalSec * 1000)
      continue
    }
    if (errorCode === 'slow_down') {
      intervalSec = clampInterval(intervalSec + 5)
      await sleep(intervalSec * 1000)
      continue
    }
    if (errorCode === 'expired_token') {
      throw new OAuthError(
        'device code expired before user approval; restart the flow',
        'CALLBACK_TIMEOUT',
      )
    }
    if (errorCode === 'access_denied') {
      throw new OAuthError('user denied access at the provider consent screen', 'PROVIDER_DENIED')
    }
    // Anything else: abort. Include the description if present.
    const desc =
      pollJson && typeof pollJson === 'object' && 'error_description' in pollJson
        ? (pollJson.error_description ?? '')
        : ''
    throw new OAuthError(
      `device-code token poll failed: ${errorCode ?? 'unknown'}${desc ? ` — ${desc}` : ''}`,
      'TOKEN_EXCHANGE_FAILED',
    )
  }

  throw new OAuthError(
    'device-code flow timed out before user approval completed',
    'CALLBACK_TIMEOUT',
  )
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
function clampInterval(seconds: number | undefined): number {
  if (!Number.isFinite(seconds) || seconds === undefined || seconds < 5) return 5
  if (seconds > 60) return 60
  return seconds
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
