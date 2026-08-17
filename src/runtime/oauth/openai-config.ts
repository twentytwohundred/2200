/**
 * OpenAI / ChatGPT subscription OAuth provider configuration.
 *
 * OpenAI publishes an OIDC-style discovery document at
 * `https://auth.openai.com/.well-known/openid-configuration`; we fetch
 * it lazily at flow time (same posture as xai-config) so we do not
 * drift if OpenAI relocates the authorize/token routes. The discovery
 * doc is the authoritative source for the loopback (authorization-code
 * + PKCE) flow and for token refresh.
 *
 * The device-code flow is NOT in the discovery doc and is NOT RFC 8628.
 * It is OpenAI's own JSON-shaped surface under
 * `/api/accounts/deviceauth/*`, gated per-account by a "device code
 * authentication" toggle in the user's ChatGPT security settings. The
 * wire shape below was probed live on 2026-07-10 (mint + pending-poll
 * verified; approval/success shape NOT yet verified ... needs a real
 * ChatGPT subscription approval). Everything unverified is confined to
 * `OPENAI_DEVICE_AUTH_WIRE` so a wire-shape correction is a one-place
 * edit. See wiki/decisions/2026-07-10-oauth-ecosystem-openai-subscription.md.
 *
 * The shared public client id below is the one the open-source Codex
 * CLI and the third-party harnesses OpenAI has publicly sanctioned
 * (OpenClaw, OpenCode, Pi) all use. Public client: no client_secret;
 * PKCE S256 binds the exchange (`token_endpoint_auth_methods_supported`
 * includes "none").
 */
import { z } from 'zod'
import { clampInterval, type DeviceTokenPollOutcome } from './device-flow.js'
import type { OAuthProviderConfig, OAuthTokenResponse } from './types.js'
import { generatePkce } from './pkce.js'

/** OpenAI's account-auth issuer. */
export const OPENAI_OAUTH_ISSUER = 'https://auth.openai.com'

/** Discovery doc URL. Fetched lazily on flow entry. */
export const OPENAI_OAUTH_DISCOVERY_URL = `${OPENAI_OAUTH_ISSUER}/.well-known/openid-configuration`

/**
 * Public client shared by the open-source Codex CLI and the
 * third-party harnesses OpenAI has blessed. No client_secret.
 */
export const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

/** Scopes 2200 requests. Matches `scopes_supported` in the live discovery doc. */
export const OPENAI_OAUTH_SCOPES = ['openid', 'profile', 'email', 'offline_access'] as const

/**
 * Refresh skew: refresh when the access token has this many seconds
 * (or fewer) left. Same value as the xAI provider; the ChatGPT bearer
 * is longer-lived but the skew only needs to cover a round-trip.
 */
export const OPENAI_OAUTH_REFRESH_SKEW_SECONDS = 120

/**
 * ChatGPT device-code wire shape ... INTERIM, partially verified.
 *
 * Verified live 2026-07-10 (keyless probes from this repo):
 *   - `usercodeUrl` mints `{ device_auth_id, user_code, interval,
 *     expires_at }` from a JSON POST; tolerates client_id / scope /
 *     PKCE fields. `interval` arrives as a STRING ("5"); `expires_at`
 *     is an ISO timestamp (~15 min out).
 *   - `pollUrl` returns HTTP 403 + `error.code =
 *     "deviceauth_authorization_pending"` while approval is pending.
 *   - `verificationUri` serves a real (login-gated) page.
 *
 * NOT yet verified (needs one real approval from a ChatGPT
 * subscription; treated as unverified until a live sign-in completes):
 *   - the poll's SUCCESS payload. We accept either direct tokens
 *     (`access_token` ...) or an `authorization_code` that we then
 *     exchange at the discovery token endpoint with the PKCE verifier
 *     bound at mint.
 *   - whether `verificationUri` accepts a `user_code` query param for
 *     a pre-filled convenience URL (we do not emit one).
 */
export const OPENAI_DEVICE_AUTH_WIRE = {
  usercodeUrl: `${OPENAI_OAUTH_ISSUER}/api/accounts/deviceauth/usercode`,
  pollUrl: `${OPENAI_OAUTH_ISSUER}/api/accounts/deviceauth/token`,
  verificationUri: `${OPENAI_OAUTH_ISSUER}/deviceauth`,
  pendingErrorCode: 'deviceauth_authorization_pending',
} as const

