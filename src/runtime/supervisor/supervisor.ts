/**
 * The supervisor process.
 *
 * Owns Agent lifecycle: spawn, track, restart, stop. Hosts the control-plane
 * server on a UDS at `<state-dir>/supervisor.sock`. Persists state to
 * `<state-dir>/supervisor.json` after every state change so a restart
 * resumes cleanly per upgrade-readiness #3.
 *
 * Connection-vs-Agent identity: when an Agent process boots and connects to
 * the socket, it sends `agent.register` with its name. The supervisor maps
 * the connection to the named Agent for the duration of that connection.
 * Reconnection (Agent crashes and is restarted) goes through register again.
 */
import { JsonRpcServer, type Handlers, type HandlerContext } from '../control-plane/server.js'
import { listenUds } from '../control-plane/transport-uds.js'
import type { Connection, Listener } from '../control-plane/transport.js'
import { saveState, loadState } from './state.js'
import { type SupervisorState, type AgentRecord } from './types.js'
import { spawnAgent, type SpawnedAgent, type SpawnAgentOptions } from './lifecycle.js'
import { loadIdentity } from '../identity/loader.js'
import { homePaths, agentPaths } from '../storage/layout.js'
import { initHome, initAgentDirs } from '../storage/init.js'
import { createLogger, type Logger } from '../util/logger.js'
import { TaskStore } from '../agent/task/store.js'
import { newPendingTask } from '../agent/task/types.js'
import { newTaskId } from '../util/id.js'
import type { TaskListEntry } from '../control-plane/protocol.js'
import { resetPulseToGreen } from '../agent/detectors/trip-record.js'

export interface SupervisorOptions {
  /** 2200_HOME root per the commons-and-storage-root spec addendum. */
  home: string
  /** Override the bootstrap script path (testing). */
  agentBootstrapPath?: string
  /** Inject a listener (testing); defaults to a UDS listener at <home>/state/supervisor.sock. */
  listener?: Listener
  /** Inject a logger. */
  logger?: Logger
}

export class Supervisor {
  private state: SupervisorState
  private listener: Listener | undefined
  private readonly server: JsonRpcServer
  private readonly connections = new Set<Connection>()
  private readonly agentByConnection = new WeakMap<Connection, string>()
  private readonly spawned = new Map<string, SpawnedAgent>()
  private readonly log: Logger
  private isShuttingDown = false

  private constructor(state: SupervisorState, options: SupervisorOptions) {
    this.state = state
    this.log = options.logger ?? createLogger('supervisor')
    this.server = new JsonRpcServer(this.handlers(), this.log.child('rpc'))
  }

  /**
   * Construct, ensure the 2200_HOME directory layout exists, and load
   * state from disk. Does not start listening yet.
   */
  static async create(options: SupervisorOptions): Promise<Supervisor> {
    await initHome(options.home)
    const state = await loadState(options.home)
    const sup = new Supervisor(state, options)
    await saveState(state)
    return sup
  }

  /** UDS socket path under <home>/state/supervisor.sock. */
  static socketPath(home: string): string {
    return homePaths(home).stateSupervisorSock
  }

  /**
   * Start listening on the control-plane socket. Returns once the socket is
   * bound; does not wait for clients.
   */
  async start(options: SupervisorOptions = { home: this.state.home }): Promise<void> {
    if (this.listener) return
    this.listener = options.listener ?? (await listenUds(Supervisor.socketPath(this.state.home)))
    void this.acceptLoop()
    this.log.info('supervisor listening', {
      home: this.state.home,
      stateDir: this.state.state_dir,
    })
  }

