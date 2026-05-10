/**
 * Slack platform tool surface (entry point).
 */
import { createInProcessServer, type McpServer } from '../../../mcp/server.js'
import type { SlackClient } from './client.js'
import { defaultSlackClient } from './client.js'
import { makeSlackTools } from './tools.js'

export { SlackClient, SlackCredentialError, SLACK_BOT_TOKEN_ENV } from './client.js'
export { SLACK_TOOL_NAMES } from './tools.js'

export interface SlackServerOptions {
  client?: SlackClient
}

export function slackServer(opts: SlackServerOptions = {}): McpServer {
  const client = opts.client ?? defaultSlackClient
  return createInProcessServer('slack', makeSlackTools(client))
}
