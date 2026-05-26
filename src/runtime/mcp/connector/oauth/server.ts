/**
 * OAuth Authorization Server endpoints (Phase 2 PR-A1).
 *
 * Pre-authorize-at-registration model (locked 2026-05-23): the
 * operator registers clients via CLI / Settings at the trusted
 * loopback surface. `/authorize` over the public tunnel does NOT
 * render any operator-facing UI — it validates the registered
 * client + PKCE + redirect_uri, mints an authorization code, and
 * redirects back. Zero operator presence required at runtime.
 *
 * Endpoints:
 *   GET  /oauth/authorize    -- code grant (PKCE S256 mandatory)
 *   POST /oauth/token        -- code exchange OR refresh-token rotation
 *   POST /oauth/revoke       -- revoke an access or refresh token
 *   GET  /.well-known/oauth-authorization-server
 *
 * Refresh-token reuse detection: refresh tokens carry a chain_id
 * and a `rotated` flag. Successful refresh marks the consumed token
 * rotated and issues a fresh refresh in the same chain. Any later
 * attempt to use a `rotated` token reuses the chain → AS revokes
 * the entire chain + emits `connector.oauth_refresh_reuse`. RFC
 * 6749 best-practice.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ConnectorAuditEmitter } from '../audit.js'
import { verifyPkceS256, isWellFormedChallenge } from './pkce.js'
import { clientExists, readClient, recordAuthorize, verifyClientSecret } from './client-store.js'
import { AuthorizationCodeStore } from './codes.js'
import {
  deleteAccessToken,
  deleteRefreshToken,
  isAccessTokenShape,
  isRefreshTokenShape,
  issueAccessToken,
  issueRefreshToken,
  readAccessToken,
  readRefreshToken,
  revokeChain,
  saveRefreshToken,
} from './token-store.js'

const SUPPORTED_RESPONSE_TYPES = ['code']
const SUPPORTED_GRANT_TYPES = ['authorization_code', 'refresh_token']
const SUPPORTED_CODE_CHALLENGE_METHODS = ['S256']
const SUPPORTED_TOKEN_ENDPOINT_AUTH = ['none', 'client_secret_post']
const SUPPORTED_SCOPE = 'connector:full'

export interface OAuthServerDeps {
  home: string
  audit: ConnectorAuditEmitter
  /** The public-facing base URL the operator will paste into grok.com/connectors (e.g., https://abc.ngrok-free.app). Discovered from the listener at boot. */
  issuerBaseUrl: () => string
  /** Injected for tests; defaults to a process-local instance. */
  codes?: AuthorizationCodeStore
}

/**
 * Mount the OAuth AS endpoints on the supplied Fastify instance.
 * Returns the codes store so the supervisor can dispose it on
 * listener close.
 */
export function mountOAuthServer(
  fastify: FastifyInstance,
  deps: OAuthServerDeps,
): { codes: AuthorizationCodeStore } {
  const codes = deps.codes ?? new AuthorizationCodeStore()
  codes.startGc()

  fastify.get('/.well-known/oauth-authorization-server', () => ({
    issuer: deps.issuerBaseUrl(),
    authorization_endpoint: `${deps.issuerBaseUrl()}/oauth/authorize`,
    token_endpoint: `${deps.issuerBaseUrl()}/oauth/token`,
    revocation_endpoint: `${deps.issuerBaseUrl()}/oauth/revoke`,
    response_types_supported: SUPPORTED_RESPONSE_TYPES,
    grant_types_supported: SUPPORTED_GRANT_TYPES,
    code_challenge_methods_supported: SUPPORTED_CODE_CHALLENGE_METHODS,
    token_endpoint_auth_methods_supported: SUPPORTED_TOKEN_ENDPOINT_AUTH,
    scopes_supported: [SUPPORTED_SCOPE],
  }))

  // RFC 9728 protected-resource metadata. grok-connectors-manager
  // probes this on every connect; we 401'd it in PR-A1 (defaulted by
  // the bearer preHandler). Publishing the metadata is cheap spec
  // compliance and unblocks clients that hard-require it. Also
  // public — same posture as the AS metadata; the document itself
  // contains no secrets.
  fastify.get('/.well-known/oauth-protected-resource', () => ({
    resource: `${deps.issuerBaseUrl()}/mcp`,
    authorization_servers: [deps.issuerBaseUrl()],
    bearer_methods_supported: ['header'],
    scopes_supported: [SUPPORTED_SCOPE],
  }))

  fastify.get<{
    Querystring: {
      response_type?: string
      client_id?: string
      redirect_uri?: string
      scope?: string
      state?: string
      code_challenge?: string
      code_challenge_method?: string
    }
  }>('/oauth/authorize', async (req, reply) => {
    await handleAuthorize(req, reply, deps, codes)
  })

  fastify.post<{ Body: Record<string, unknown> | string | undefined }>(
    '/oauth/token',
    async (req, reply) => {
      await handleToken(req, reply, deps, codes)
    },
  )

  fastify.post<{ Body: Record<string, unknown> | string | undefined }>(
    '/oauth/revoke',
    async (req, reply) => {
      await handleRevoke(req, reply, deps)
    },
  )

  return { codes }
}