  /**
   * Stop accepting new connections, send agent.stop to every running Agent,
   * persist final state, and clean up. Idempotent.
   */
  async shutdown(timeoutMs = 5000): Promise<void> {
    if (this.isShuttingDown) return
    this.isShuttingDown = true
    this.log.info('supervisor shutting down')
    if (this.listener) {
      await this.listener.close()
      this.listener = undefined
    }
    const stops = Array.from(this.spawned.values()).map(async (sa) => {
      try {
        await sa.stop(timeoutMs)
      } catch (err) {
        this.log.warn('error stopping agent', {
          name: sa.name,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
    await Promise.all(stops)
    for (const conn of this.connections) {
      try {
        await conn.close()
      } catch {
        // best-effort
      }
    }
    await saveState(this.state)
    this.log.info('supervisor stopped')
  }

  /** Read-only snapshot of current state. */
  snapshot(): SupervisorState {
    return JSON.parse(JSON.stringify(this.state)) as SupervisorState
  }

  /**
   * Register a new Agent record. Used by the CLI's `2200 agent create`.
   * Throws if an Agent by that name already exists, or if the Identity
   * file at `sourceIdentityPath` fails validation.
   *
   * Per [[2026-04-26-commons-and-storage-root]], the Identity file is
   * copied into the canonical location at
   * `<home>/agents/<name>/identity.md` on create. After this call the
   * canonical location is the source of truth; the user can edit it
   * there directly and the next `agent start` picks up the change.
   *
   * Identity validation runs against the user-provided source FIRST so a
   * bad Identity surfaces before any directory creation or copy
   * happens.
   */
  async createAgent(name: string, sourceIdentityPath: string): Promise<void> {
    if (this.state.agents[name]) {
      throw new Error(`Agent already exists: ${name}`)
    }
    // Validate the Identity at the source path FIRST. Surfaces malformed
    // YAML, schema mismatches, or missing files before we touch the
    // 2200_HOME directory layout.
    const identity = await loadIdentity(sourceIdentityPath)
    if (identity.frontmatter.agent_name !== name) {
      throw new Error(
        `Identity at ${identity.source_path} declares agent_name "${identity.frontmatter.agent_name}" but you asked to create "${name}". Either rename the Agent or update the Identity.`,
      )
    }
    // Create per-Agent directory layout and copy the Identity into the
    // canonical location. After this, the canonical path is what the
    // supervisor records and what the Agent process loads on start.
    await initAgentDirs(this.state.home, name, identity.source_path)
    const canonical = agentPaths(this.state.home, name).identity
    const record: AgentRecord = {
      name,
      identity_path: canonical,
      state: 'stopped',
      pid: null,
      spawned_at: null,
      last_heartbeat: null,
      errored_at: null,
      errored_reason: null,
      current_task_id: null,
    }
    this.state = {
      ...this.state,
      agents: { ...this.state.agents, [name]: record },
    }
    await saveState(this.state)
    this.log.info('Agent record created', {
      name,
      sourceIdentityPath: identity.source_path,
      canonicalIdentityPath: canonical,
    })
  }

  /** Spawn the Agent process for an existing record. */
  async startAgent(name: string, options: { agentBootstrapPath?: string } = {}): Promise<void> {
    const record = this.state.agents[name]
    if (!record) {
      throw new Error(`no Agent record for ${name}`)
    }
    if (this.spawned.has(name)) {
      throw new Error(`Agent ${name} is already running`)
    }
    const socketPath = Supervisor.socketPath(this.state.home)
    const spawnOpts: SpawnAgentOptions = {
      name,
      identityPath: record.identity_path,
      socketPath,
      home: this.state.home,
      ...(options.agentBootstrapPath ? { bootstrapPath: options.agentBootstrapPath } : {}),
    }
    const spawned = spawnAgent(spawnOpts, this.log.child('lifecycle'))
    this.spawned.set(name, spawned)
    void spawned.exited.then(({ code, signal }) => {
      void this.handleAgentExit(name, code, signal)
    })
    await this.updateAgent(name, {
      pid: spawned.pid,
      spawned_at: new Date().toISOString(),
      state: 'running',
    })
  }

  /** Send `agent.stop` to a running Agent and wait for graceful exit. */
  async stopAgent(name: string, reason = 'user_requested'): Promise<void> {
    const spawned = this.spawned.get(name)
    if (!spawned) {
      // No running process; mark stopped and persist.
      await this.updateAgent(name, { state: 'stopped', pid: null })
      return
    }
    // Send the RPC; the Agent acks and then exits. After the OS process
    // exits, `handleAgentExit` updates the record. If the Agent is
    // unresponsive, `spawned.stop()` falls back to SIGKILL.
    const conn = this.findConnectionFor(name)
    if (conn) {
      try {
        // Best-effort: send the stop notification via the existing client
        // RPC server. We do not use a JsonRpcClient here because the
        // supervisor is the SERVER side of the connection. Sending a
        // request from the server side is reserved for a future change
        // where the supervisor owns a bidirectional client.
        // For v1, the supervisor signals stop by ending the connection
        // and sending SIGTERM to the process.
        await conn.close()
      } catch {
        // ignore
      }
    }
    await spawned.stop()
    await this.updateAgent(name, { state: 'stopped', pid: null })
    this.log.info('Agent stopped', { name, reason })
  }

  // ---------------------------------------------------------------------------
  // Internal: connection accept loop and RPC handlers
  // ---------------------------------------------------------------------------

  private async acceptLoop(): Promise<void> {
    if (!this.listener) return
    for await (const conn of this.listener.connections()) {
      this.connections.add(conn)
      void this.runConnection(conn)
    }
  }

  private async runConnection(conn: Connection): Promise<void> {
    try {
      await this.server.serve(conn)
    } finally {
      const name = this.agentByConnection.get(conn)
      if (name) {
        this.log.debug('Agent connection closed', { name })
      }
      this.connections.delete(conn)
    }
  }

  private handlers(): Handlers {
    return {
      'agent.register': async (params, ctx: HandlerContext) => {
        const record = this.state.agents[params.name]
        if (!record) {
          return {
            accepted: false,
            reason: `no Agent record for ${params.name}; create with '2200 agent create' first`,
          }
        }
        this.agentByConnection.set(ctx.connection, params.name)
        await this.updateAgent(params.name, {
          pid: params.pid,
          last_heartbeat: new Date().toISOString(),
          state: 'running',
        })
        this.log.info('Agent registered', { name: params.name, pid: params.pid })
        return { accepted: true }
      },
      'agent.heartbeat': async (params, ctx: HandlerContext) => {
        const name = this.agentByConnection.get(ctx.connection)
        if (!name) {
          // unregistered connection sending heartbeat
          return { ack: true as const }
        }
        await this.updateAgent(name, {
          state: params.state,
          last_heartbeat: new Date().toISOString(),
        })
        return { ack: true as const }
      },
      'agent.errored': async (params, ctx: HandlerContext) => {
        const name = this.agentByConnection.get(ctx.connection)
        if (name) {
          await this.updateAgent(name, {
            state: 'errored',
            errored_at: new Date().toISOString(),
            errored_reason: params.message,
          })
          this.log.warn('Agent errored', { name, message: params.message })
        }
        return { ack: true as const }
      },
      'agent.stop': () => {
        // Supervisor does not receive `agent.stop` from itself; this is the
        // S→A direction. We register the handler so the schema check passes
        // for tests that exercise it round-trip.
        return { status: 'stopping' as const }
      },
      'state.snapshot': () => {
        return this.snapshot()
      },
      // CLI-facing methods: route mutations through the running daemon so its
      // in-memory state stays consistent. Read-only commands can hit
      // `state.snapshot`; write commands go here.
      'cli.agent.create': async (params) => {
        await this.createAgent(params.name, params.identity_path)
        return { ok: true as const }
      },
      'cli.agent.start': async (params) => {
        await this.startAgent(params.name)
        const record = this.state.agents[params.name]
        if (!record?.pid) {
          throw new Error(`Agent ${params.name} started but no pid recorded`)
        }
        return { ok: true as const, pid: record.pid }
      },
      'cli.agent.stop': async (params) => {
        await this.stopAgent(params.name, params.reason ?? 'cli_request')
        return { ok: true as const }
      },
      'cli.agent.resume': async (params) => {
        const record = this.state.agents[params.name]
        if (!record) {
          throw new Error(`no Agent record for ${params.name}`)
        }
        const store = new TaskStore(this.state.home, params.name)
        // Find a task currently blocked_on_detector and flip it back to
        // pending so the Agent's poll picks it up next tick. v1 is single-task,
        // so at most one task is blocked at any time; if multiple are
        // blocked (an unexpected state), resume the most recently blocked.
        const all = await store.list()
        const blocked = all.filter((t) => t.frontmatter.state === 'blocked_on_detector')
        let resumedId: string | null = null
        if (blocked[0]) {
          const target = blocked[0]
          await store.update(target.frontmatter.id, (fm) => ({
            ...fm,
            state: 'pending',
            detector_block: null,
          }))
          resumedId = target.frontmatter.id
        }
        await resetPulseToGreen({ home: this.state.home, agentName: params.name })
        await this.updateAgent(params.name, { state: 'running' })
        this.log.info('Agent resumed', { name: params.name, resumed_task_id: resumedId })
        return { ok: true as const, resumed_task_id: resumedId }
      },
      'cli.task.submit': async (params) => {
        const record = this.state.agents[params.agent]
        if (!record) {
          throw new Error(`no Agent record for ${params.agent}`)
        }
        const store = new TaskStore(this.state.home, params.agent)
        const task = newPendingTask({
          id: newTaskId(),
          agent: params.agent,
          title: params.title,
          body: params.body,
          ...(params.idempotency ? { idempotency: params.idempotency } : {}),
          ...(params.priority !== undefined ? { priority: params.priority } : {}),
        })
        await store.save(task)
        this.log.info('task submitted', {
          agent: params.agent,
          task_id: task.frontmatter.id,
          title: task.frontmatter.title,
        })
        return { ok: true as const, task_id: task.frontmatter.id }
      },
      'cli.task.list': async (params) => {
        const record = this.state.agents[params.agent]
        if (!record) {
          throw new Error(`no Agent record for ${params.agent}`)
        }
        const store = new TaskStore(this.state.home, params.agent)
        const tasks = await store.list()
        const entries: TaskListEntry[] = tasks.map((t) => ({
          id: t.frontmatter.id,
          state: t.frontmatter.state,
          idempotency: t.frontmatter.idempotency,
          priority: t.frontmatter.priority,
          title: t.frontmatter.title,
          created: t.frontmatter.created,
          detector_block_kind: t.frontmatter.detector_block?.kind ?? null,
          detector_block_detail: t.frontmatter.detector_block?.detail ?? null,
        }))
        return { agent: params.agent, tasks: entries }
      },
    }
  }

  private async handleAgentExit(
    name: string,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    this.spawned.delete(name)
    const record = this.state.agents[name]
    if (!record) return
    if (record.state === 'errored') {
      // Already updated by agent.errored RPC.
      return
    }
    const nextState: AgentRecord['state'] = signal === null && code === 0 ? 'stopped' : 'errored'
    await this.updateAgent(name, {
      state: nextState,
      pid: null,
      errored_at: nextState === 'errored' ? new Date().toISOString() : record.errored_at,
      errored_reason:
        nextState === 'errored'
          ? `process exited code=${String(code)} signal=${String(signal)}`
          : record.errored_reason,
    })
    this.log.info('Agent process exited', { name, code, signal, nextState })
  }

  private findConnectionFor(name: string): Connection | undefined {
    for (const conn of this.connections) {
      if (this.agentByConnection.get(conn) === name) return conn
    }
    return undefined
  }

  private async updateAgent(name: string, patch: Partial<AgentRecord>): Promise<void> {
    const existing = this.state.agents[name]
    if (!existing) return
    const next: AgentRecord = { ...existing, ...patch }
    this.state = {
      ...this.state,
      agents: { ...this.state.agents, [name]: next },
    }
    await saveState(this.state)
  }
}
