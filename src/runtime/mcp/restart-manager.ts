/**
 * MCP server restart manager (Epic 9 Phase A PR D).
 *
 * Wraps `spawnStdioMcpServer` (PR B) with the locked backoff + crash
 * policy from the Phase A spec:
 *
 *   - 3 fast retries: 200ms, 1s, 5s
 *   - Then exponential starting at 30s, capped at 5 minutes
 *   - Passive notification on first restart
 *   - Important notification at 5+ consecutive failures
 *   - Consecutive-failures counter resets on a successful spawn
 *
 * The manager exposes the same `McpServer` shape that the registry
 * consumes ... a stable Map<string, ToolDefinition> ... so the
 * AgentProcess can register the manager directly and not care about
 * the underlying restart churn. Tool calls during a restart window
 * fail fast with a clear "server is currently down" message; calls
 * after a successful restart route through the new child without
 * intervention.
 *
 * Phase A scope is in-process restart (the Agent process owns the
 * MCP children). When the Agent process itself dies, the supervisor
 * restarts the Agent and the MCP children come up fresh; the
 * consecutive-failures counter does NOT persist across Agent restart
 * (intentional simplification for Phase A; the Important notification
 * still fires within one Agent session if the server is genuinely
 * broken).
 */
import { defineTool, type ToolContext, type ToolDefinition } from './tool.js'
import type { McpServer } from './server.js'
import {
  spawnStdioMcpServer,
  type SpawnStdioMcpArgs,
  type StdioMcpServerHandle,
} from './stdio-transport.js'
import { z } from 'zod'
import type { Logger } from '../util/logger.js'
import type { NotificationTier } from '../identity/types.js'

const PERMISSIVE_ARGS_SCHEMA = z.record(z.string(), z.unknown())

/** Backoff schedule per the Phase A locked decision. */
export const FAST_RETRY_MS = [200, 1_000, 5_000] as const
export const EXPONENTIAL_BASE_MS = 30_000
export const MAX_BACKOFF_MS = 5 * 60 * 1_000

/** Notification thresholds. */
const NOTIFY_PASSIVE_AT_RESTART = 1
const NOTIFY_IMPORTANT_AT_FAILURES = 5

/**
 * Pure decision: which notification tier (if any) should be emitted
 * for this attempt number? Phase A locked policy:
 *
 *   - First restart attempt → Passive
 *   - 5th consecutive failure → Important
 *   - All other attempts → no notification
 *
 * Exposed for testing in isolation; the manager calls this every
 * attempt and skips emission when it returns null.
 */
export function notificationTierForAttempt(attemptNumber: number): NotificationTier | null {
  if (attemptNumber === NOTIFY_PASSIVE_AT_RESTART) return 'passive'
  if (attemptNumber === NOTIFY_IMPORTANT_AT_FAILURES) return 'important'
  return null
}

/**
 * Compute the delay before the n-th restart attempt.
 *
 *   - attempt 1 → 200ms
 *   - attempt 2 → 1s
 *   - attempt 3 → 5s
 *   - attempt 4 → 30s
 *   - attempt 5 → 60s
 *   - attempt 6 → 120s
 *   - attempt 7 → 240s
 *   - attempt 8+ → 300s (capped)
 */
export function computeBackoffMs(attemptNumber: number): number {
  if (attemptNumber <= 0) return 0
  if (attemptNumber <= FAST_RETRY_MS.length) {
    const slot = FAST_RETRY_MS[attemptNumber - 1]
    if (slot !== undefined) return slot
  }
  // attemptNumber=4 → exponent=0 → 30s; attemptNumber=5 → 60s; ...
  const exponent = attemptNumber - FAST_RETRY_MS.length - 1
  const delay = EXPONENTIAL_BASE_MS * Math.pow(2, exponent)
  return Math.min(delay, MAX_BACKOFF_MS)
}

/**
 * Notification emitter the manager calls for restart events. Decoupled
 * from the supervisor's notifications/writer module so the manager is
 * trivially testable; AgentProcess wires the production notifier.
 */
export type RestartNotifier = (args: {
  tier: NotificationTier
  body: string
  extras: Record<string, unknown>
}) => Promise<void>