// --------------------------------------------------------------------
// /oauth/authorize
// --------------------------------------------------------------------

async function handleAuthorize(
  req: FastifyRequest<{
    Querystring: {
      response_type?: string
      client_id?: string
      redirect_uri?: string
      scope?: string
      state?: string
      code_challenge?: string
      code_challenge_method?: string
    }
  }>,
  reply: FastifyReply,
  deps: OAuthServerDeps,
  codes: AuthorizationCodeStore,
): Promise<void> {
  const q = req.query
  const clientId = typeof q.client_id === 'string' ? q.client_id : null
  const redirectUri = typeof q.redirect_uri === 'string' ? q.redirect_uri : null
  const responseType = typeof q.response_type === 'string' ? q.response_type : null
  const scope = typeof q.scope === 'string' ? q.scope : SUPPORTED_SCOPE
  const state = typeof q.state === 'string' ? q.state : null
  const codeChallenge = typeof q.code_challenge === 'string' ? q.code_challenge : null
  const codeChallengeMethod =
    typeof q.code_challenge_method === 'string' ? q.code_challenge_method : null

  // Validate response_type early; this is a server-config issue
  // rather than a client-config one. Return a 400 with a JSON body
  // because we don't have a verified redirect_uri yet.
  if (responseType !== 'code') {
    await deps.audit
      .emitOauthAuthorizeRejected({ clientId, reason: 'unsupported_response_type' })
      .catch(() => undefined)
    await reply
      .code(400)
      .header('content-type', 'application/json')
      .send({
        error: 'unsupported_response_type',
        error_description: `only response_type=code is supported (got "${String(responseType)}")`,
      })
    return
  }

  if (clientId === null) {
    await deps.audit
      .emitOauthAuthorizeRejected({ clientId: null, reason: 'unknown_client' })
      .catch(() => undefined)
    await reply
      .code(400)
      .send({ error: 'invalid_request', error_description: 'client_id is required' })
    return
  }

  const client = await readClient(deps.home, clientId)
  if (client === null) {
    await deps.audit
      .emitOauthAuthorizeRejected({ clientId, reason: 'unknown_client' })
      .catch(() => undefined)
    await reply.code(400).send({ error: 'invalid_client', error_description: 'unknown client_id' })
    return
  }
  if (client.revoked_at !== null) {
    await deps.audit
      .emitOauthAuthorizeRejected({ clientId, reason: 'client_revoked' })
      .catch(() => undefined)
    await reply
      .code(400)
      .send({ error: 'invalid_client', error_description: 'client has been revoked' })
    return
  }
  if (redirectUri === null || !client.redirect_uris.includes(redirectUri)) {
    await deps.audit
      .emitOauthAuthorizeRejected({ clientId, reason: 'redirect_uri_mismatch' })
      .catch(() => undefined)
    // RFC 6749 §4.1.2.1: when redirect_uri is invalid, do NOT redirect
    // (that would be the open-redirector hazard); return 400 instead.
    await reply.code(400).send({
      error: 'invalid_request',
      error_description: 'redirect_uri does not match any registered URI for this client',
    })
    return
  }

  if (codeChallenge === null || !isWellFormedChallenge(codeChallenge)) {
    await respondErrorToRedirect(
      reply,
      redirectUri,
      state,
      'invalid_request',
      'PKCE code_challenge is required (43-char base64url SHA-256 digest)',
    )
    await deps.audit
      .emitOauthAuthorizeRejected({ clientId, reason: 'missing_pkce' })
      .catch(() => undefined)
    return
  }
  if (codeChallengeMethod !== 'S256') {
    await respondErrorToRedirect(
      reply,
      redirectUri,
      state,
      'invalid_request',
      'only code_challenge_method=S256 is supported',
    )
    await deps.audit
      .emitOauthAuthorizeRejected({ clientId, reason: 'unsupported_pkce_method' })
      .catch(() => undefined)
    return
  }

  const requestedScopes = scope.split(/\s+/).filter((s) => s.length > 0)
  for (const s of requestedScopes) {
    if (!client.scopes_allowed.includes(s)) {
      await respondErrorToRedirect(
        reply,
        redirectUri,
        state,
        'invalid_scope',
        `scope "${s}" is not allowed for this client`,
      )
      await deps.audit
        .emitOauthAuthorizeRejected({ clientId, reason: 'bad_scope' })
        .catch(() => undefined)
      return
    }
  }

  // Issue authorization code.
  const code = codes.issue({
    clientId,
    redirectUri,
    scopes: requestedScopes,
    codeChallenge,
  })

  await recordAuthorize(deps.home, clientId, new Date()).catch(() => undefined)
  await deps.audit
    .emitOauthAuthorizeSucceeded({ clientId, redirectUri, scopes: requestedScopes })
    .catch(() => undefined)

  const redirectTo = new URL(redirectUri)
  redirectTo.searchParams.set('code', code)
  if (state !== null) redirectTo.searchParams.set('state', state)
  await reply.code(302).header('location', redirectTo.toString()).send()
}

