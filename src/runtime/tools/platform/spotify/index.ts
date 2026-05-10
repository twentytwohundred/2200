/**
 * Spotify platform tool surface (entry point).
 */
import { createInProcessServer, type McpServer } from '../../../mcp/server.js'
import { makeSpotifyTools, type SpotifyToolDeps } from './tools.js'

export {
  buildSpotifyApi,
  SpotifyCredentialError,
  SPOTIFY_CLIENT_ID_ENV,
  SPOTIFY_VAULT_CRED_NAME,
  SPOTIFY_VAULT_REFRESH_NAME,
} from './client.js'
export { SPOTIFY_TOOL_NAMES } from './tools.js'

export type SpotifyServerOptions = SpotifyToolDeps

export function spotifyServer(opts: SpotifyServerOptions = {}): McpServer {
  return createInProcessServer('spotify', makeSpotifyTools(opts))
}
