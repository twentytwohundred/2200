/**
 * OAuth provider presets.
 *
 * Each entry declares the auth/token URLs + default scopes + extra
 * required query params. Client_id and client_secret come from env
 * vars at flow time, not from this file (so a public clone of 2200
 * does not ship credentials).
 *
 * Operators configure their own OAuth apps at each provider's console
 * and export the credentials as env vars before running
 * `2200 oauth <provider>`. The CLI surfaces the missing-env-var case
 * with a clear "register your OAuth app and export X / Y" message.
 */
import type { OAuthProviderConfig } from './types.js'

export const PROVIDERS: Readonly<Record<string, OAuthProviderConfig>> = {
  google: {
    name: 'google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revocationUrl: 'https://oauth2.googleapis.com/revoke',
    defaultScopes: ['openid', 'email', 'https://www.googleapis.com/auth/userinfo.profile'],
    // Google requires `access_type=offline` + `prompt=consent` to mint
    // a refresh token. Without these the response only carries an
    // access_token that lasts an hour.
    extraAuthParams: {
      access_type: 'offline',
      prompt: 'consent',
    },
  },
  github: {
    name: 'github',
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    defaultScopes: ['read:user', 'user:email'],
  },
  slack: {
    name: 'slack',
    authUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    defaultScopes: ['chat:write', 'channels:read'],
  },
  spotify: {
    name: 'spotify',
    authUrl: 'https://accounts.spotify.com/authorize',
    tokenUrl: 'https://accounts.spotify.com/api/token',
    defaultScopes: [
      'user-read-playback-state',
      'user-read-currently-playing',
      'user-modify-playback-state',
      'playlist-read-private',
      'playlist-modify-private',
      'playlist-modify-public',
      'user-library-read',
      'ugc-image-upload',
    ],
    scopeSeparator: ' ',
  },
}

export function knownProviders(): string[] {
  return Object.keys(PROVIDERS).sort()
}

export function findProvider(name: string): OAuthProviderConfig | undefined {
  return PROVIDERS[name]
}

/**
 * Resolve client_id + client_secret for a provider from env vars.
 * Convention: `2200_OAUTH_<PROVIDER>_CLIENT_ID` and
 * `2200_OAUTH_<PROVIDER>_CLIENT_SECRET` (uppercased).
 *
 * Returns null for either field when missing; the CLI surfaces the
 * specific missing var in its error message.
 */
export function readClientCredentials(providerName: string): {
  clientId: string | null
  clientSecret: string | null
  envVarHints: { id: string; secret: string }
} {
  const upper = providerName.toUpperCase()
  const idVar = `_2200_OAUTH_${upper}_CLIENT_ID`
  const secretVar = `_2200_OAUTH_${upper}_CLIENT_SECRET`
  return {
    clientId: process.env[idVar] ?? null,
    clientSecret: process.env[secretVar] ?? null,
    envVarHints: { id: idVar, secret: secretVar },
  }
}
