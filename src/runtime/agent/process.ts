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
import { connectUds } from '../control-plane/uds-client.js'
import type { Connection } from '../control-plane/transport.js'
import { createLogger, type Logger } from '../util/logger.js'
import { AgentStateMachine } from './state-machine.js'
import { loadIdentity } from '../identity/loader.js'
import { composeModelId, type IdentityRecord } from '../identity/types.js'
import { resolveProvider } from '../llm/registry.js'
import type { LLMProvider } from '../llm/provider.js'
import { agentPaths } from '../storage/layout.js'
import { readAgentPubsFile } from './pubs-file.js'
import { TelemetryWriter } from '../telemetry/writer.js'
import { PulseEmitter } from './pulse/emitter.js'
import { BudgetTracker } from './budget-tracker.js'
import { ToolRegistry } from '../mcp/registry.js'
import { ToolDispatcher } from '../tools/dispatcher.js'
import { BASELINE_TOOL_NAMES, baselineServers } from '../tools/baseline/index.js'
import { platformServers } from '../tools/platform/index.js'
import { McpServerManager } from '../mcp/restart-manager.js'
import { spawnHttpMcpServer, type HttpMcpServerHandle } from '../mcp/http-transport.js'
import { expandToolGrants } from '../mcp/tool-grants.js'
import { emitNotification } from '../notifications/writer.js'
import { resolveSecret } from '../secrets/resolver.js'
import { TaskStore } from './task/store.js'
import type { TaskRecord } from './task/types.js'
import { AgentLoop, type LoopResult } from './loop.js'
import type { AuditFlag } from './audit/narrated-completion.js'
import { runClaimEvidenceAudit } from './audit/claim-evidence.js'
import { appendAuditEntry } from './audit/brain-log.js'
import type { ClaimEvidenceAuditResult, ClaimAuditRecord } from './audit/types.js'
import type { TaskAudit, TaskAuditClaim } from './task/types.js'
import { loadState } from '../supervisor/state.js'
import { credForPub, readCredentialFile } from '../pub/keypair.js'
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
  private pulseEmitter: PulseEmitter | undefined
  private taskInFlight = false
  private readonly pubWakeSources: PubWakeSource[] = []
  private readonly pubClients: PubClient[] = []
  private readonly mcpManagers: McpServerManager[] = []
  private readonly mcpHttpHandles: HttpMcpServerHandle[] = []

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
        home: this.options.home,
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
    // The system server's whoami tool needs a live IdentityGetter. We
    // close over `this.identity` so a future hot-reload of identity
    // (not yet implemented) would propagate without re-registering
    // tools.
    for (const server of baselineServers({
      getIdentity: () => this.identity,
      // The schedule.* tools need the supervisor RPC client.
      // process.start() opens this.client only after register-with-
      // supervisor returns, which happens before any task loop spins
      // up; tools execute in tasks, so by the time a schedule tool
      // fires, this.client is non-undefined.
      getSupervisorRpc: () => this.client,
    })) {
      registry.register(server)
    }

    // Platform tools (Discord, Slack, Spotify). Always registered;
    // each tool resolves its credential lazily and throws a clean
    // "credential missing" error if absent. Per-Agent access is gated
    // by the Identity's `tools:` array, which already supports
    // namespace wildcards (`discord_*`, `slack_*`, `spotify_*`) via
    // `expandToolGrants`. Agents that do not declare a platform
    // wildcard or the exact tool name simply do not see them in
    // `availableToolNames`.
    for (const server of platformServers()) {
      registry.register(server)
    }

    // Spawn declared MCP servers (Epic 9 Phase A) and register their
    // tools. Each `mcp_servers[]` entry resolves its env SecretRefs to
    // literal values before spawn; the literal values do not appear in
    // logs. The first spawn failure aborts Agent start ... the operator
    // fixes the configuration and retries. Mid-session crashes are
    // handled by McpServerManager's locked backoff + notification
    // policy (Epic 9 Phase A spec).
    //
    // Partial-failure cleanup: if the N-th manager.start() throws, the
    // managers we already started (1..N-1) own running child processes
    // that will be orphaned if we just rethrow. Stop each one (best-
    // effort) before letting the error propagate, so AgentProcess.start
    // failure does not leak child processes.
    try {
      for (const spec of this.identity.frontmatter.mcp_servers) {
        if (spec.transport === 'stdio') {
          const env: Record<string, string> = {}
          for (const [varName, secretRef] of Object.entries(spec.env)) {
            env[varName] = await resolveSecret(secretRef, {
              home: this.options.home,
              agentName: this.options.name,
            })
          }
          for (const inheritedVar of ['PATH', 'HOME', 'USER', 'LANG']) {
            const v = process.env[inheritedVar]
            if (v !== undefined && env[inheritedVar] === undefined) {
              env[inheritedVar] = v
            }
          }
          const manager = new McpServerManager({
            serverName: spec.name,
            spawnArgs: {
              name: spec.name,
              command: spec.command,
              args: spec.args,
              env,
            },
            notifier: async ({ tier, body, extras }) => {
              await emitNotification({
                home: this.options.home,
                agentName: this.options.name,
                tier,
                kind: 'mcp.restart',
                body,
                extras,
              })
            },
            logger: this.log.child(`mcp/${spec.name}`),
          })
          this.mcpManagers.push(manager)
          await manager.start()
          registry.register(manager)
          this.log.info('MCP server spawned (stdio)', {
            name: spec.name,
            command: spec.command,
            tools: manager.knownToolNames.length,
          })
        } else {
          // transport === 'http'
          const spawnArgs: Parameters<typeof spawnHttpMcpServer>[0] = {
            name: spec.name,
            url: spec.url,
            extraHeaders: spec.headers,
          }
          if (spec.auth.type === 'bearer') {
            spawnArgs.bearerToken = await resolveSecret(spec.auth.token, {
              home: this.options.home,
              agentName: this.options.name,
            })
          }
          const handle = await spawnHttpMcpServer(spawnArgs)
          this.mcpHttpHandles.push(handle)
          registry.register(handle)
          this.log.info('MCP server connected (http)', {
            name: spec.name,
            url: spec.url,
            tools: handle.tools.size,
            auth: spec.auth.type,
          })
        }
      }
    } catch (err) {
      for (let i = this.mcpManagers.length - 1; i >= 0; i--) {
        const manager = this.mcpManagers[i]
        if (manager === undefined) continue
        try {
          await manager.stop()
        } catch {
          // best-effort
        }
      }
      this.mcpManagers.length = 0
      for (let i = this.mcpHttpHandles.length - 1; i >= 0; i--) {
        const handle = this.mcpHttpHandles[i]
        if (handle === undefined) continue
        try {
          await handle.close()
        } catch {
          // best-effort
        }
      }
      this.mcpHttpHandles.length = 0
      throw err
    }

    // Expand the Identity's `tools:` grants (mix of exact names and
    // `<namespace>.*` wildcards) against the now-fully-populated
    // registry. The dispatcher consumes the resulting concrete set.
    const expandedGrants = expandToolGrants(this.identity.frontmatter.tools, registry.toolNames())
    const allowedToolNames = new Set<string>([...BASELINE_TOOL_NAMES, ...expandedGrants])

    const dispatcher = new ToolDispatcher({
      registry,
      allowedToolNames,
      home: this.options.home,
      callingAgent: this.options.name,
      brainDir: ap.brain,
      projectDir: ap.project,
      logger: this.log.child('dispatcher'),
    })
    this.taskStore = new TaskStore(this.options.home, this.options.name)
    const telemetryWriter = new TelemetryWriter(this.options.home, this.options.name)
    const budgetTracker = new BudgetTracker({
      agentName: this.options.name,
      home: this.options.home,
      capUsd: this.identity.frontmatter.cost_caps.daily_usd,
      warnAtPct: this.identity.frontmatter.cost_caps.warn_at_pct,
      logger: this.log.child('budget'),
    })
    // Replay today's telemetry to recompute cumulative spend before the
    // first task runs. Restart-safe per [[upgrade-readiness]] discipline 3.
    await budgetTracker.init()
    this.pulseEmitter = new PulseEmitter({
      home: this.options.home,
      agentName: this.options.name,
      logger: this.log.child('pulse'),
    })
    this.pulseEmitter.start()
    const { FilesystemSkillProvider } = await import('../skills/provider.js')
    const { resolveRuntimeMode } = await import('../config/runtime-mode.js')
    const runtimeMode = resolveRuntimeMode(process.env)
    // Build native tool-use specs from the registry: one per
    // tool the agent is permitted to call. Providers with native
    // tool-use forward these as `tools: [...]`; providers without
    // ignore them and the loop falls back to fenced-text parsing.
    const { toNativeToolSpecs } = await import('../llm/tool-spec.js')
    const nativeToolSpecs = toNativeToolSpecs(registry, allowedToolNames)

    const conn = this.options.connection ?? (await connectUds(this.options.socketPath))
    this.client = new JsonRpcClient(conn, this.log.child('rpc'))

    this.loop = new AgentLoop({
      identity: this.identity,
      provider: this.provider,
      dispatcher,
      taskStore: this.taskStore,
      home: this.options.home,
      brainDir: ap.brain,
      availableToolNames: [...allowedToolNames],
      nativeToolSpecs,
      logger: this.log.child('loop'),
      telemetryWriter,
      budgetTracker,
      pulseEmitter: this.pulseEmitter,
      skillProvider: new FilesystemSkillProvider(this.options.home),
      runtimeMode,
      // Live tool-event firehose for the web app's ToolStream UI.
      // Fire-and-forget; loop swallows our errors so a dropped
      // supervisor connection cannot stall the task pipeline.
      toolEventEmitter: (event) => {
        const payload = {
          kind: event.kind,
          task_id: event.task_id,
          call_id: event.call_id,
          tool: event.tool,
          ...(event.arg_summary !== undefined ? { arg_summary: event.arg_summary } : {}),
          ...(event.ok !== undefined ? { ok: event.ok } : {}),
          ...(event.error_class !== undefined ? { error_class: event.error_class } : {}),
          ...(event.duration_ms !== undefined ? { duration_ms: event.duration_ms } : {}),
        }
        void this.client?.call('agent.toolEvent', payload).catch(() => {
          /* best-effort */
        })
      },
    })

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

    // Membership resolution order:
    //   1. <home>/agents/<name>/pubs.md (the operational source of
    //      truth, edited by the supervisor's "create studio" flow)
    //   2. identity.md's pub.member_of (back-compat for the seed team)
    //   3. all running pubs (fall-through default)
    let memberOf: string[] | null = null
    try {
      const file = await readAgentPubsFile(
        agentPaths(this.options.home, this.options.name).pubsFile,
      )
      if (file !== null) {
        memberOf = file.pubs
        this.log.info('pub membership sourced from pubs.md', {
          count: memberOf.length,
        })
      }
    } catch (err) {
      this.log.warn('pubs.md unreadable; falling back to identity.pub.member_of', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    memberOf ??= pubBlock.member_of

    const targetPubs =
      memberOf.length > 0 ? allRunning.filter((p) => memberOf.includes(p.name)) : allRunning

    if (targetPubs.length === 0) {
      this.log.info('no running pubs to attach wake sources to', {
        member_of: pubBlock.member_of,
      })
      return
    }

    // Build the ambient-routing Router. Default: use the Agent's own
    // model + provider for routing decisions. Operators can override
    // with ROUTER_PROVIDER + ROUTER_MODEL_ID (e.g. to point all
    // routing at a cheaper Haiku) or disable entirely with
    // ROUTER_DISABLED=true. Without a router, only deterministic
    // directed_to rules wake the Agent ... open-room questions like
    // "guys, what should we test?" never reach anyone.
    const routerDisabled = (process.env['ROUTER_DISABLED'] ?? '').toLowerCase() === 'true'
    const routerProvider =
      process.env['ROUTER_PROVIDER'] ?? this.identity.frontmatter.model.provider
    const routerModelId = process.env['ROUTER_MODEL_ID'] ?? this.identity.frontmatter.model.model_id
    let router: Router | undefined
    if (!routerDisabled) {
      try {
        const provider = await resolveProvider({
          providerName: routerProvider,
          home: this.options.home,
          ...(this.identity.frontmatter.provider_secret &&
          routerProvider === this.identity.frontmatter.model.provider
            ? { secret: this.identity.frontmatter.provider_secret }
            : {}),
        })
        router = new Router({
          provider,
          modelId: routerModelId,
          logger: this.log.child(`router/${routerProvider}`),
        })
        this.log.info('ambient router enabled', {
          provider: routerProvider,
          model_id: routerModelId,
          source:
            process.env['ROUTER_PROVIDER'] || process.env['ROUTER_MODEL_ID']
              ? 'env-override'
              : 'agent-default',
        })
      } catch (err) {
        this.log.warn('router provider build failed; running without router', {
          provider: routerProvider,
          model_id: routerModelId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    } else {
      this.log.info('ambient router disabled (ROUTER_DISABLED=true)')
    }

    for (const pub of targetPubs) {
      const baseUrl = `http://127.0.0.1:${String(pub.port)}`
      // Pick the per-pub agent_id from the cred map (or fall through
      // to the legacy single agent_id field for pre-multi-pub creds).
      const perPubCred = credForPub(cred, pub.name)
      if (!perPubCred.agent_id) {
        this.log.info('Agent has no agent_id registered for this pub; skipping wake source', {
          pub: pub.name,
        })
        continue
      }
      const perPubAgentId = perPubCred.agent_id
      const client = getOrCreatePubClient(this.options.name, pub.name, {
        baseUrl,
        cred: perPubCred,
      })
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
          agent_id: perPubAgentId,
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
          agent_id: perPubAgentId,
          handle: pubBlock.handle,
          ...(pubBlock.domains.length > 0 ? { domains: [...pubBlock.domains] } : {}),
        },
        taskStore: this.taskStore,
        logger: this.log.child(`wake/${pub.name}`),
        ...(router ? { router, home: this.options.home } : {}),
      })
      wakeSource.start()
      this.pubWakeSources.push(wakeSource)
      this.log.info('pub wake source attached', {
        pub: pub.name,
        agent_id: perPubAgentId,
      })
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
      // If the agent's local state machine is in a terminal-stuck
      // state (blocked_on_detector from a prior trip; supervisor's
      // resume RPC marked the task pending again but the agent's
      // own machine never got the memo), the next heartbeat would
      // overwrite the supervisor's `running` back to
      // `blocked_on_detector`. Fix: when picking up a pending task,
      // transition the machine back to running first. This is the
      // missing edge in the resume flow.
      if (this.machine.state === 'blocked_on_detector') {
        try {
          this.machine.transition('running', 'task picked up after resume')
        } catch {
          // illegal transition; carry on, the loop's own state will
          // dominate
        }
      }
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
      // Run the claim-vs-evidence audit BEFORE persisting the task's
      // terminal state so the audit result lands on the same record.
      // Best-effort: any audit failure degrades to a null `audit`
      // field and a brain log line ... never blocks task completion.
      const auditResult = await this.runAuditPass(taskId, result)
      const taskAudit = auditResult ? auditResultToTaskAudit(auditResult) : null
      const updated = await this.taskStore.update(taskId, (fm) => ({
        ...fm,
        state: 'done',
        outcome: {
          summary: result.summary,
          at: new Date().toISOString(),
          iterations: result.iterations,
        },
        audit: taskAudit,
        agent_state_at_terminal: this.machine.state,
      }))
      // Post-task audit notification. Currently only narrated_completion fires
      // here (destructive task ended with no successful tool calls). Tier is
      // `important` ... shows in the operator inbox prominently, does not page.
      if (updated && result.audit_flags.length > 0) {
        for (const flag of result.audit_flags) {
          try {
            await emitNotification({
              home: this.options.home,
              agentName: this.options.name,
              tier: 'important',
              kind: `audit_${flag.kind}`,
              body: this.composeAuditBody(taskId, updated.frontmatter.title, result, flag),
              extras: {
                task_id: taskId,
                audit_flag: flag.kind,
                tool_calls_attempted: flag.attempted,
                tool_calls_succeeded: flag.succeeded,
                iterations: result.iterations,
              },
            })
            this.log.warn('post-task audit flag emitted', {
              task_id: taskId,
              flag: flag.kind,
              attempted: flag.attempted,
              succeeded: flag.succeeded,
            })
          } catch (err) {
            this.log.warn('failed to emit audit notification', {
              task_id: taskId,
              flag: flag.kind,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
      }
      // Claim-vs-evidence audit notification ... fires when severity
      // routes the result above 'silent'. Tier maps directly from the
      // aggregated severity.
      if (updated && auditResult && auditResult.severity !== 'silent') {
        try {
          await emitNotification({
            home: this.options.home,
            agentName: this.options.name,
            tier: severityToTier(auditResult.severity),
            kind: 'audit_claim_evidence',
            body: this.composeClaimEvidenceAuditBody(
              taskId,
              updated.frontmatter.title,
              auditResult,
            ),
            extras: {
              task_id: taskId,
              audit_severity: auditResult.severity,
              audit_summary: auditResult.summary,
              audit_record_count: auditResult.records.length,
            },
          })
          this.log.warn('claim-evidence audit flag emitted', {
            task_id: taskId,
            severity: auditResult.severity,
            summary: auditResult.summary,
          })
        } catch (err) {
          this.log.warn('failed to emit claim-evidence audit notification', {
            task_id: taskId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      if (updated) {
        await this.maybeEmitDelegationCompletion(taskId, updated, 'done', result.summary)
      }
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
      const current = await this.taskStore.get(taskId)
      if (current) {
        await this.maybeEmitDelegationCompletion(
          taskId,
          current,
          'blocked_on_detector',
          `paused on detector ${result.verdict.kind}: ${result.verdict.detail}`,
        )
      }
      return
    }
    // errored
    const erroredTask = await this.taskStore.update(taskId, (fm) => ({
      ...fm,
      state: 'errored',
      error: {
        class: result.error.class,
        message: result.error.message,
        at: new Date().toISOString(),
      },
      agent_state_at_terminal: this.machine.state,
    }))
    if (erroredTask) {
      await this.maybeEmitDelegationCompletion(
        taskId,
        erroredTask,
        'errored',
        `${result.error.class}: ${result.error.message}`,
      )
    }
  }

  /**
   * When a delegated task hits a terminal/paused state, emit a passive-tier
   * completion notification to the originating Agent's inbox so they can
   * pick up the outcome on their next iteration (via notification_*).
   *
   * No-op when the task has no `delegated_by` (it wasn't a delegation).
   * Best-effort: errors are logged but do not block the task transition.
   */
  private async maybeEmitDelegationCompletion(
    taskId: string,
    task: TaskRecord,
    outcomeState: 'done' | 'errored' | 'blocked_on_detector',
    summary: string,
  ): Promise<void> {
    const fm = task.frontmatter
    if (!fm.delegated_by || !fm.delegating_task_id) return
    try {
      const truncated = summary.length > 500 ? `${summary.slice(0, 500)}...` : summary
      await emitNotification({
        home: this.options.home,
        agentName: fm.delegated_by,
        tier: 'passive',
        kind: 'delegation_complete',
        body:
          `Delegated task **${fm.title}** on **${this.options.name}** ` +
          `reached state \`${outcomeState}\`.\n\n` +
          `Originating task: ${fm.delegating_task_id}\n` +
          `Receiving task: ${taskId}\n` +
          `Depth: ${String(fm.delegation_depth)}\n\n` +
          `Outcome:\n\n\`\`\`\n${truncated}\n\`\`\``,
        extras: {
          originator: fm.delegated_by,
          originator_task_id: fm.delegating_task_id,
          target_agent: this.options.name,
          target_task_id: taskId,
          delegation_depth: fm.delegation_depth,
          outcome_state: outcomeState,
        },
      })
      this.log.info('delegation completion notification emitted', {
        target_task_id: taskId,
        originator: fm.delegated_by,
        outcome_state: outcomeState,
      })
    } catch (err) {
      this.log.warn('failed to emit delegation completion notification', {
        target_task_id: taskId,
        originator: fm.delegated_by,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Drive the claim-vs-evidence audit pass for a completed task.
   *
   * Best-effort throughout: any failure (no provider, LLM error,
   * verifier blow-up) returns null so the caller can persist the
   * task with a null audit field. The brain log is written first ...
   * even an empty/all-silent audit gets a log entry so the operator
   * can grep "this task was audited."
   *
   * Skips the audit for `pure` tasks (Q&A) where there's no work to
   * verify. Destructive + checkpointed tasks are the prime targets.
   */
  private async runAuditPass(
    taskId: string,
    result: Extract<LoopResult, { kind: 'done' }>,
  ): Promise<ClaimEvidenceAuditResult | null> {
    if (!this.loop || !this.identity || !this.provider) return null
    const idempotency = await this.taskIdempotency(taskId)
    if (idempotency === 'pure' || idempotency === null) return null
    const events = this.loop.eventLog()
    try {
      // Pick the cheap-tier model for the host's provider. When no
      // cheap mapping exists (unknown provider, custom endpoint slug),
      // fall back to the host's own model id ... the audit costs more
      // but never fails silently because the cheap model didn't exist.
      const cheapModel = auditModelForProvider(this.provider.name)
      const auditModelId =
        cheapModel === 'default' ? this.identity.frontmatter.model.model_id : cheapModel
      const out = await runClaimEvidenceAudit({
        home: this.options.home,
        agentName: this.options.name,
        finalMessage: result.summary,
        destructive: idempotency === 'destructive',
        events,
        provider: this.provider,
        modelId: auditModelId,
        onWarn: (reason, details) => {
          this.log.warn(`audit extraction: ${reason}`, {
            task_id: taskId,
            audit_model: auditModelId,
            ...(details ?? {}),
          })
        },
      })
      // Best-effort brain log append. Failures here are logged but
      // do not affect the audit return.
      try {
        await appendAuditEntry({
          home: this.options.home,
          agentName: this.options.name,
          taskId,
          at: new Date().toISOString(),
          destructive: out.destructive,
          result: out,
        })
      } catch (err) {
        this.log.warn('audit brain log append failed', {
          task_id: taskId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return out
    } catch (err) {
      this.log.warn('claim-evidence audit pass failed', {
        task_id: taskId,
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  }

  private async taskIdempotency(
    taskId: string,
  ): Promise<TaskRecord['frontmatter']['idempotency'] | null> {
    if (!this.taskStore) return null
    const t = await this.taskStore.get(taskId)
    return t?.frontmatter.idempotency ?? null
  }

  private composeClaimEvidenceAuditBody(
    taskId: string,
    taskTitle: string,
    audit: ClaimEvidenceAuditResult,
  ): string {
    const lines: string[] = [
      `Agent: ${this.options.name}`,
      `Task: ${taskId}`,
      `Title: ${taskTitle}`,
      ``,
      `**Audit: ${audit.summary}**`,
      ``,
    ]
    for (const r of audit.records) {
      const marker =
        r.outcome.status === 'verified' ? '✓' : r.outcome.status === 'contradicted' ? '✗' : '⚠'
      const note = r.outcome.status === 'verified' ? r.outcome.evidence : r.outcome.reason
      lines.push(`${marker} ${r.claim.verb} ${r.claim.object}`)
      lines.push(`   ${note}`)
    }
    lines.push(``)
    lines.push(
      `Audit details persist at \`<home>/agents/${this.options.name}/brain/audit-log.md\`.`,
    )
    return lines.join('\n')
  }

  private composeAuditBody(
    taskId: string,
    taskTitle: string,
    result: Extract<LoopResult, { kind: 'done' }>,
    flag: AuditFlag,
  ): string {
    const lines: string[] = [
      `Agent: ${this.options.name}`,
      `Task: ${taskId}`,
      `Title: ${taskTitle}`,
      ``,
      `**Audit flag: ${flag.kind}**`,
      flag.detail,
      ``,
      `Iterations: ${String(result.iterations)}`,
      `Tool calls attempted: ${String(flag.attempted)}`,
      `Tool calls succeeded: ${String(flag.succeeded)}`,
      ``,
      `The task transitioned to \`done\` with an idempotency of \`destructive\`,`,
      `but no tool call returned ok. The agent's final response was:`,
      ``,
      '```',
      result.summary.length > 600 ? `${result.summary.slice(0, 600)}...` : result.summary,
      '```',
      ``,
      `Inspect the task's run records and plan records under the agent's brain`,
      `to confirm whether anything actually changed. If the agent narrated`,
      `completion of work that did not happen, address at the brain-note or`,
      `system-prompt layer.`,
    ]
    return lines.join('\n')
  }

  /**
   * Send a single heartbeat. On RPC failure (typical cause: supervisor
   * bounced and our UDS connection is broken), attempt one reconnect
   * to the socket and re-register. If reconnect succeeds, the next
   * heartbeat tick rolls forward as if nothing happened. If
   * reconnect also fails, log and let the next tick try again ... the
   * supervisor's liveness watcher will eventually flag us if we
   * stay disconnected.
   */
  private async heartbeat(): Promise<void> {
    if (!this.client || this.isShuttingDown) return
    try {
      await this.client.call('agent.heartbeat', { state: this.machine.state })
    } catch (err) {
      this.log.warn('heartbeat failed; attempting reconnect to supervisor', {
        error: err instanceof Error ? err.message : String(err),
      })
      try {
        await this.reconnectToSupervisor()
      } catch (reconnectErr) {
        this.log.warn('supervisor reconnect failed; will retry on next heartbeat', {
          error: reconnectErr instanceof Error ? reconnectErr.message : String(reconnectErr),
        })
      }
    }
  }

  /**
   * Re-open the UDS connection to the supervisor and re-register.
   * Called by the heartbeat when the existing connection breaks.
   * Common cause: the supervisor daemon was restarted (graceful or
   * via SIGKILL) and the previous socket is gone. Without this, the
   * agent process keeps running with a dead RPC channel and the
   * supervisor never sees it again ... the dreaded "supervisor says
   * running but agent is silent" failure mode.
   */
  private async reconnectToSupervisor(): Promise<void> {
    // Drop the old client; node leaves dangling sockets if we don't
    // close them explicitly. The disposed client errors any in-flight
    // calls instead of leaving them hanging.
    if (this.client) {
      try {
        await this.client.close()
      } catch {
        // best-effort; the connection is probably already dead
      }
    }
    const conn = await connectUds(this.options.socketPath)
    this.client = new JsonRpcClient(conn, this.log.child('rpc'))
    const result = await this.client.call('agent.register', {
      name: this.options.name,
      pid: process.pid,
    })
    if (!result.accepted) {
      throw new Error(`supervisor rejected re-registration: ${result.reason ?? 'no reason given'}`)
    }
    this.log.info('supervisor reconnect succeeded; re-registered', {
      name: this.options.name,
      pid: process.pid,
    })
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
    // Stop external MCP servers (Epic 9 Phase A stdio + Phase C http).
    for (const manager of this.mcpManagers) {
      try {
        await manager.stop()
      } catch {
        // best-effort
      }
    }
    this.mcpManagers.length = 0
    for (const handle of this.mcpHttpHandles) {
      try {
        await handle.close()
      } catch {
        // best-effort
      }
    }
    this.mcpHttpHandles.length = 0
    if (this.pulseEmitter) {
      try {
        await this.pulseEmitter.stop()
      } catch {
        // best-effort
      }
      this.pulseEmitter = undefined
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

/**
 * Pick the cheap audit model id for a given host-agent provider. The
 * audit pass needs a low-cost structured-output model; the host
 * agent's frontier model would be overkill (and would scale audit
 * cost linearly with task cost).
 *
 * Default: Anthropic Haiku. Operators who run on a non-Anthropic
 * provider get the closest cheap analogue. Local providers fall back
 * to their own default model_id ... the loop's cheap config is good
 * enough.
 */
function auditModelForProvider(providerName: string): string {
  switch (providerName) {
    case 'anthropic':
      return 'claude-haiku-4-5-20251001'
    case 'deepseek':
      return 'deepseek-chat'
    case 'openai':
      return 'gpt-4.1-mini'
    case 'kimi':
      return 'kimi-k1.5'
    case 'openrouter':
      return 'anthropic/claude-haiku-4-5'
    case 'gemini':
      return 'gemini-2.0-flash-exp'
    case 'xai':
      return 'grok-4-fast'
    case 'local':
      return 'default'
    default:
      // Custom OpenAI-compatible endpoint slug (`endpoint:<id>`) or
      // some future provider. The host's own model_id is the safest
      // fallback ... the audit pays a real-cost call instead of
      // failing silently.
      return 'default'
  }
}

/** Map audit severity to the notifications.tier vocabulary. */
function severityToTier(
  severity: ClaimEvidenceAuditResult['severity'],
): 'passive' | 'normal' | 'important' | 'critical' {
  switch (severity) {
    case 'silent':
      return 'passive'
    case 'passive':
      return 'passive'
    case 'normal':
      return 'normal'
    case 'important':
      return 'important'
  }
}

/**
 * Convert an in-memory ClaimEvidenceAuditResult into the wire-shape
 * TaskAudit that lives in task frontmatter. Flattens the verified /
 * unverified / contradicted `evidence` and `reason` strings into a
 * single `note` field so the wire format stays narrow.
 */
function auditResultToTaskAudit(audit: ClaimEvidenceAuditResult): TaskAudit {
  const claims: TaskAuditClaim[] = audit.records.map((r: ClaimAuditRecord) => {
    const note = r.outcome.status === 'verified' ? r.outcome.evidence : r.outcome.reason
    const out: TaskAuditClaim = {
      category: r.claim.category,
      verb: r.claim.verb,
      object: r.claim.object,
      status: r.outcome.status,
      note,
    }
    if (r.claim.path !== undefined) out.path = r.claim.path
    if (r.claim.tool !== undefined) out.tool = r.claim.tool
    if (r.claim.target !== undefined) out.target = r.claim.target
    if (r.claim.count !== undefined) out.count = r.claim.count
    return out
  })
  return {
    severity: audit.severity,
    summary: audit.summary,
    destructive: audit.destructive,
    at: new Date().toISOString(),
    claims,
  }
}
