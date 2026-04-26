/**
 * Agent process: connects to the supervisor, registers, and idles.
 *
 * v1 scope: register, run a heartbeat timer, exit cleanly when the
 * supervisor closes the connection. The Agent loop (task pickup, model
 * binding, MCP-native tool dispatch, plan/run/perm wrapping, detectors)
 * lands in subsequent PRs.
 *
 * The Agent process expects three environment variables, set by the
 * supervisor's spawn:
 *   - TWENTYTWOHUNDRED_AGENT_NAME
 *   - TWENTYTWOHUNDRED_IDENTITY_PATH
 *   - TWENTYTWOHUNDRED_SOCKET_PATH
 *
 * The process exits non-zero if any of these are missing or if registration
 * is rejected by the supervisor.
 */
import { JsonRpcClient } from '../control-plane/client.js'
import { connectUds } from '../control-plane/transport-uds.js'
import type { Connection } from '../control-plane/transport.js'
import { createLogger, type Logger } from '../util/logger.js'
import { AgentStateMachine } from './state-machine.js'

const HEARTBEAT_INTERVAL_MS = 10_000

export interface AgentProcessOptions {
  name: string
  identityPath: string
  socketPath: string
  /** Inject a connection (testing); defaults to a UDS connection to socketPath. */
  connection?: Connection
  /** Inject a logger. */
  logger?: Logger
  /** Override heartbeat cadence (testing). */
  heartbeatIntervalMs?: number
}

export class AgentProcess {
  private readonly machine = new AgentStateMachine('stopped')
  private readonly log: Logger
  private client: JsonRpcClient | undefined
  private heartbeatTimer: NodeJS.Timeout | undefined
  private isShuttingDown = false

  constructor(private readonly options: AgentProcessOptions) {
    this.log = options.logger ?? createLogger(`agent/${options.name}`)
  }

  /**
   * Connect to the supervisor, register, and start the heartbeat loop.
   * Resolves once the Agent is registered and idling. Rejects if the
   * supervisor refuses registration.
   */
  async start(): Promise<void> {
    const conn = this.options.connection ?? (await connectUds(this.options.socketPath))
    this.client = new JsonRpcClient(conn, this.log.child('rpc'))

    const result = await this.client.call('agent.register', {
      name: this.options.name,
      pid: process.pid,
    })
    if (!result.accepted) {
      throw new Error(`supervisor rejected registration: ${result.reason ?? 'no reason given'}`)
    }
    this.machine.transition('running', 'supervisor accepted registration')

    const interval = this.options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat()
    }, interval)
    if (typeof this.heartbeatTimer === 'object' && 'unref' in this.heartbeatTimer) {
      this.heartbeatTimer.unref()
    }

    this.log.info('Agent registered with supervisor', { name: this.options.name })
  }

  /**
   * Send a single heartbeat. Errors are logged but not thrown; the next
   * heartbeat tick will retry. If the connection is dead the supervisor
   * will mark the Agent errored on its own.
   */
  private async heartbeat(): Promise<void> {
    if (!this.client || this.isShuttingDown) return
    try {
      await this.client.call('agent.heartbeat', { state: this.machine.state })
    } catch (err) {
      this.log.warn('heartbeat failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Shutdown signal handler: attempt graceful exit. Reports the transition
   * to the supervisor when possible; the supervisor also tracks the OS-level
   * exit so this is best-effort.
   */
  async shutdown(reason: string): Promise<void> {
    if (this.isShuttingDown) return
    this.isShuttingDown = true
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
    if (this.machine.state !== 'stopped') {
      try {
        this.machine.transition('stopped', reason)
      } catch {
        // already stopped via another path; ignore
      }
    }
    if (this.client) {
      try {
        await this.client.close()
      } catch {
        // ignore
      }
      this.client = undefined
    }
    this.log.info('Agent shutdown', { reason })
  }

  /** Inspect the current state machine (testing / introspection). */
  get state(): string {
    return this.machine.state
  }
}
