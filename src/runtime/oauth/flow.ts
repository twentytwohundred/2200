/**
 * OAuth flow runner (Epic 9 Phase B-2).
 *
 * Generic Authorization Code with PKCE flow. Provider configs select
 * the auth/token URLs + default scopes + extra params; the runner is
 * provider-agnostic.
 *
 * Steps:
 *   1. Read client_id + client_secret from env (or accept overrides).
 *   2. Generate PKCE pair + state nonce.
 *   3. Start the redirect server (free port on 127.0.0.1).
 *   4. Build the authorization URL.
 *   5. Open the user's browser (or print the URL for the user to
 *      open manually if no browser-launching mechanism is available).
 *   6. Wait for the callback (with timeout).
 *   7. Validate state.
 *   8. POST to the token endpoint with code + code_verifier.
 *   9. Return the parsed token response.
 *
 * The runner DOES NOT touch the credential vault. The CLI handles
 * vault writes after receiving the token response, so the flow runner
 * stays decoupled from per-Agent storage and is unit-testable
 * end-to-end with a mock fetch.
 */
import { generatePkce, generateState } from './pkce.js'
import { startRedirectServer, type RedirectResult } from './redirect-server.js'
import { OAuthError, type OAuthProviderConfig, type OAuthTokenResponse } from './types.js'

export interface RunFlowArgs {
  provider: OAuthProviderConfig
  clientId: string
  /**
   * Confidential-client secret. Omit (or pass '') for public clients
   * (OpenAI's shared Codex client): the token exchange then sends no
   * `client_secret` param and PKCE alone binds the request.
   */
  clientSecret?: string
  /** Scopes to request. Defaults to provider.defaultScopes. */
  scopes?: readonly string[]
  /** Optional override port (testing / fixed registered URIs). Default 0 = random. */
  port?: number
  /** Callback path override (fixed registered URIs). Default '/callback'. */
  redirectPath?: string
  /** Hostname label in the redirect_uri (e.g. 'localhost'). Default: bind host. */
  redirectUrlHostname?: string
  /** Optional timeout in ms. Default 5 min. */
  timeoutMs?: number
  /** Inject the browser-open hook (testing). Default uses node:child_process. */
  openBrowser?: (url: string) => void | Promise<void>
  /** Inject fetch (testing). */
  fetchImpl?: typeof fetch
  /** Inject the redirect server starter (testing). */
  redirectServer?: typeof startRedirectServer
  /** Callback for printing diagnostic lines (CLI uses console.log). */
  onLog?: (line: string) => void
  /** Optional AbortSignal for cooperative cancellation. */
  signal?: AbortSignal
}

/**
 * A started-but-not-finished loopback flow. `authorizationUrl` is
 * available immediately so a non-CLI caller (the daemon's
 * browser-driven sign-in route) can hand it to a UI instead of
 * opening a browser itself; `tokens` resolves after the callback +
 * token exchange complete.
 */
export interface OAuthFlowSession {
  readonly authorizationUrl: string
  readonly redirectUri: string
  /** Resolves with the token response; rejects with OAuthError. */
  readonly tokens: Promise<OAuthTokenResponse>
  /** Abort the flow + close the redirect server. Idempotent. */
  close: () => Promise<void>
}

export type StartFlowArgs = Omit<RunFlowArgs, 'openBrowser' | 'onLog'>

/**
 * Start the loopback flow: bind the redirect server, build the
 * authorization URL, and return both plus a promise for the eventual
 * token exchange. `runOAuthFlow` composes this with a browser opener;
 * the daemon's HTTP sign-in route consumes it directly.
 */
