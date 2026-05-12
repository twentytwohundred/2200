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
  // Discord (1): passthrough per the 2026-05-11 platform-integration pattern.
  // The previous 5-wrapper surface (send_message, list_channels, fetch_history,
  // react, create_thread) was collapsed into discord_api on 2026-05-12.
  'discord_api',
  // Spotify (2): passthrough + server-side-only cover-upload helper.
  // The previous 12-wrapper surface (search, get_playback_state, create_playlist,
  // ...) was collapsed into spotify_api on 2026-05-11.
  'spotify_api',
  'spotify_set_playlist_cover',
  // Slack (1): passthrough per the 2026-05-11 platform-integration pattern.
  // The previous 6-wrapper surface (send_message, list_channels, fetch_history,
  // react, get_user, get_thread) was collapsed into slack_api on 2026-05-12.
  'slack_api',
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
