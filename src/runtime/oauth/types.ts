/**
 * OAuth types (Epic 9 Phase B-2).
 *
 * Authorization Code with PKCE per RFC 7636. The runtime acts as a
 * native client: no client_secret on the wire, the PKCE code_verifier
 * binds the redirect to the original request.
 *
 * Flow:
 *   1. Generate code_verifier + code_challenge (PKCE).
 *   2. Generate a state nonce.
 *   3. Bind a localhost server to a free port; expose /callback.
 *   4. Open the browser at <provider>.authUrl?... including
 *      redirect_uri=http://127.0.0.1:<port>/callback,
 *      code_challenge=<S256(verifier)>, state=<nonce>, scope=<list>.
 *   5. User approves at the provider. Provider redirects to the
 *      callback with code + state.
 *   6. Server validates state, POSTs to <provider>.tokenUrl with
 *      code + code_verifier, gets back access_token + (optionally)
 *      refresh_token + expires_in.
 *   7. Server stores the tokens in the calling Agent's credential
 *      vault, closes itself.
 *
 * Errors at any step abort cleanly (server stops, no partial credit).
 */

export interface OAuthProviderConfig {
  /** Provider key, e.g. "google", "github". Slug shape. */
  readonly name: string
  /** Authorization endpoint (browser navigation target). */
  readonly authUrl: string
  /** Token endpoint (server-to-server POST). */
  readonly tokenUrl: string
  /** Optional revocation endpoint. Used by `2200 oauth revoke`. */
  readonly revocationUrl?: string
  /** Optional scope-separator override (default ' '). */
  readonly scopeSeparator?: string
  /** Default scopes if the caller does not specify. */
  readonly defaultScopes: readonly string[]
  /** Extra fixed query params on the auth URL (e.g. access_type=offline). */
  readonly extraAuthParams?: Readonly<Record<string, string>>
}

/**
 * The shape of a successful token-exchange response. Provider-specific
 * fields (e.g. id_token from Google) are preserved in `extras` so the
 * vault metadata round-trips them.
 */
export interface OAuthTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  token_type?: string
  id_token?: string
  /** Extra provider-specific fields. */
  extras?: Record<string, unknown>
}

/**
 * Internal state held during a single oauth flow invocation. NEVER log
 * the verifier or the state nonce; both are bearer secrets between
 * the runtime and the provider for the duration of the flow.
 */
export interface PkcePair {
  /** 43-128 char URL-safe random string. */
  verifier: string
  /** base64url(sha256(verifier)). */
  challenge: string
  /** "S256" (we don't ship "plain"). */
  method: 'S256'
}

export class OAuthError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'PROVIDER_MISSING_CLIENT_ID'
      | 'PROVIDER_MISSING_CLIENT_SECRET'
      | 'BROWSER_OPEN_FAILED'
      | 'CALLBACK_TIMEOUT'
      | 'STATE_MISMATCH'
      | 'PROVIDER_DENIED'
      | 'TOKEN_EXCHANGE_FAILED'
      | 'INVALID_RESPONSE',
  ) {
    super(message)
    this.name = 'OAuthError'
  }
}