export async function startOAuthFlowSession(args: StartFlowArgs): Promise<OAuthFlowSession> {
  const fetchFn = args.fetchImpl ?? fetch
  const startServer = args.redirectServer ?? startRedirectServer
  const scopes = args.scopes ?? args.provider.defaultScopes
  const sep = args.provider.scopeSeparator ?? ' '

  const pkce = generatePkce()
  const state = generateState()

  const serverOpts: Parameters<typeof startServer>[0] = {
    port: args.port ?? 0,
  }
  if (args.redirectPath !== undefined) serverOpts.path = args.redirectPath
  if (args.redirectUrlHostname !== undefined) serverOpts.urlHostname = args.redirectUrlHostname
  if (args.timeoutMs !== undefined) serverOpts.timeoutMs = args.timeoutMs
  if (args.signal) serverOpts.signal = args.signal
  const server = await startServer(serverOpts)

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: args.clientId,
    redirect_uri: server.url,
    scope: scopes.join(sep),
    state,
    code_challenge: pkce.challenge,
    code_challenge_method: pkce.method,
  })
  if (args.provider.extraAuthParams) {
    for (const [k, v] of Object.entries(args.provider.extraAuthParams)) {
      params.set(k, v)
    }
  }
  const authorizationUrl = `${args.provider.authUrl}?${params.toString()}`

  const tokens = (async (): Promise<OAuthTokenResponse> => {
    try {
      const cb: RedirectResult = await server.result

      if (cb.state !== state) {
        throw new OAuthError('callback state did not match expected nonce', 'STATE_MISMATCH')
      }

      const tokenBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code: cb.code,
        redirect_uri: server.url,
        client_id: args.clientId,
        code_verifier: pkce.verifier,
      })
      // Public clients (no secret) omit the param entirely; sending an
      // empty client_secret makes some providers reject the exchange.
      if (args.clientSecret !== undefined && args.clientSecret !== '') {
        tokenBody.set('client_secret', args.clientSecret)
      }
      const res = await fetchFn(args.provider.tokenUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: tokenBody.toString(),
      })
      const text = await res.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new OAuthError(
          `token endpoint returned non-JSON response (status ${String(res.status)})`,
          'INVALID_RESPONSE',
        )
      }
      if (!res.ok) {
        const errCode =
          parsed && typeof parsed === 'object' && 'error' in parsed
            ? String(parsed.error)
            : `HTTP ${String(res.status)}`
        throw new OAuthError(`token exchange failed: ${errCode}`, 'TOKEN_EXCHANGE_FAILED')
      }
      return validateTokenResponse(parsed)
    } finally {
      await server.close()
    }
  })()

  return {
    authorizationUrl,
    redirectUri: server.url,
    tokens,
    close: () => server.close(),
  }
}

export async function runOAuthFlow(args: RunFlowArgs): Promise<OAuthTokenResponse> {
  const log = args.onLog ?? (() => undefined)

  const session = await startOAuthFlowSession(args)

  log(`Opening browser for ${args.provider.name} OAuth.`)
  log(`If a browser does not open, paste this URL manually:`)
  log(`  ${session.authorizationUrl}`)
  log(``)
  log(`Listening at ${session.redirectUri} for the callback ...`)

  const opener = args.openBrowser ?? defaultOpenBrowser
  try {
    await opener(session.authorizationUrl)
  } catch (err) {
    // Non-fatal: the user can paste the URL by hand.
    log(`(could not auto-open browser: ${err instanceof Error ? err.message : String(err)})`)
  }

  return session.tokens
}

function validateTokenResponse(value: unknown): OAuthTokenResponse {
  if (!value || typeof value !== 'object') {
    throw new OAuthError('token response was not an object', 'INVALID_RESPONSE')
  }
  const obj = value as Record<string, unknown>
  const access_token = obj['access_token']
  if (typeof access_token !== 'string' || access_token.length === 0) {
    throw new OAuthError('token response missing access_token', 'INVALID_RESPONSE')
  }
  const out: OAuthTokenResponse = { access_token }
  if (typeof obj['refresh_token'] === 'string') out.refresh_token = obj['refresh_token']
  if (typeof obj['expires_in'] === 'number') out.expires_in = obj['expires_in']
  if (typeof obj['scope'] === 'string') out.scope = obj['scope']
  if (typeof obj['token_type'] === 'string') out.token_type = obj['token_type']
  if (typeof obj['id_token'] === 'string') out.id_token = obj['id_token']
  const known = new Set([
    'access_token',
    'refresh_token',
    'expires_in',
    'scope',
    'token_type',
    'id_token',
  ])
  const extras: Record<string, unknown> = {}
  let hasExtras = false
  for (const [k, v] of Object.entries(obj)) {
    if (!known.has(k)) {
      extras[k] = v
      hasExtras = true
    }
  }
  if (hasExtras) out.extras = extras
  return out
}

async function defaultOpenBrowser(url: string): Promise<void> {
  const { spawn } = await import('node:child_process')
  const platform = process.platform
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open'
  const args = platform === 'win32' ? ['', url] : [url]
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', reject)
    child.on('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
