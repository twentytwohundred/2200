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
import { chatTools } from './chat.js'
import { scheduleTools, type SupervisorRpcGetter } from './schedule.js'
import { imageTools } from './image.js'
import { makeTaskDelegateTools } from './task-delegate.js'
import { credentialTools } from './credential.js'
import { httpTools } from './http.js'
import { whatsappTools } from './whatsapp.js'
import { discordTools } from './discord.js'
import { agentControlTools } from './agent-control.js'
import { SHELF_TOOL_NAMES, shelfTools } from './shelf.js'
import type { TaskBlockerRegistry } from '../../agent/blockers.js'

/**
 * All baseline tool names. Used by tool-in-set perm checks and
 * Identity validation. Bumped 14 → 18 in Epic 3 PR C (pub.* tools);
 * bumped 18 → 19 in Epic 7 PR D (notification.ask); reshaped in
 * Epic 8 PR C (brain.* swapped from path-based v1 stubs to
 * slug-based Phase A: brain.write/read/search/list/delete; dropped
 * brain.links — Phase C delivers `brain.get_links`); bumped to
 * include `notification_inform` for Epic 7 Phase B (fire-and-forget
 * passive notification surface); bumped 23 → 24 with `system_whoami`
 * so Agents can introspect their live runtime model with ground
 * truth, not prompt-level assertion; bumped 24 → 25 with `chat_send`
 * so Agents can push unsolicited assistant-role messages into their
 * own per-Agent private chat thread (the inverse of the user → agent
 * direction the chat HTTP endpoint already supports); bumped 25 → 29
 * with `brain_read_shared`, `brain_search_shared`, `brain_list_shared`,
 * and `brain_write_shared` so every Agent can see the instance's
 * shared brain at <home>/shared/brain/ (platform overview, team
 * roster, operator profile, conventions); bumped 29 → 34 with
 * `schedule.add/list/remove/set_enabled/run_once` so Agents can
 * manage their own cron / interval schedules at runtime instead
 * of waiting for the operator to wire each one through the CLI.
 */
export const BASELINE_TOOL_NAMES: readonly string[] = [
  'fs_read',
  'fs_write',
  'fs_edit',
  'fs_list',
  'fs_delete',
  'shell_run',
  'web_fetch',
  'web_search',
  'brain_write',
  'brain_read',
  'brain_search',
  'brain_list',
  'brain_delete',
  'brain_search_agent',
  'brain_list_agent',
  'time_now',
  'time_sleep',
  'pub_send',
  'pub_read',
  'pub_list_pubs',
  'pub_react',
  'notification_ask',
  'notification_inform',
  'system_whoami',
  'chat_send',
  'brain_read_shared',
  'brain_search_shared',
  'brain_list_shared',
  'brain_write_shared',
  'schedule_add',
  'schedule_list',
  'schedule_remove',
  'schedule_set_enabled',
  'schedule_run_once',
  'image_generate',
  'task_create_for_agent',
  'task_await_response',
  'credential_request',
  'credential_has',
  'http_request',
  'whatsapp_send',
  'discord_send',
  'restart_self',
  // Phase 2 / PR-B2: embassy shelf tools. Implementation lives in the
  // baseline registry so the dispatcher knows them, but the dispatcher's
  // identity-level allowlist check restricts these to Agents whose
  // identity carries the `embassy:` block (the embassy Agent for an
  // active conduit). Non-embassy Agents calling these get
  // tool_in_set perm denial, same machinery as the PR 4 hard-guard.
  ...SHELF_TOOL_NAMES,
]

export interface BaselineServersOptions {
  /**
   * Returns the live IdentityRecord of the calling Agent process.
   * Used by `system_whoami` so the tool reflects in-memory ground
   * truth (what the LLM provider is actually bound to), not the
   * on-disk frontmatter (which can drift if an operator edits the
   * identity file without restarting the Agent).
   *
   * Optional: tests that don't exercise `system_whoami` can omit it.
   * The whoami tool will throw if invoked without a getter.
   */
  getIdentity?: IdentityGetter
  /**
   * Returns the agent's RPC client to the supervisor. Used by the
   * `schedule.*` tools to invoke `cli.schedule.*` RPC methods.
   * Returns undefined if the client has not yet connected; the
   * tool throws a clean error in that case.
   *
   * Optional: tests that don't exercise schedule tools can omit it.
   */
  getSupervisorRpc?: SupervisorRpcGetter

  /**
   * Returns the TaskBlockerRegistry for the current task.
   * Used by human-gated tools (credential_request, future notification_ask, etc.)
   * so they can register blockers that pause the AgentLoop.
   *
   * Optional during the initial TaskBlocker rollout.
   */
  getBlockerRegistry?: () => TaskBlockerRegistry
}

/** Build the ten baseline MCP servers. */
export function baselineServers(opts: BaselineServersOptions = {}): McpServer[] {
  const getIdentity: IdentityGetter = opts.getIdentity ?? (() => null)
  const getSupervisorRpc: SupervisorRpcGetter = opts.getSupervisorRpc ?? (() => undefined)
  return [
    createInProcessServer('fs', fsTools),
    createInProcessServer('shell', shellTools),
    createInProcessServer('web', webTools),
    createInProcessServer('brain', brainTools),
    createInProcessServer('time', timeTools),
    createInProcessServer('pub', pubTools),
    createInProcessServer('notification', notificationTools),
    createInProcessServer('system', systemTools(getIdentity)),
    createInProcessServer('chat', chatTools),
    createInProcessServer('schedule', scheduleTools(getSupervisorRpc)),
    createInProcessServer('image', imageTools),
    createInProcessServer(
      'task',
      makeTaskDelegateTools(() => opts.getBlockerRegistry?.() ?? null),
    ),
    createInProcessServer(
      'credential',
      credentialTools(getIdentity, getSupervisorRpc, opts.getBlockerRegistry),
    ),
    createInProcessServer('http', httpTools),
    createInProcessServer('whatsapp', whatsappTools),
    createInProcessServer('discord', discordTools),
    // server prefix matches the tool name's prefix (`restart_*`).
    createInProcessServer('restart', agentControlTools(getSupervisorRpc)),
    // Phase 2 / PR-B2: embassy shelf tools. Tools live in the registry
    // for every Agent process; the identity's `tools:` allowlist + the
    // dispatcher's tool_in_set check restrict actual calls to the
    // embassy Agent for a given conduit.
    createInProcessServer('shelf', shelfTools),
  ]
}
