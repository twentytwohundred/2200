/**
 * xAI / Grok OAuth provider configuration.
 *
 * xAI ships an OpenID-Connect-compliant authorization server at
 * `https://auth.x.ai`. The OIDC discovery document
 * (`/.well-known/openid-configuration`) is the authoritative source
 * for endpoint URLs; we fetch it lazily at flow time so we do not
 * drift if xAI relocates a route.
 *
 * The shared public client id below is the same one OpenClaw,
 * Codex, and Hermes use for the "Grok Build" / "grok-cli" CLI flow.
 * It is a public client (no client_secret); PKCE S256 + device code
 * binding is what proves the request originates from this runtime.
 *
 * Scopes:
 *   openid           ... required by OIDC servers; mints id_token
 *   offline_access   ... mints a refresh_token (required for our
 *                        background refresh service)
 *   grok-cli:access  ... CLI/headless flow scope (vs. browser-only)
 *   api:access       ... lets the resulting bearer hit api.x.ai/v1
 *
 * See wiki/decisions/2026-05-21-xai-grok-oauth.md.
 */
import { z } from 'zod'
import type { DeviceFlowProviderConfig } from './device-flow.js'

/** xAI's OpenID Connect issuer. */
export const XAI_OAUTH_ISSUER = 'https://auth.x.ai'

/** Discovery doc URL. Fetched lazily on flow entry. */
export const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`

/**
 * Public CLI client. This is the shared "grok-cli" public client
 * that xAI publishes for headless integrators. No client_secret.
 * Matches Hermes / OpenClaw / Codex.
 */
export const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'

/** Scopes 2200 requests. */
export const XAI_OAUTH_SCOPES = [
  'openid',
  'offline_access',
  'grok-cli:access',
  'api:access',
] as const

/**
 * Refresh skew: trigger refresh when the access token has this many
 * seconds (or fewer) left to live. 120s matches Hermes; gives the
 * refresh request room to round-trip even on a slow link.
 */
export const XAI_OAUTH_REFRESH_SKEW_SECONDS = 120

/**
 * Subset of the OIDC discovery document we actually consume. Other
 * fields are tolerated but ignored.
 */
export const DiscoveryDocSchema = z.object({
  issuer: z.url(),
  device_authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  revocation_endpoint: z.url().optional(),
  grant_types_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
})

export type DiscoveryDoc = z.infer<typeof DiscoveryDocSchema>

/**
 * Fetch + validate the xAI OIDC discovery document. Caller passes a
 * fetch implementation (test seam) and an optional override URL.
 *
 * Throws if the document is missing required endpoints or does not
 * advertise the device_code grant + S256 code challenge. The check is
 * defensive: if xAI ever drops one of these, we fail loud at flow
 * start rather than crash mid-poll.
 */
export async function fetchXaiDiscovery(
  opts: {
    fetchImpl?: typeof fetch
    url?: string
  } = {},
): Promise<DiscoveryDoc> {
  const url = opts.url ?? XAI_OAUTH_DISCOVERY_URL
  const fetchImpl = opts.fetchImpl ?? fetch
  let res
  try {
    res = await fetchImpl(url, { headers: { Accept: 'application/json' } })
  } catch (err) {
    throw new Error(
      `xAI OIDC discovery fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
  if (!res.ok) {
    throw new Error(`xAI OIDC discovery returned HTTP ${String(res.status)} for ${url}`)
  }
  const json = await res.json().catch(() => null)
  const parsed = DiscoveryDocSchema.safeParse(json)
  if (!parsed.success) {
    throw new Error(
      `xAI OIDC discovery doc failed schema validation: ${JSON.stringify(parsed.error.issues)}`,
    )
  }
  const doc = parsed.data
  if (
    doc.grant_types_supported &&
    !doc.grant_types_supported.includes('urn:ietf:params:oauth:grant-type:device_code')
  ) {
    throw new Error(
      "xAI OIDC discovery does not advertise the 'device_code' grant; cannot proceed with the device flow",
    )
  }
  if (
    doc.code_challenge_methods_supported &&
    !doc.code_challenge_methods_supported.includes('S256')
  ) {
    throw new Error(
      "xAI OIDC discovery does not advertise PKCE 'S256'; cannot proceed (xAI requires S256)",
    )
  }
  return doc
}

/**
 * Build the device-flow provider config from a fetched discovery doc.
 * Caller-side glue between `fetchXaiDiscovery` and the device-flow
 * building blocks in `device-flow.ts`.
 */
export function xaiDeviceFlowProvider(doc: DiscoveryDoc): DeviceFlowProviderConfig {
  return {
    name: 'xai-oauth',
    deviceAuthorizationUrl: doc.device_authorization_endpoint,
    tokenUrl: doc.token_endpoint,
    ...(doc.revocation_endpoint ? { revocationUrl: doc.revocation_endpoint } : {}),
    clientId: XAI_OAUTH_CLIENT_ID,
    scopes: XAI_OAUTH_SCOPES,
  }
}
