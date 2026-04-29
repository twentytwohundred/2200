/**
 * OAuth token refresh (Epic 9 Phase B-3).
 *
 * Pure function that exchanges a refresh_token for a fresh access
 * token (and optionally a rotated refresh_token) at the provider's
 * token endpoint. Decoupled from the vault and from any background
 * loop so it stays unit-testable with a mock fetch.
 *
 * Per RFC 6749 §6, the refresh-token grant POSTs to the token
 * endpoint with `grant_type=refresh_token`. Some providers (Slack,
 * GitHub Apps) issue a NEW refresh_token in the response and
 * invalidate the old one ("rotation"); some (Google) return the same
 * one indefinitely. Callers MUST persist the response refresh_token
 * if present; otherwise rotation breaks future refreshes.
 */
import { OAuthError, type OAuthProviderConfig, type OAuthTokenResponse } from './types.js'

export interface RefreshArgs {
  provider: OAuthProviderConfig
  refreshToken: string
  clientId: string
  clientSecret: string
  /** Inject fetch (testing). */
  fetchImpl?: typeof fetch
  /** Optional scope override. Most providers ignore this on refresh. */
  scopes?: readonly string[]
}

export async function refreshAccessToken(args: RefreshArgs): Promise<OAuthTokenResponse> {
  const fetchFn = args.fetchImpl ?? fetch
  const sep = args.provider.scopeSeparator ?? ' '

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: args.refreshToken,
    client_id: args.clientId,
    client_secret: args.clientSecret,
  })
  if (args.scopes && args.scopes.length > 0) {
    body.set('scope', args.scopes.join(sep))
  }

  const res = await fetchFn(args.provider.tokenUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  })
  const text = await res.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new OAuthError(
      `refresh response was not JSON (status ${String(res.status)})`,
      'INVALID_RESPONSE',
    )
  }
  if (!res.ok) {
    const errCode =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String(parsed.error)
        : `HTTP ${String(res.status)}`
    throw new OAuthError(`refresh failed: ${errCode}`, 'TOKEN_EXCHANGE_FAILED')
  }
  return validateTokenResponse(parsed)
}

function validateTokenResponse(value: unknown): OAuthTokenResponse {
  if (!value || typeof value !== 'object') {
    throw new OAuthError('refresh response was not an object', 'INVALID_RESPONSE')
  }
  const obj = value as Record<string, unknown>
  const access_token = obj['access_token']
  if (typeof access_token !== 'string' || access_token.length === 0) {
    throw new OAuthError('refresh response missing access_token', 'INVALID_RESPONSE')
  }
  const out: OAuthTokenResponse = { access_token }
  if (typeof obj['refresh_token'] === 'string') out.refresh_token = obj['refresh_token']
  if (typeof obj['expires_in'] === 'number') out.expires_in = obj['expires_in']
  if (typeof obj['scope'] === 'string') out.scope = obj['scope']
  if (typeof obj['token_type'] === 'string') out.token_type = obj['token_type']
  if (typeof obj['id_token'] === 'string') out.id_token = obj['id_token']
  return out
}