async function respondErrorToRedirect(
  reply: FastifyReply,
  redirectUri: string,
  state: string | null,
  error: string,
  description: string,
): Promise<void> {
  const r = new URL(redirectUri)
  r.searchParams.set('error', error)
  r.searchParams.set('error_description', description)
  if (state !== null) r.searchParams.set('state', state)
  await reply.code(302).header('location', r.toString()).send()
}

// --------------------------------------------------------------------
// /oauth/token
// --------------------------------------------------------------------

interface TokenRequestBody {
  grant_type?: string
  code?: string
  redirect_uri?: string
  client_id?: string
  client_secret?: string
  code_verifier?: string
  refresh_token?: string
  scope?: string
}

async function handleToken(
  req: FastifyRequest<{ Body: Record<string, unknown> | string | undefined }>,
  reply: FastifyReply,
  deps: OAuthServerDeps,
  codes: AuthorizationCodeStore,
): Promise<void> {
  const body = parseTokenBody(req)
  const grantType = typeof body.grant_type === 'string' ? body.grant_type : null
  if (grantType === null) {
    await reply
      .code(400)
      .send({ error: 'invalid_request', error_description: 'grant_type is required' })
    return
  }
  if (!SUPPORTED_GRANT_TYPES.includes(grantType)) {
    await reply.code(400).send({
      error: 'unsupported_grant_type',
      error_description: `grant_type "${grantType}" is not supported`,
    })
    return
  }
  if (grantType === 'authorization_code') {
    await handleAuthorizationCodeGrant(body, reply, deps, codes)
    return
  }
  await handleRefreshTokenGrant(body, reply, deps)
}

