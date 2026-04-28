/**
 * Baseline tool servers.
 *
 * Per [[2026-04-25-tool-baseline]], every Agent gets these 14 tools by
 * default. The Identity's `tools:` array adds to this set; it does not
 * replace it. The Agent's runtime constructs a `ToolRegistry`,
 * registers each baseline server, and exposes the dispatcher to the
 * Agent loop.
 *
 * This module is the single import point for the baseline. Future
 * non-baseline tools (Skills, Extensions, user-registered MCP
 * servers) get registered alongside but live elsewhere.
 */
import { createInProcessServer, type McpServer } from '../../mcp/server.js'
import { fsTools } from './fs.js'
import { shellTools } from './shell.js'
import { webTools } from './web.js'
import { brainTools } from './brain.js'
import { timeTools } from './time.js'
import { pubTools } from './pub.js'
import { notificationTools } from './notification.js'

/**
 * All 19 baseline tool names. Used by tool-in-set perm checks and
 * Identity validation. Bumped 14 → 18 in Epic 3 PR C (pub.* tools);
 * bumped 18 → 19 in Epic 7 PR D (notification.ask).
 */
export const BASELINE_TOOL_NAMES: readonly string[] = [
  'fs.read',
  'fs.write',
  'fs.edit',
  'fs.list',
  'fs.delete',
  'shell.run',
  'web.fetch',
  'web.search',
  'brain.read',
  'brain.write',
  'brain.search',
  'brain.links',
  'time.now',
  'time.sleep',
  'pub.send',
  'pub.read',
  'pub.list_pubs',
  'pub.react',
  'notification.ask',
]

/** Build the seven baseline MCP servers. */
export function baselineServers(): McpServer[] {
  return [
    createInProcessServer('fs', fsTools),
    createInProcessServer('shell', shellTools),
    createInProcessServer('web', webTools),
    createInProcessServer('brain', brainTools),
    createInProcessServer('time', timeTools),
    createInProcessServer('pub', pubTools),
    createInProcessServer('notification', notificationTools),
  ]
}