export interface McpServerManagerArgs {
  /** Identity-declared server name; also the dotted namespace prefix. */
  serverName: string
  /** Spawn arguments forwarded to `spawnStdioMcpServer`. */
  spawnArgs: SpawnStdioMcpArgs
  /** Notification emitter for restart events. */
  notifier: RestartNotifier
  /** Test injection: override the spawn function. */
  spawn?: (args: SpawnStdioMcpArgs) => Promise<StdioMcpServerHandle>
  /** Test injection: override the sleep function. */
  sleep?: (ms: number) => Promise<void>
  /** Optional logger. */
  logger?: Logger
}

const NOOP_LOGGER: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => NOOP_LOGGER,
}

/**
 * Restart-managed wrapper around a stdio MCP server. After construction,
 * call `start()` once to bring the server up. Tools become available on
 * the `tools` map; tool calls route through the current handle.
 *
 * On underlying-transport close (child crash), the manager queues a
 * restart with backoff and updates the consecutive-failures counter
 * + notifications per policy.
 */
export class McpServerManager implements McpServer {
  readonly name: string
  readonly tools: ReadonlyMap<string, ToolDefinition>

  private readonly spawnArgs: SpawnStdioMcpArgs
  private readonly notifier: RestartNotifier
  private readonly spawnFn: (args: SpawnStdioMcpArgs) => Promise<StdioMcpServerHandle>
  private readonly sleepFn: (ms: number) => Promise<void>
  private readonly log: Logger

  private currentHandle: StdioMcpServerHandle | undefined
  /** Tools the FIRST successful spawn discovered. Stable thereafter. */
  private readonly discoveredTools = new Set<string>()
  private consecutiveFailures = 0
  private stopped = false
  /** A pending restart, if one is queued. */
  private restartPromise: Promise<void> | undefined

  constructor(args: McpServerManagerArgs) {
    this.name = args.serverName
    this.spawnArgs = args.spawnArgs
    this.notifier = args.notifier
    this.spawnFn = args.spawn ?? spawnStdioMcpServer
    this.sleepFn = args.sleep ?? defaultSleep
    this.log = args.logger ?? NOOP_LOGGER

    // The tools Map the registry holds onto is created up front and
    // populated lazily on first successful spawn. Forwarding tool
    // definitions check the current handle at call time.
    this.tools = new Map<string, ToolDefinition>()
  }

  /**
   * First spawn. Throws if it fails ... an Agent that cannot start its
   * MCP servers should not start. Subsequent crashes are non-fatal and
   * trigger the restart loop.
   */
  async start(): Promise<void> {
    const handle = await this.spawnFn(this.spawnArgs)
    this.currentHandle = handle
    this.attachCloseListener(handle)

    // Populate the tools map ONCE on first spawn. Subsequent restarts
    // re-register against the same Map so registry consumers see no
    // change. If the server's tool list legitimately changes across a
    // restart (rare in practice for a stable MCP server), tools added
    // post-restart are missing here and tools removed post-restart
    // throw at call time. Future polish can refresh on each spawn.
    const mutableTools = this.tools as Map<string, ToolDefinition>
    for (const name of handle.tools.keys()) {
      this.discoveredTools.add(name)
      mutableTools.set(name, this.makeForwardingTool(name))
    }
  }

  /**
   * Graceful shutdown. No more restarts; close the current handle.
   * Idempotent.
   */
  async stop(): Promise<void> {
    this.stopped = true
    const h = this.currentHandle
    this.currentHandle = undefined
    if (h !== undefined) {
      await h.close().catch(() => undefined)
    }
    // Wait for any pending restart to settle so we do not leak a
    // newly-spawned child after stop returns.
    if (this.restartPromise !== undefined) {
      await this.restartPromise.catch(() => undefined)
    }
  }

  /** Tools discovered on the first successful spawn, exposed for tests. */
  get knownToolNames(): readonly string[] {
    return [...this.discoveredTools]
  }

  /** Whether a server is currently up. Exposed for tests. */
  get isUp(): boolean {
    return this.currentHandle !== undefined
  }

  /** Number of consecutive failures since the last successful spawn. */
  get failureCount(): number {
    return this.consecutiveFailures
  }

  // -------------------------------------------------------------------------