/**
 * Loopback (authorization-code + PKCE) redirect shape. The shared
 * public client's registered redirect URI is fixed:
 * `http://localhost:1455/auth/callback`. The hostname label must be
 * `localhost` (that literal is what is registered), while we bind
 * 127.0.0.1; browsers that resolve `localhost` to ::1 first will
 * retry v4 per happy-eyeballs, matching how the Codex CLI itself
 * binds.
 */
export const OPENAI_LOOPBACK_REDIRECT = {
  port: 1455,
  path: '/auth/callback',
  urlHostname: 'localhost',
} as const

/**
 * Extra query params on the authorization URL. `originator` is how
 * OpenAI attributes shared-client traffic to a harness family; the
 * Codex CLI value is what the blessed third-party integrations send.
 */
export const OPENAI_AUTHORIZE_EXTRA_PARAMS = {
  originator: 'codex_cli_rs',
} as const

/**
 * Subset of the OpenAI discovery document we consume. The live doc
 * (2026-07-10) advertises `authorization_code` + `refresh_token`
 * grants, S256, and auth method "none" ... it does NOT advertise a
 * device grant (that surface lives outside the OIDC config, above).
 */
export const OpenAiDiscoveryDocSchema = z.object({
  issuer: z.url(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  grant_types_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
})

export type OpenAiDiscoveryDoc = z.infer<typeof OpenAiDiscoveryDocSchema>

/**
 * Fetch + validate the OpenAI discovery document. Fails loud at flow
 * start if the doc drops the authorization-code grant or S256, rather
 * than failing mid-exchange.
 */
export async function fetchOpenAiDiscovery(
  opts: {
    fetchImpl?: typeof fetch
    url?: string
  } = {},
): Promise<OpenAiDiscoveryDoc> {
  const url = opts.url ?? OPENAI_OAUTH_DISCOVERY_URL
  const fetchImpl = opts.fetchImpl ?? fetch
  let res
  try {
    res = await fetchImpl(url, { headers: { Accept: 'application/json' } })
  } catch (err) {
    throw new Error(
      `OpenAI OAuth discovery fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
  if (!res.ok) {
    throw new Error(`OpenAI OAuth discovery returned HTTP ${String(res.status)} for ${url}`)
  }
  const json = await res.json().catch(() => null)
  const parsed = OpenAiDiscoveryDocSchema.safeParse(json)
  if (!parsed.success) {
    throw new Error(
      `OpenAI OAuth discovery doc failed schema validation: ${JSON.stringify(parsed.error.issues)}`,
    )
  }
  const doc = parsed.data
  if (doc.grant_types_supported && !doc.grant_types_supported.includes('authorization_code')) {
    throw new Error(
      "OpenAI OAuth discovery does not advertise the 'authorization_code' grant; cannot proceed",
    )
  }
  if (
    doc.code_challenge_methods_supported &&
    !doc.code_challenge_methods_supported.includes('S256')
  ) {
    throw new Error(
      "OpenAI OAuth discovery does not advertise PKCE 'S256'; cannot proceed (public client requires S256)",
    )
  }
  return doc
}

/**
 * Build the loopback-flow provider config from a fetched discovery
 * doc. Caller-side glue for `runOAuthFlow` / `startOAuthFlowSession`
 * in public-client mode (no client_secret).
 */
export function openaiLoopbackProvider(doc: OpenAiDiscoveryDoc): OAuthProviderConfig {
  return {
    name: 'openai-oauth',
    authUrl: doc.authorization_endpoint,
    tokenUrl: doc.token_endpoint,
    defaultScopes: OPENAI_OAUTH_SCOPES,
    extraAuthParams: OPENAI_AUTHORIZE_EXTRA_PARAMS,
  }
}

/** Result of the device-code mint, plus the state each poll needs. */
export interface OpenAiDeviceFlowStart {
  readonly userCode: string
  readonly verificationUri: string
  readonly expiresAtMs: number
  readonly intervalSec: number
  readonly pollState: {
    readonly deviceAuthId: string
    readonly userCode: string
    readonly codeVerifier: string
  }
}

interface OpenAiUsercodeResponse {
  device_auth_id?: string
  user_code?: string
  /** Arrives as a string ("5") on the live surface. */
  interval?: string | number
  /** ISO 8601 timestamp. */
  expires_at?: string
}

/**
 * Mint a ChatGPT device-auth user code. Throws when the surface
 * rejects the mint ... the caller treats that as "device-code
 * unavailable for this account" and falls back to the loopback flow.
 */
export async function startOpenAiDeviceFlow(
  opts: {
    fetchImpl?: typeof fetch
    nowFn?: () => number
  } = {},
): Promise<OpenAiDeviceFlowStart> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.nowFn ?? (() => Date.now())
  const pkce = generatePkce()

  let res
  try {
    res = await fetchImpl(OPENAI_DEVICE_AUTH_WIRE.usercodeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: OPENAI_OAUTH_CLIENT_ID,
        scope: OPENAI_OAUTH_SCOPES.join(' '),
        code_challenge: pkce.challenge,
        code_challenge_method: pkce.method,
      }),
    })
  } catch (err) {
    throw new Error(
      `ChatGPT device-code mint failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(
      `ChatGPT device-code mint rejected: HTTP ${String(res.status)} ${text.slice(0, 300)}`,
    )
  }
  const json = (await res.json().catch(() => null)) as OpenAiUsercodeResponse | null
  if (!json?.device_auth_id || !json.user_code) {
    throw new Error('ChatGPT device-code mint response missing device_auth_id or user_code')
  }
  const intervalRaw = typeof json.interval === 'string' ? Number(json.interval) : json.interval
  const intervalSec = clampInterval(
    typeof intervalRaw === 'number' && Number.isFinite(intervalRaw) ? intervalRaw : undefined,
  )
  // `expires_at` is an ABSOLUTE server timestamp (unlike xAI's relative
  // expires_in), so a local clock running ahead of OpenAI's would make
  // the code look already-expired and kill the flow before the first
  // poll. Floor the local deadline at one minute of headroom; the
  // provider still terminates a truly-expired code via the poll error.
  const expiresAtParsed = json.expires_at ? Date.parse(json.expires_at) : NaN
  const expiresAtMs =
    Number.isNaN(expiresAtParsed) || expiresAtParsed < now() + 60_000
      ? now() + 900_000
      : expiresAtParsed
  return {
    userCode: json.user_code,
    verificationUri: OPENAI_DEVICE_AUTH_WIRE.verificationUri,
    expiresAtMs,
    intervalSec,
    pollState: {
      deviceAuthId: json.device_auth_id,
      userCode: json.user_code,
      codeVerifier: pkce.verifier,
    },
  }
}

/**
 * One poll of the ChatGPT device-auth token endpoint. Returns the
 * shared `DeviceTokenPollOutcome` vocabulary so the generic sign-in
 * drivers (CLI loop, HTTP per-poll route) treat both subscription
 * providers identically.
 *
 * Success handling covers both plausible payloads (direct tokens, or
 * an authorization code we exchange with the PKCE verifier) because
 * the success shape is the unverified half of the wire ... see
 * `OPENAI_DEVICE_AUTH_WIRE`.
 */
export async function pollOpenAiDeviceTokenOnce(
  pollState: OpenAiDeviceFlowStart['pollState'],
  opts: {
    fetchImpl?: typeof fetch
  } = {},
): Promise<DeviceTokenPollOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch
  let res
  try {
    res = await fetchImpl(OPENAI_DEVICE_AUTH_WIRE.pollUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        device_auth_id: pollState.deviceAuthId,
        user_code: pollState.userCode,
      }),
    })
  } catch (err) {
    return { status: 'transient', message: err instanceof Error ? err.message : String(err) }
  }

  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null

  // Pending arrives as HTTP 403 + a structured error envelope, not an
  // RFC 8628 `authorization_pending` ... normalize it here.
  const errObj =
    json && typeof json['error'] === 'object' && json['error'] !== null
      ? (json['error'] as Record<string, unknown>)
      : null
  const errCode = errObj && typeof errObj['code'] === 'string' ? errObj['code'] : null
  if (errCode === OPENAI_DEVICE_AUTH_WIRE.pendingErrorCode) return { status: 'pending' }

  if (res.ok && json) {
    // Success shape A: tokens directly on the poll response.
    if (typeof json['access_token'] === 'string' && json['access_token'].length > 0) {
      return { status: 'completed', tokens: json as unknown as OAuthTokenResponse }
    }
    // Success shape B: an authorization code to exchange (PKCE-bound
    // to the verifier we minted with).
    const code =
      typeof json['authorization_code'] === 'string'
        ? json['authorization_code']
        : typeof json['code'] === 'string'
          ? json['code']
          : null
    if (code) {
      return exchangeDeviceAuthorizationCode(code, pollState.codeVerifier, fetchImpl)
    }
  }

  // No structured error envelope + a server-side/throttling status is a
  // gateway blip, not a verdict on the sign-in: a brief outage must not
  // kill a flow the user already approved on their phone. Only a
  // structured provider error (or an unexplained 4xx) is terminal.
  if (errCode === null && (res.status >= 500 || res.status === 429 || json === null)) {
    return { status: 'transient', message: `HTTP ${String(res.status)} from device-auth poll` }
  }

  const message = errObj && typeof errObj['message'] === 'string' ? errObj['message'] : undefined
  return {
    status: 'failed',
    error: errCode ?? `http_${String(res.status)}`,
    ...(message ? { description: message } : {}),
  }
}