async function handleAuthorizationCodeGrant(
  body: TokenRequestBody,
  reply: FastifyReply,
  deps: OAuthServerDeps,
  codes: AuthorizationCodeStore,
): Promise<void> {
  const code = typeof body.code === 'string' ? body.code : null
  const clientId = typeof body.client_id === 'string' ? body.client_id : null
  const redirectUri = typeof body.redirect_uri === 'string' ? body.redirect_uri : null
  const codeVerifier = typeof body.code_verifier === 'string' ? body.code_verifier : null
  const clientSecret = typeof body.client_secret === 'string' ? body.client_secret : null

  if (code === null || clientId === null || redirectUri === null || codeVerifier === null) {
    await reply.code(400).send({
      error: 'invalid_request',
      error_description: 'code, client_id, redirect_uri, and code_verifier are all required',
    })
    return
  }

  const codeRecord = codes.consume(code)
  if (codeRecord === null) {
    await reply
      .code(400)
      .send({ error: 'invalid_grant', error_description: 'unknown or expired authorization code' })
    return
  }
  if (codeRecord.client_id !== clientId) {
    await reply
      .code(400)
      .send({ error: 'invalid_grant', error_description: 'code does not belong to this client' })
    return
  }
  if (codeRecord.redirect_uri !== redirectUri) {
    await reply
      .code(400)
      .send({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' })
    return
  }
  if (!verifyPkceS256(codeVerifier, codeRecord.code_challenge)) {
    await reply
      .code(400)
      .send({ error: 'invalid_grant', error_description: 'PKCE verifier does not match challenge' })
    return
  }

  const client = await readClient(deps.home, clientId)
  if (client === null) {
    await reply
      .code(400)
      .send({ error: 'invalid_client', error_description: 'client no longer exists' })
    return
  }
  if (client.revoked_at !== null) {
    await reply
      .code(400)
      .send({ error: 'invalid_client', error_description: 'client has been revoked' })
    return
  }
  if (client.client_secret_hash !== null) {
    if (clientSecret === null) {
      await reply.code(401).send({
        error: 'invalid_client',
        error_description: 'this client requires a client_secret',
      })
      return
    }
    if (!(await verifyClientSecret(clientSecret, client.client_secret_hash))) {
      await reply
        .code(401)
        .send({ error: 'invalid_client', error_description: 'client_secret does not match' })
      return
    }
  }

  // Issue access + refresh tokens. Fresh refresh chain.
  const { token: accessToken, record: accessRecord } = await issueAccessToken({
    home: deps.home,
    clientId,
    scopes: codeRecord.scopes,
  })
  const { token: refreshToken, record: refreshRecord } = await issueRefreshToken({
    home: deps.home,
    clientId,
    scopes: codeRecord.scopes,
  })
  await deps.audit
    .emitOauthTokenIssued({
      clientId,
      scopes: codeRecord.scopes,
      grantType: 'authorization_code',
      rotated: false,
    })
    .catch(() => undefined)

  await reply.code(200).send({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: Math.floor((Date.parse(accessRecord.expires_at) - Date.now()) / 1000),
    refresh_token: refreshToken,
    refresh_token_expires_in: Math.floor(
      (Date.parse(refreshRecord.expires_at) - Date.now()) / 1000,
    ),
    scope: codeRecord.scopes.join(' '),
  })
}

async function handleRefreshTokenGrant(
  body: TokenRequestBody,
  reply: FastifyReply,
  deps: OAuthServerDeps,
): Promise<void> {
  const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : null
  const clientId = typeof body.client_id === 'string' ? body.client_id : null
  const clientSecret = typeof body.client_secret === 'string' ? body.client_secret : null
  if (refreshToken === null || clientId === null) {
    await reply.code(400).send({
      error: 'invalid_request',
      error_description: 'refresh_token and client_id are required',
    })
    return
  }

  const existing = await readRefreshToken(deps.home, refreshToken)
  if (existing === null) {
    await reply
      .code(400)
      .send({ error: 'invalid_grant', error_description: 'unknown or expired refresh_token' })
    return
  }
  if (existing.client_id !== clientId) {
    await reply.code(400).send({
      error: 'invalid_grant',
      error_description: 'refresh_token does not belong to this client',
    })
    return
  }
  if (Date.parse(existing.expires_at) <= Date.now()) {
    await deleteRefreshToken(deps.home, refreshToken).catch(() => undefined)
    await reply
      .code(400)
      .send({ error: 'invalid_grant', error_description: 'refresh_token expired' })
    return
  }

  // Reuse detection. If this refresh has already rotated, the chain
  // is compromised — revoke every refresh in the chain and reject.
  if (existing.rotated) {
    const { removed } = await revokeChain(deps.home, existing.chain_id)
    await deps.audit
      .emitOauthRefreshReuse({
        clientId,
        chainId: existing.chain_id,
        removedRefresh: removed,
      })
      .catch(() => undefined)
    await reply.code(400).send({
      error: 'invalid_grant',
      error_description: 'refresh_token reuse detected; chain revoked',
    })
    return
  }

  const client = await readClient(deps.home, clientId)
  if (client?.revoked_at != null || client === null) {
    await reply
      .code(400)
      .send({ error: 'invalid_client', error_description: 'client revoked or unknown' })
    return
  }
  if (client.client_secret_hash !== null) {
    if (clientSecret === null) {
      await reply.code(401).send({
        error: 'invalid_client',
        error_description: 'this client requires a client_secret',
      })
      return
    }
    if (!(await verifyClientSecret(clientSecret, client.client_secret_hash))) {
      await reply
        .code(401)
        .send({ error: 'invalid_client', error_description: 'client_secret does not match' })
      return
    }
  }

  // Mark the consumed refresh as rotated; issue a fresh one in the
  // same chain. Subsequent re-use of the now-rotated token triggers
  // chain revocation above.
  await saveRefreshToken(deps.home, { ...existing, rotated: true })
  const { token: newAccessToken, record: accessRecord } = await issueAccessToken({
    home: deps.home,
    clientId,
    scopes: existing.scopes,
  })
  const { token: newRefreshToken, record: newRefreshRecord } = await issueRefreshToken({
    home: deps.home,
    clientId,
    scopes: existing.scopes,
    chainId: existing.chain_id,
  })

  await deps.audit
    .emitOauthTokenIssued({
      clientId,
      scopes: existing.scopes,
      grantType: 'refresh_token',
      rotated: true,
    })
    .catch(() => undefined)

  await reply.code(200).send({
    access_token: newAccessToken,
    token_type: 'Bearer',
    expires_in: Math.floor((Date.parse(accessRecord.expires_at) - Date.now()) / 1000),
    refresh_token: newRefreshToken,
    refresh_token_expires_in: Math.floor(
      (Date.parse(newRefreshRecord.expires_at) - Date.now()) / 1000,
    ),
    scope: existing.scopes.join(' '),
  })
}

// --------------------------------------------------------------------
// /oauth/revoke
// --------------------------------------------------------------------

async function handleRevoke(
  req: FastifyRequest<{ Body: Record<string, unknown> | string | undefined }>,
  reply: FastifyReply,
  deps: OAuthServerDeps,
): Promise<void> {
  const body = parseTokenBody(req)
  const token = typeof body.refresh_token === 'string' ? body.refresh_token : null
  if (token === null) {
    await reply.code(400).send({ error: 'invalid_request' })
    return
  }
  if (isAccessTokenShape(token)) {
    await deleteAccessToken(deps.home, token).catch(() => undefined)
  } else if (isRefreshTokenShape(token)) {
    await deleteRefreshToken(deps.home, token).catch(() => undefined)
  }
  // Per RFC 7009, return 200 even on unknown tokens.
  await reply.code(200).send({})
}

// --------------------------------------------------------------------
// Body parser helper
// --------------------------------------------------------------------

function parseTokenBody(
  req: FastifyRequest<{ Body: Record<string, unknown> | string | undefined }>,
): TokenRequestBody {
  // grok.com sends form-encoded; Fastify v5's default parsers handle
  // JSON natively but form-urlencoded only with @fastify/formbody. We
  // accept BOTH shapes: if the body parsed to an object, use it;
  // otherwise the raw body is a urlencoded string we parse ourselves.
  const raw = req.body
  if (typeof raw === 'object') {
    return raw
  }
  if (typeof raw === 'string') {
    const out: Record<string, string> = {}
    for (const pair of raw.split('&')) {
      const eq = pair.indexOf('=')
      if (eq < 0) continue
      const k = decodeURIComponent(pair.slice(0, eq))
      const v = decodeURIComponent(pair.slice(eq + 1))
      out[k] = v
    }
    return out
  }
  return {}
}

/**
 * Verify a bearer presented at `/mcp`. Returns the access-token
 * record on success; null on missing / expired / unknown. The
 * listener uses this to decide whether the bearer is an OAuth
 * token; if so, this function authorizes the request, if not, the
 * listener falls through to the static-bearer check.
 */
export async function verifyOAuthBearer(
  home: string,
  token: string,
): Promise<
  | { ok: true; clientId: string; scopes: string[]; expiresAt: string }
  | { ok: false; reason: 'unknown' | 'expired' }
> {
  if (!isAccessTokenShape(token)) return { ok: false, reason: 'unknown' }
  const record = await readAccessToken(home, token)
  if (record === null) return { ok: false, reason: 'unknown' }
  if (Date.parse(record.expires_at) <= Date.now()) return { ok: false, reason: 'expired' }
  const client = await readClient(home, record.client_id)
  if (client?.revoked_at != null || client === null) return { ok: false, reason: 'unknown' }
  // Sanity: client must exist + not be revoked. (Defense-in-depth: a
  // revoked client's tokens should have been deleted via
  // `revokeClientTokens`, but the access-token check guards against
  // a race where the access token outlives the revoke.)
  if (!(await clientExists(home, record.client_id))) {
    return { ok: false, reason: 'unknown' }
  }
  return {
    ok: true,
    clientId: record.client_id,
    scopes: record.scopes,
    expiresAt: record.expires_at,
  }
}