  private attachCloseListener(handle: StdioMcpServerHandle): void {
    // The SDK Client carries an `onclose` callback that fires when the
    // underlying transport closes (child exit, deliberate close, error
    // unwind). After a graceful `stop()`, we ignore the event; otherwise
    // we kick off the restart loop.
    handle.client.onclose = () => {
      if (this.stopped) return
      // Discard the now-defunct handle and queue a restart. The
      // .catch() on the floating promise is load-bearing: without
      // it, an exception inside restartLoop bubbles up as an
      // unhandled rejection and crashes the agent process. Per the
      // 2026-05-08 review.
      this.currentHandle = undefined
      this.restartPromise ??= this.restartLoop()
        .catch((err: unknown) => {
          this.log.error('mcp restart loop crashed; will not retry until next close', {
            server: this.name,
            error: err instanceof Error ? err.message : String(err),
          })
        })
        .finally(() => {
          this.restartPromise = undefined
        })
    }
  }

  private async restartLoop(): Promise<void> {
    // Loop with explicit `stopped` checks at every async boundary so
    // a stop() call between the sleep and the spawn does not result
    // in a stale spawn after shutdown. The redundant-conditional lint
    // rule is silenced on the post-await checks because TypeScript's
    // flow analysis can not see through async boundaries (stop() may
    // run between the await and the next statement).
    while (!this.stopped) {
      this.consecutiveFailures += 1
      const attemptNumber = this.consecutiveFailures
      const delayMs = computeBackoffMs(attemptNumber)
      // emitRestartNotification was previously OUTSIDE the try/catch
      // around spawnFn ... a notification-write failure (disk full,
      // file permissions, brain index lock) would bubble out of the
      // loop as an unhandled rejection and crash the agent process.
      // Wrapped now so the loop continues to attempt the spawn even
      // if the operator-facing notification can't land.
      try {
        await this.emitRestartNotification(attemptNumber)
      } catch (err) {
        this.log.warn('mcp restart notification failed; continuing with restart attempt', {
          server: this.name,
          attempt: attemptNumber,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      this.log.info('mcp restart pending', {
        server: this.name,
        attempt: attemptNumber,
        delay_ms: delayMs,
      })
      await this.sleepFn(delayMs)
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (this.stopped) return

      try {
        const next = await this.spawnFn(this.spawnArgs)
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (this.stopped) {
          await next.close().catch(() => undefined)
          return
        }
        this.currentHandle = next
        this.attachCloseListener(next)
        this.consecutiveFailures = 0
        this.log.info('mcp restart succeeded', { server: this.name, attempt: attemptNumber })
        return
      } catch (err) {
        this.log.warn('mcp restart attempt failed', {
          server: this.name,
          attempt: attemptNumber,
          error: err instanceof Error ? err.message : String(err),
        })
        // Loop and try again with the next backoff slot.
      }
    }
  }

  private async emitRestartNotification(attemptNumber: number): Promise<void> {
    const tier = notificationTierForAttempt(attemptNumber)
    if (tier === null) return
    const body =
      tier === 'important'
        ? `MCP server "${this.name}" has failed ${String(attemptNumber)} consecutive restarts. Investigate the server's command or credentials.`
        : `MCP server "${this.name}" closed; restart pending.`
    await this.notifier({
      tier,
      body,
      extras: { server: this.name, attempt: attemptNumber },
    })
  }

  private makeForwardingTool(namespacedName: string): ToolDefinition {
    return defineTool({
      name: namespacedName,
      description: `External MCP tool ${namespacedName} (restart-managed)`,
      idempotency: 'destructive',
      argsSchema: PERMISSIVE_ARGS_SCHEMA,
      execute: async (toolArgs: unknown, ctx: ToolContext): Promise<unknown> => {
        const handle = this.currentHandle
        if (handle === undefined) {
          throw new Error(`MCP server "${this.name}" is currently down (restarting); retry shortly`)
        }
        const target = handle.tools.get(namespacedName)
        if (target === undefined) {
          throw new Error(
            `tool ${namespacedName} is not in the current MCP server's tool list (server may have re-listed; restart the Agent to refresh)`,
          )
        }
        return target.execute(toolArgs, ctx)
      },
    })
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) {
      setImmediate(() => {
        resolve()
      })
      return
    }
    setTimeout(resolve, ms)
  })
}