/**
 * Exchange a device-flow authorization code at the discovery token
 * endpoint (public client: no secret, PKCE verifier proves origin).
 */
async function exchangeDeviceAuthorizationCode(
  code: string,
  codeVerifier: string,
  fetchImpl: typeof fetch,
): Promise<DeviceTokenPollOutcome> {
  let doc
  try {
    doc = await fetchOpenAiDiscovery({ fetchImpl })
  } catch (err) {
    return { status: 'failed', error: 'discovery_failed', description: String(err) }
  }
  const body = new URLSearchParams()
  body.set('grant_type', 'authorization_code')
  body.set('code', code)
  body.set('client_id', OPENAI_OAUTH_CLIENT_ID)
  body.set('code_verifier', codeVerifier)
  let res
  try {
    res = await fetchImpl(doc.token_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    })
  } catch (err) {
    return { status: 'transient', message: err instanceof Error ? err.message : String(err) }
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (res.ok && json && typeof json['access_token'] === 'string' && json['access_token']) {
    return { status: 'completed', tokens: json as unknown as OAuthTokenResponse }
  }
  return {
    status: 'failed',
    error: 'device_code_exchange_failed',
    description: JSON.stringify(json).slice(0, 300),
  }
}

/**
 * Pull the ChatGPT account id out of the access-token JWT. The Codex
 * backend requires it as the `chatgpt-account-id` request header; it
 * lives in the token's `https://api.openai.com/auth` claim. Returns
 * null when the token is not a JWT or the claim is absent (the
 * inference adapter fails loud in that case).
 */
export function extractChatgptAccountId(accessToken: string): string | null {
  const claims = decodeJwtPayload(accessToken)
  if (!claims) return null
  const auth = claims['https://api.openai.com/auth']
  if (auth && typeof auth === 'object') {
    const id = (auth as Record<string, unknown>)['chatgpt_account_id']
    if (typeof id === 'string' && id.length > 0) return id
  }
  return null
}

/**
 * Access-token expiry from the JWT `exp` claim, in unix ms. Used when
 * the token response omits `expires_in`. Null when unreadable.
 */
export function accessTokenExpiryMs(accessToken: string): number | null {
  const claims = decodeJwtPayload(accessToken)
  const exp = claims?.['exp']
  if (typeof exp === 'number' && Number.isFinite(exp)) return exp * 1000
  return null
}

/** Decode a JWT payload without verifying the signature (metadata read only). */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  const payload = parts[1]
  if (parts.length !== 3 || !payload) return null
  try {
    const json = Buffer.from(payload, 'base64url').toString('utf-8')
    const parsed: unknown = JSON.parse(json)
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
    return null
  } catch {
    return null
  }
}
