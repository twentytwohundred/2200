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
import { loadIdentity } from '../identity/loader.js'
import { composeModelId, type IdentityRecord } from '../identity/types.js'
import { resolveProvider } from '../llm/registry.js'
import type { LLMProvider } from '../llm/provider.js'
import { agentPaths } from '../storage/layout.js'
import { TelemetryWriter } from '../telemetry/writer.js'
import { ToolRegistry } from '../mcp/registry.js'
import { ToolDispatcher } from '../tools/dispatcher.js'
import { BASELINE_TOOL_NAMES, baselineServers } from '../tools/baseline/index.js'
import { TaskStore } from './task/store.js'
import { AgentLoop, type LoopResult } from './loop.js'
import { loadState } from '../supervisor/state.js'
import { readCredentialFile } from '../pub/keypair.js'
import { getOrCreatePubClient } from '../pub/registry.js'
import { PubWakeSource } from '../pub/wake-source.js'
import type { PubClient } from '../pub/client.js'
import { Router } from '../pub/router.js'
import { upsertRosterEntry } from '../pub/roster.js'

const HEARTBEAT_INTERVAL_MS = 10_000
const TASK_POLL_INTERVAL_MS = 1_000

export interface AgentProcessOptions {
  name: string
  identityPath: string
  socketPath: string
  /** 2200_HOME root. The Agent reads this from the env var by default. */
  home: string
  /** Inject a connection (testing); defaults to a UDS connection to socketPath. */
  connection?: Connection
  /** Inject a logger. */
  logger?: Logger
  /** Override heartbeat cadence (testing). */
  heartbeatIntervalMs?: number
  /** Override task-poll cadence (testing). */
  taskPollIntervalMs?: number
  /** Override the LLM provider (testing). */
  provider?: LLMProvider
}

export class AgentProcess {
  private readonly machine = new AgentStateMachine('stopped')
  private readonly log: Logger
  private client: JsonRpcClient | undefined
  private heartbeatTimer: NodeJS.Timeout | undefined
  private taskPollTimer: NodeJS.Timeout | undefined
  private isShuttingDown = false
  private identity: IdentityRecord | undefined
  private provider: LLMProvider | undefined
  private taskStore: TaskStore | undefined
  private loop: AgentLoop | undefined
  private taskInFlight = false
  private readonly pubWakeSources: PubWakeSource[] = []
  private readonly pubClients: PubClient[] = []

  constructor(private readonly options: AgentProcessOptions) {
    this.log = options.logger ?? createLogger(`agent/${options.name}`)
  }

