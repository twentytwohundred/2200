/**
 * Spotify SDK client (per-call construction, vault-resolved tokens).
 *
 * Unlike the Discord client which holds a long-lived REST session, the
 * Spotify client is constructed per call: each tool execution reads
 * the calling Agent's vault for the Spotify access token, hands it to
 * `SpotifyApi.withAccessToken`, and discards the SDK instance after
 * the call. Reasoning:
 *   1. The supervisor's TokenRefreshService rewrites the vault entry
 *      when the access token is close to expiry. A long-lived SDK
 *      instance would hold a stale token across the rotation.
 *   2. Multiple Agents may share the same Spotify-authorized user
 *      (Doug authorized once for Jodin); each Agent reads from its own
 *      vault, but the underlying user is the same.
 *
 * The SpotifyApi constructor is cheap (no network); this is fine.
 *
 * The credential name in the vault is `spotify` by default. The CLI
 * login command (`2200 oauth login spotify <agent> --name spotify`)
 * stores the access token under `spotify` and the refresh token under
 * `spotify-refresh`. The supervisor's refresh service handles rotation
 * automatically.
 */
import { SpotifyApi, type AccessToken } from '@spotify/web-api-ts-sdk'
import { CredentialVault } from '../../../credentials/vault.js'
import { CredentialVaultError } from '../../../credentials/types.js'

export const SPOTIFY_CLIENT_ID_ENV = '_2200_OAUTH_SPOTIFY_CLIENT_ID'
export const SPOTIFY_VAULT_CRED_NAME = 'spotify'
export const SPOTIFY_VAULT_REFRESH_NAME = 'spotify-refresh'

export type SpotifyCredentialCause = 'NO_CLIENT_ID' | 'NO_VAULT_TOKEN'

export class SpotifyCredentialError extends Error {
  public readonly reason: SpotifyCredentialCause
  constructor(message: string, reason: SpotifyCredentialCause) {
    super(message)
    this.name = 'SpotifyCredentialError'
    this.reason = reason
  }
}

/**
 * Construct a SpotifyApi for the given agent's vault credentials.
 * Reads the access token + (optionally) refresh token, hands them to
 * the SDK in the shape it expects, and returns a ready-to-call
 * instance.
 *
 * Throws `SpotifyCredentialError` if either:
 *   - `_2200_OAUTH_SPOTIFY_CLIENT_ID` is unset (operator never
 *     registered the OAuth app).
 *   - The agent's vault has no `spotify` entry (operator never ran
 *     `2200 oauth login spotify <agent>`).
 */
export interface BuildSpotifyApiArgs {
  home: string
  agentName: string
  /** Test seam: override vault constructor. */
  vaultFactory?: (home: string, agent: string) => CredentialVault
  /** Test seam: override env reader. */
  envReader?: (key: string) => string | undefined
}

export async function buildSpotifyApi(args: BuildSpotifyApiArgs): Promise<SpotifyApi> {
  const env = args.envReader ?? ((k: string) => process.env[k])
  const clientId = env(SPOTIFY_CLIENT_ID_ENV)
  if (!clientId || clientId.trim().length === 0) {
    throw new SpotifyCredentialError(
      `Spotify access not yet configured for '${args.agentName}'. ` +
        `If you can run shell commands, brain_search 'oauth-setup-spotify' for an agent-driven setup runbook. ` +
        `Operators can run \`2200 oauth login spotify ${args.agentName} --name spotify\` directly.`,
      'NO_CLIENT_ID',
    )
  }
  const vault = args.vaultFactory
    ? args.vaultFactory(args.home, args.agentName)
    : new CredentialVault(args.home, args.agentName)

  let accessEntry
  try {
    accessEntry = await vault.get(SPOTIFY_VAULT_CRED_NAME)
  } catch (err) {
    if (err instanceof CredentialVaultError && err.code === 'NOT_FOUND') {
      throw new SpotifyCredentialError(
        `Spotify access token not in ${args.agentName}'s vault yet. ` +
          `If you have shell_run, brain_search 'oauth-setup-spotify' for the self-service runbook ` +
          `(ask the operator to be ready to click 'Agree' once, then drive the flow yourself).`,
        'NO_VAULT_TOKEN',
      )
    }
    throw err
  }
  let refreshToken = ''
  try {
    const refreshEntry = await vault.get(SPOTIFY_VAULT_REFRESH_NAME)
    refreshToken = refreshEntry.value
  } catch (err) {
    if (!(err instanceof CredentialVaultError && err.code === 'NOT_FOUND')) {
      throw err
    }
    // No refresh token is fine for the call itself; the supervisor
    // refresh service will warn if it can't rotate.
  }

  const expiresAtIso = accessEntry.metadata.expires_at
  let expiresIn = 3600
  if (expiresAtIso) {
    const expiresAtMs = new Date(expiresAtIso).getTime()
    if (!Number.isNaN(expiresAtMs)) {
      expiresIn = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000))
    }
  }

  const token: AccessToken = {
    access_token: accessEntry.value,
    token_type: 'Bearer',
    expires_in: expiresIn,
    refresh_token: refreshToken,
  }
  return SpotifyApi.withAccessToken(clientId.trim(), token)
}
