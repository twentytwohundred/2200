/**
 * Discord platform tool surface (entry point).
 *
 * Exports a factory that builds a fresh in-process MCP server bundling
 * the five Discord tools. The agent boot calls this once per process.
 */
import { createInProcessServer, type McpServer } from '../../../mcp/server.js'
import type { DiscordClient } from './client.js'
import { defaultDiscordClient } from './client.js'
import { makeDiscordTools } from './tools.js'

export { DiscordClient, DiscordCredentialError, DISCORD_BOT_TOKEN_ENV } from './client.js'
export { DISCORD_TOOL_NAMES } from './tools.js'

export interface DiscordServerOptions {
  /**
   * Override the Discord client (test seam). The default reads
   * `_2200_DISCORD_BOT_TOKEN` from process.env at first call.
   */
  client?: DiscordClient
}

export function discordServer(opts: DiscordServerOptions = {}): McpServer {
  const client = opts.client ?? defaultDiscordClient
  return createInProcessServer('discord', makeDiscordTools(client))
}