  /**
   * Connect to the supervisor, register, and start the heartbeat loop.
   * Resolves once the Agent is registered and idling. Rejects if the
   * supervisor refuses registration or if the Identity fails to load.
   */
  async start(): Promise<void> {
    // Load the Identity first. If it has drifted out of spec since
    // create-time validation, fail loud here rather than after we have
    // already announced ourselves to the supervisor.
    this.identity = await loadIdentity(this.options.identityPath)
    if (this.identity.frontmatter.agent_name !== this.options.name) {
      throw new Error(
        `Identity at ${this.identity.source_path} declares agent_name "${this.identity.frontmatter.agent_name}" but this process was launched as "${this.options.name}"`,
      )
    }
    this.log.info('Identity loaded', {
      name: this.identity.frontmatter.agent_name,
      role: this.identity.frontmatter.agent_role,
      model: composeModelId(this.identity.frontmatter.model),
      tier: this.identity.frontmatter.model.tier,
      extra_tools: this.identity.frontmatter.tools,
    })

    // Construct the LLM provider before contacting the supervisor. If the
    // model binding is misconfigured (missing API key, unknown provider),
    // fail loud here rather than after announcing ourselves. Tests can
    // inject a fake provider via options.provider to avoid hitting a real
    // LLM endpoint.
    this.provider =
      this.options.provider ??
      (await resolveProvider({
        providerName: this.identity.frontmatter.model.provider,
        ...(this.identity.frontmatter.provider_secret
          ? { secret: this.identity.frontmatter.provider_secret }
          : {}),
      }))
    this.log.info('LLM provider bound', {
      provider: this.provider.name,
      baseUrl: this.provider.baseUrl,
      modelId: this.identity.frontmatter.model.model_id,
    })

    // Wire the dispatcher and the AgentLoop. The dispatcher needs the home
    // root and the per-Agent paths so it can resolve virtual paths
    // (`/commons`, `/project`, etc.) and write plan/run/perm records to
    // the right brain dir. The loop holds onto the dispatcher and is
    // woken by the task-poll timer below.
    const ap = agentPaths(this.options.home, this.options.name)
    const registry = new ToolRegistry()
    for (const server of baselineServers()) {
      registry.register(server)
    }
    const dispatcher = new ToolDispatcher({
      registry,
      allowedToolNames: new Set([...BASELINE_TOOL_NAMES, ...this.identity.frontmatter.tools]),
      home: this.options.home,
      callingAgent: this.options.name,
      brainDir: ap.brain,
      projectDir: ap.project,
      logger: this.log.child('dispatcher'),
    })
    this.taskStore = new TaskStore(this.options.home, this.options.name)
    const telemetryWriter = new TelemetryWriter(this.options.home, this.options.name)
    this.loop = new AgentLoop({
      identity: this.identity,
      provider: this.provider,
      dispatcher,
      taskStore: this.taskStore,
      home: this.options.home,
      brainDir: ap.brain,
      availableToolNames: [...BASELINE_TOOL_NAMES, ...this.identity.frontmatter.tools],
      logger: this.log.child('loop'),
      telemetryWriter,
    })

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

    const pollInterval = this.options.taskPollIntervalMs ?? TASK_POLL_INTERVAL_MS
    this.taskPollTimer = setInterval(() => {
      void this.tickTaskPoll()
    }, pollInterval)
    if (typeof this.taskPollTimer === 'object' && 'unref' in this.taskPollTimer) {
      this.taskPollTimer.unref()
    }

    // Pub wake sources (Epic 3 PR D). If the Identity declares a `pub:`
    // block, connect to each pub the Agent is a member of and attach a
    // wake source. The wake source enqueues a synthetic `pub.handle`
    // task whenever an incoming message is `directed_to` this Agent;
    // the existing task-poll picks it up.
    //
    // Best-effort: errors at this stage are logged but do not prevent
    // the Agent from registering. The Agent can still process
    // CLI-submitted tasks; pub coordination is degraded until the
    // pub becomes reachable.
    if (this.identity.frontmatter.pub) {
      try {
        await this.attachPubWakeSources()
      } catch (err) {
        this.log.warn('failed to attach pub wake sources; pub coordination degraded', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    this.log.info('Agent registered with supervisor', { name: this.options.name })
  }

  /**
   * Connect to every pub this Agent participates in and attach a
   * PubWakeSource. Pub membership comes from the Identity's
   * `pub.member_of`; if empty/absent, defaults to "every running pub
   * on the instance" (the v1 typical install with one pub).
   */
  private async attachPubWakeSources(): Promise<void> {
    if (!this.identity?.frontmatter.pub || !this.taskStore) return
    const pubBlock = this.identity.frontmatter.pub
    if (!pubBlock.identity) {
      this.log.info('Agent has pub block but no agent_id (unregistered); skipping wake source')
      return
    }
    const cred = await readCredentialFile(
      agentPaths(this.options.home, this.options.name).pubSecret,
    )
    if (!cred.agent_id) {
      this.log.info('Agent credential file has no agent_id (unregistered); skipping wake source')
      return
    }

    const supervisorState = await loadState(this.options.home)
    const allRunning = Object.values(supervisorState.pubs).filter((p) => p.state === 'running')
    const targetPubs =
      pubBlock.member_of.length > 0
        ? allRunning.filter((p) => pubBlock.member_of.includes(p.name))
        : allRunning

    if (targetPubs.length === 0) {
      this.log.info('no running pubs to attach wake sources to', {
        member_of: pubBlock.member_of,
      })
      return
    }

    // Build an optional ambient-routing Router from env. Operators
    // opt-in by setting ROUTER_PROVIDER + ROUTER_MODEL_ID; without
    // them the wake source falls back to deterministic rules only
    // (pre-Epic-3.6 behavior).
    const routerProvider = process.env['ROUTER_PROVIDER']
    const routerModelId = process.env['ROUTER_MODEL_ID']
    let router: Router | undefined
    if (routerProvider && routerModelId) {
      try {
        const provider = await resolveProvider({ providerName: routerProvider })
        router = new Router({
          provider,
          modelId: routerModelId,
          logger: this.log.child(`router/${routerProvider}`),
        })
        this.log.info('ambient router enabled', {
          provider: routerProvider,
          model_id: routerModelId,
        })
      } catch (err) {
        this.log.warn(
          'ROUTER_PROVIDER/ROUTER_MODEL_ID set but provider build failed; running without router',
          {
            provider: routerProvider,
            model_id: routerModelId,
            error: err instanceof Error ? err.message : String(err),
          },
        )
      }
    }

    for (const pub of targetPubs) {
      const baseUrl = `http://127.0.0.1:${String(pub.port)}`
      const client = getOrCreatePubClient(this.options.name, pub.name, { baseUrl, cred })
      try {
        await client.connect()
      } catch (err) {
        this.log.warn('failed to connect to pub; skipping wake source', {
          pub: pub.name,
          error: err instanceof Error ? err.message : String(err),
        })
        continue
      }
      this.pubClients.push(client)

      // Self-upsert into the per-pub roster so peer Agents' wake
      // sources can identify us as an Agent (vs. a human user) and
      // gate the router-fallback path correctly. Without this,
      // Agents created before the roster module shipped never
      // appear in the file, peers treat their messages as human-
      // sent, and the politeness spiral guard misfires. Failures
      // are logged and the wake source still attaches... worst
      // case: this Agent doesn't appear as an ambient routing
      // candidate to peers, but the human can still @-mention us.
      try {
        await upsertRosterEntry(this.options.home, pub.name, {
          agent_id: cred.agent_id,
          agent_name: this.options.name,
          display_name: pubBlock.display_name,
          role_blurb: this.identity.frontmatter.agent_role,
        })
      } catch (err) {
        this.log.warn('roster self-upsert failed; peers may not classify us as an Agent', {
          pub: pub.name,
          error: err instanceof Error ? err.message : String(err),
        })
      }

      const wakeSource = new PubWakeSource({
        client,
        agentName: this.options.name,
        pubName: pub.name,
        agent: {
          agent_id: cred.agent_id,
          handle: pubBlock.handle,
          ...(pubBlock.domains.length > 0 ? { domains: [...pubBlock.domains] } : {}),
        },
        taskStore: this.taskStore,
        logger: this.log.child(`wake/${pub.name}`),
        ...(router ? { router, home: this.options.home } : {}),
      })
      wakeSource.start()
      this.pubWakeSources.push(wakeSource)
      this.log.info('pub wake source attached', { pub: pub.name, agent_id: cred.agent_id })
    }
  }

  /**
   * Task poll tick: when no task is in flight, look for a `pending` task in
   * the store and run the loop on it. v1 is single-task; only one task runs
   * at a time per Agent.
   *
   * Errors during a step are logged and the task is marked errored; the loop
   * does not crash the Agent process.
   */
  private async tickTaskPoll(): Promise<void> {
    if (this.isShuttingDown || this.taskInFlight) return
    if (!this.taskStore || !this.loop) return
    let pending
    try {
      pending = await this.taskStore.pickPending()
    } catch (err) {
      this.log.warn('task store read failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }
    if (!pending) return
    this.taskInFlight = true
    const taskId = pending.frontmatter.id
    try {
      await this.taskStore.update(taskId, (fm) => ({ ...fm, state: 'running' }))
      const result = await this.loop.run(pending)
      await this.recordResult(taskId, result)
    } catch (err) {
      this.log.error('loop crashed', {
        task_id: taskId,
        error: err instanceof Error ? err.message : String(err),
      })
      try {
        await this.taskStore.update(taskId, (fm) => ({
          ...fm,
          state: 'errored',
          error: {
            class: err instanceof Error ? err.name : 'UnknownError',
            message: err instanceof Error ? err.message : String(err),
            at: new Date().toISOString(),
          },
          agent_state_at_terminal: this.machine.state,
        }))
      } catch {
        // best-effort
      }
    } finally {
      this.taskInFlight = false
    }
  }

  private async recordResult(taskId: string, result: LoopResult): Promise<void> {
    if (!this.taskStore) return
    if (result.kind === 'done') {
      await this.taskStore.update(taskId, (fm) => ({
        ...fm,
        state: 'done',
        outcome: {
          summary: result.summary,
          at: new Date().toISOString(),
          iterations: result.iterations,
        },
        agent_state_at_terminal: this.machine.state,
      }))
      return
    }
    if (result.kind === 'tripped') {
      // The loop already updated the task to blocked_on_detector and wrote
      // the trip record. Mirror the BLOCKED_ON_DETECTOR state up to the
      // process state machine for the heartbeat to surface.
      try {
        this.machine.transition('blocked_on_detector', `detector ${result.verdict.kind}`)
      } catch {
        // already transitioned
      }
      return
    }
    // errored
    await this.taskStore.update(taskId, (fm) => ({
      ...fm,
      state: 'errored',
      error: {
        class: result.error.class,
        message: result.error.message,
        at: new Date().toISOString(),
      },
      agent_state_at_terminal: this.machine.state,
    }))
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
    if (this.taskPollTimer) {
      clearInterval(this.taskPollTimer)
      this.taskPollTimer = undefined
    }
    // Stop pub wake sources and close their underlying clients.
    for (const ws of this.pubWakeSources) {
      try {
        ws.stop()
      } catch {
        // best-effort
      }
    }
    this.pubWakeSources.length = 0
    for (const client of this.pubClients) {
      try {
        await client.close()
      } catch {
        // best-effort
      }
    }
    this.pubClients.length = 0
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
