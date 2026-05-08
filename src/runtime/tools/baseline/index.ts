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
import { systemTools, type IdentityGetter } from './system.js'

/**
 * All baseline tool names. Used by tool-in-set perm checks and
 * Identity validation. Bumped 14 → 18 in Epic 3 PR C (pub.* tools);
 * bumped 18 → 19 in Epic 7 PR D (notification.ask); reshaped in
 * Epic 8 PR C (brain.* swapped from path-based v1 stubs to
 * slug-based Phase A: brain.write/read/search/list/delete; dropped
 * brain.links — Phase C delivers `brain.get_links`); bumped to
 * include `notification.inform` for Epic 7 Phase B (fire-and-forget
 * passive notification surface); bumped 23 → 24 with `system.whoami`
 * so Agents can introspect their live runtime model with ground
 * truth, not prompt-level assertion.
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
  'brain.write',
  'brain.read',
  'brain.search',
  'brain.list',
  'brain.delete',
  'brain.search_agent',
  'brain.list_agent',
  'time.now',
  'time.sleep',
  'pub.send',
  'pub.read',
  'pub.list_pubs',
  'pub.react',
  'notification.ask',
  'notification.inform',
  'system.whoami',
]

export interface BaselineServersOptions {
  /**
   * Returns the live IdentityRecord of the calling Agent process.
   * Used by `system.whoami` so the tool reflects in-memory ground
   * truth (what the LLM provider is actually bound to), not the
   * on-disk frontmatter (which can drift if an operator edits the
   * identity file without restarting the Agent).
   *
   * Optional: tests that don't exercise `system.whoami` can omit it.
   * The whoami tool will throw if invoked without a getter.
   */
  getIdentity?: IdentityGetter
}

/** Build the eight baseline MCP servers. */
export function baselineServers(opts: BaselineServersOptions = {}): McpServer[] {
  const getIdentity: IdentityGetter = opts.getIdentity ?? (() => null)
  return [
    createInProcessServer('fs', fsTools),
    createInProcessServer('shell', shellTools),
    createInProcessServer('web', webTools),
    createInProcessServer('brain', brainTools),
    createInProcessServer('time', timeTools),
    createInProcessServer('pub', pubTools),
    createInProcessServer('notification', notificationTools),
    createInProcessServer('system', systemTools(getIdentity)),
  ]
}
