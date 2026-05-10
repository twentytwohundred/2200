/**
 * Platform tool servers.
 *
 * Platform tools sit alongside baseline tools in the per-Agent
 * ToolRegistry but are NOT in `BASELINE_TOOL_NAMES`. They are external
 * service integrations (Discord, Slack, Spotify) that ship in-process
 * for v1 simplicity. Per-Agent access is gated by the Identity's
 * `tools:` array (which already supports `discord_*` / `slack_*` /
 * `spotify_*` namespace wildcards via the existing `expandToolGrants`
 * machinery).
 *
 * Credentials are NOT validated at server-construction time. Each tool
 * resolves its credential lazily at first call and throws a clean
 * "credential missing" error if absent. This keeps the tool surface
 * deterministic across agents (every agent sees the same tools)
 * regardless of operator configuration timing.
 *
 * Future work:
 *   - Phase B extensions framework will let users install external MCP
 *     servers via the UI, at which point platform tools become a
 *     candidate for migration.
 *   - Per-Agent credential scoping (different bot per agent) would
 *     require lifting the lazy resolver into a per-call lookup with
 *     agent context.
 */
import type { McpServer } from '../../mcp/server.js'
import { discordServer } from './discord/index.js'
import { spotifyServer } from './spotify/index.js'
import { slackServer } from './slack/index.js'

export const PLATFORM_TOOL_NAMES: readonly string[] = [
  // Discord (5)
  'discord_send_message',
  'discord_list_channels',
  'discord_fetch_history',
  'discord_react',
  'discord_create_thread',
  // Spotify (11)
  'spotify_search_tracks',
  'spotify_get_playback_state',
  'spotify_get_devices',
  'spotify_play_track',
  'spotify_pause',
  'spotify_skip_next',
  'spotify_add_to_queue',
  'spotify_get_my_playlists',
  'spotify_get_playlist_tracks',
  'spotify_add_to_playlist',
  'spotify_create_playlist',
  // Slack (6)
  'slack_send_message',
  'slack_list_channels',
  'slack_fetch_history',
  'slack_react',
  'slack_get_user',
  'slack_get_thread',
]

export interface PlatformServersOptions {
  discordEnabled?: boolean
  spotifyEnabled?: boolean
  slackEnabled?: boolean
}

export function platformServers(opts: PlatformServersOptions = {}): McpServer[] {
  const servers: McpServer[] = []
  if (opts.discordEnabled !== false) {
    servers.push(discordServer())
  }
  if (opts.spotifyEnabled !== false) {
    servers.push(spotifyServer())
  }
  if (opts.slackEnabled !== false) {
    servers.push(slackServer())
  }
  return servers
}
