/**
 * The supervisor process.
 *
 * Owns Agent lifecycle: start, track, restart, stop. Hosts the control-plane
 * server on a UDS at `<state-dir>/supervisor.sock`. Persists state to
 * `<state-dir>/supervisor.json` after every state change so a restart
 * resumes cleanly per upgrade-readiness #3.
 *
 * Connection-vs-Agent identity: when an Agent process boots and connects to
 * the socket, it sends `agent.register` with its name. The supervisor maps
 * the connection to the named Agent for the duration of that connection.
 * Reconnection (Agent crashes and is restarted) goes through register again.
 */
import { rm, readFile, writeFile } from 'node:fs/promises'
import { applyArchiveEdit, pickArchiveName, renameAgentTrees, todayUtc } from '../agent/archive.js'
import { readAgentPubsFile, writeAgentPubsFile } from '../agent/pubs-file.js'
import { dirname, join } from 'node:path'
import { JsonRpcServer, type Handlers, type HandlerContext } from '../control-plane/server.js'
import { listenUds } from '../control-plane/uds-server.js'
import type { Connection, Listener } from '../control-plane/transport.js'
import { saveState, loadState } from './state.js'
import { type SupervisorState, type AgentRecord, type PubRecord } from './types.js'
import { regenerateFleet } from './fleet.js'
import { regenerateTeamNote, seedStarterPack } from '../onboarding/starter-pack.js'
import {
  launchAgentProcess,
  adoptAgent,
  isPidAlive,
  validateAdoptedProcessArgv,
  defaultBootstrapPath,
  type TrackedAgent,
  type StartAgentOptions,
} from './lifecycle.js'
import { isLockHeld } from './process-lock.js'
import { launchPubProcess, composePubMd, type StartedPub } from './pub-lifecycle.js'
import { resolveFleetDefaults } from '../config/fleet-defaults.js'
import { loadIdentity, writeIdentity } from '../identity/loader.js'
import type { AgentPubBlock, IdentityFrontmatter } from '../identity/types.js'
import { homePaths, agentPaths, pubPaths, assertPubName } from '../storage/layout.js'
import { initHome, initAgentDirs, initPubDirs } from '../storage/init.js'
import { createLogger, type Logger } from '../util/logger.js'
import { TaskStore } from '../agent/task/store.js'
import { buildTimeoutContinuationSection } from '../agent/task/continuation.js'
import { newPendingTask } from '../agent/task/types.js'
import { newTaskId } from '../util/id.js'
import { findFreePort } from '../util/free-port.js'
import type { TaskListEntry, PubListEntry, StateSnapshotResult } from '../control-plane/protocol.js'
import { resetPulseToGreen } from '../agent/detectors/trip-record.js'
import { writeCredentialFile, readCredentialFile } from '../pub/keypair.js'
import { generateKeypair } from '../pub/keypair-generate.js'
import {
  createIdentityClient,
  ensureRegistered,
  type IdentityClient,
} from '../pub/identity-client.js'
import { loadUserIdentityIfExists, writeUserIdentity } from '../user/loader.js'
import type { UserIdentityFrontmatter } from '../user/types.js'
import { generatePubSecrets, readPubSecrets, writePubSecrets } from '../pub/secrets.js'
import { upsertRosterEntry } from '../pub/roster.js'
import {
  createSchedule as persistCreateSchedule,
  deleteSchedule as persistDeleteSchedule,
  listSchedules as persistListSchedules,
  setScheduleEnabled as persistSetScheduleEnabled,
  type ScheduleEntry,
} from '../scheduler/schedule.js'
import { Scheduler } from '../scheduler/service.js'
import { TokenRefreshService } from '../oauth/refresh-service.js'
import type { ScheduleListEntry } from '../control-plane/protocol.js'
import { startHttpServer, type HttpServerHandle, type WsEvent } from '../http/server.js'
import { DEFAULT_RUNTIME_MODE, type RuntimeMode } from '../config/runtime-mode.js'
import {
  ConnectorAuditEmitter,
  deleteBearer,
  hasBearer,
  mintBearerToken,
  readBearer,
  saveBearer,
  startConnectorListener,
  type ConnectorListenerHandle,
} from '../mcp/connector/index.js'
import { SynthesisReconciler } from '../mcp/connector/synthesis-reconciler.js'
import { updateAnchorFrontmatter } from '../mcp/connector/synthesis.js'
import {
  newWorkPackageId,
  patchPackageFrontmatter,
  readWorkPackage,
  workPackageSlug,
  writeProposedPackage,
  type ProposedWorkPackage,
} from '../mcp/connector/work-package.js'
import {
  listClients as listOAuthClients,
  markRevoked as markOAuthClientRevoked,
  readClient as readOAuthClient,
  registerClient as registerOAuthClient,
  rotateClientSecret as rotateOAuthClientSecret,
} from '../mcp/connector/oauth/client-store.js'
import { revokeClientTokens as revokeOAuthClientTokens } from '../mcp/connector/oauth/token-store.js'
import {
  listConduits,
  markRetired as markConduitRetired,
  readConduit,
  regenerateConduitsIndex,
  writeConduit,
} from '../mcp/connector/embassy/conduits.js'
import { deleteApproval, readApproval } from '../mcp/connector/embassy/shelf/approval-store.js'
import { writeShelfItem } from '../mcp/connector/embassy/shelf/store.js'
import { newShelfItemId, type ShelfItemFrontmatter } from '../mcp/connector/embassy/shelf/types.js'
import {
  buildConduitRecord,
  buildDedicatedSourceIdentity,
  initEmbassyBrainDirs,
  patchIdentityWithEmbassyBlock,
} from '../mcp/connector/embassy/registration.js'
import type { ConduitRecord } from '../mcp/connector/embassy/types.js'
import { PulseWatcher } from '../agent/pulse/watcher.js'
import { OnboardingSessionStore } from '../onboarding/session-store.js'
import { CredentialRequestStore } from '../credentials/requests.js'
import { toEnvelopeV1 as toCredentialRequestEnvelopeV1 } from '../credentials/request-types.js'

/**
 * Strip the `-archived-<YYYY-MM-DD>[-N]` suffix from an archived
 * agent's name. Returns the stripped name if the suffix matches,
 * otherwise the input unchanged. Used by `unarchiveAgent` to compute
 * the default restore target.
 */
function stripArchiveSuffix(name: string): string {
  const m = /^(.+)-archived-\d{4}-\d{2}-\d{2}(?:-\d+)?$/.exec(name)
  return m?.[1] ?? name
}

/**
 * Strict allowlist for `standing_brief_synthesis` tasks. The
 * synthesizing Agent reads the chronological log from the shared
 * brain and writes the synthesized brief via the dedicated
 * `brain_write_research_brief` tool. Nothing else.
 *
 * **Additions to this list require explicit review** (Grok lock,
 * 2026-05-23): every new shared-brain or write tool must be
 * consciously evaluated for whether it belongs here. The whole
 * point of the strict-allowlist mechanism is that this list cannot
 * silently grow.
 */
export const STANDING_BRIEF_SYNTHESIS_ALLOWED_TOOLS = [
  'brain_read_shared',
  'brain_search_shared',
  'brain_list_shared',
  'brain_write_research_brief',
] as const

/**
 * Strict allowlist for `work_package_coordination` tasks. The
 * primary Agent assembles a reviewable plan from the proposed work
 * package: read the package + (optionally) collaborate via pub,
 * then write the plan back into the same shared-brain note.
 *
 * **Additions require explicit review** (Grok lock, 2026-05-23).
 * No execution tools. No schedule tools. No task tools. No
 * per-Agent brain writes. No fs/shell/agent-creation/notification.
 * The whole product-safety story of the connector lives or dies on
 * this list staying narrow.
 */
export const WORK_PACKAGE_COORDINATION_ALLOWED_TOOLS = [
  'brain_read_shared',
  'brain_search_shared',
  'brain_list_shared',
  'brain_write_shared',
  'pub_post',
  'pub_read',
] as const

function renderWorkPackageCoordinationTaskBody(packageId: string): string {
  return [
    `A work package has been proposed by an MCP connector caller.`,
    `Package id: ${packageId}`,
    `Read the package note with \`brain_read_shared\` at slug \`work-package-${packageId}\`.`,
    '',
    `YOUR JOB: produce a reviewable plan and write it back into the package note via \`brain_write_shared\` (use the same slug). You may collaborate with peers via \`pub_post\` / \`pub_read\` if the package's complexity warrants it.`,
    '',
    'HARD CONSTRAINTS (enforced by the dispatcher; violations will fail):',
    '- You may ONLY call: brain_read_shared, brain_search_shared, brain_list_shared, brain_write_shared, pub_post, pub_read.',
    '- You may NOT call any execution tool, schedule tool, task tool, agent tool, fs tool, shell tool, or notification tool.',
    '- DO NOT submit follow-up tasks. DO NOT create schedules. DO NOT spawn Agents. DO NOT call external tools.',
    '',
    'Output: rewrite the package note so the existing pending sections are filled in. The full body should remain readable as a single document; preserve the original proposal above your additions.',
    '',
    '## Plan',
    '## Risks',
    '## Success criteria',
    '## Estimated cost / budget impact',
    '## Internal coordination log',
    '   (peers consulted + their input, or "none" if the package was simple enough to plan alone)',
    '',
    'When the plan is written, the package automatically becomes `reviewable`. The operator approves it (or rejects it) through the Inbox / CLI. ONLY operator approval routes the plan to real execution.',
  ].join('\n')
}

/** Parse `- ` bulleted steps under the `## Plan` heading. */
function parsePlanSteps(body: string): string[] {
  const planIdx = body.search(/^##\s+Plan\s*$/m)
  if (planIdx === -1) return []
  const rest = body.slice(planIdx)
  // Capture lines until the next `##` heading (or end of string).
  const sectionMatch = /^##\s+Plan\s*$([\s\S]*?)(?=^##\s+|$(?![\s\S]))/m.exec(rest)
  if (sectionMatch?.[1] === undefined) return []
  const section = sectionMatch[1]
  const steps: string[] = []
  for (const raw of section.split('\n')) {
    const m = /^\s*-\s+(.+)$/.exec(raw)
    if (m?.[1] !== undefined) {
      const text = m[1].trim()
      if (text.length > 0 && !text.startsWith('_')) steps.push(text)
    }
  }
  return steps
}

function renderSynthesisTaskBody(args: {
  threadSlug: string
  pendingSynthesisAt: string
  budgetUsd: number
}): string {
  return [
    `Synthesize the standing brief for research thread \`${args.threadSlug}\`.`,
    '',
    `The chronological contribution log lives at \`<shared>/brain/research-${args.threadSlug}.md\`. Read it with \`brain_read_shared\`, then write the synthesized brief via \`brain_write_research_brief\` with thread_slug \`${args.threadSlug}\`.`,
    '',
    'The brief should be a current-state summary, not a chronicle. Suggested structure (deviate where it helps):',
    '',
    '  ## Current state',
    '  ## Open questions',
    '  ## Recent direction',
    '  ## Next steps',
    '',
    `Cite contribution timestamps for any claims drawn from specific contributions. The thread is currently pending synthesis through ${args.pendingSynthesisAt}.`,
    '',
    `Budget cap for this task: $${args.budgetUsd.toFixed(2)}.`,
  ].join('\n')
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1'])

/** True iff `host` resolves to a loopback address by name. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase())
}

/**
 * Emit a `normal`-tier Inbox event when the web UI listener is bound
 * to a non-loopback host. The MCP-connector security model assumes
 * the web UI (with its session-bearer + connector-management routes)
 * is loopback-only; the connector listener on a separate port is the
 * intended public-facing surface.
 *
 * Best-effort: a failed notification write must not prevent the
 * supervisor from coming up.
 */
async function warnWebHostNonLoopback(args: {
  home: string
  host: string
  port: number
  logger: Logger
}): Promise<void> {
  args.logger.warn('web UI listener bound to non-loopback host', {
    host: args.host,
    port: args.port,
  })
  try {
    const { emitNotification } = await import('../notifications/writer.js')
    await emitNotification({
      home: args.home,
      agentName: '__connector',
      tier: 'normal',
      kind: 'connector.web_host_non_loopback',
      body:
        `The web UI listener is bound to **${args.host}:${String(args.port)}**, which is not a ` +
        `loopback address. The MCP-connector security model assumes the web UI is loopback-only ` +
        `(use the dedicated connector listener on the configured port for remote access).\n\n` +
        `If this was deliberate, you can ignore this. To revert, unset ` +
        `\`TWENTYTWOHUNDRED_WEB_HOST\` and restart the daemon.`,
      extras: {
        web_host: args.host,
        web_port: args.port,
      },
    })
  } catch {
    // best-effort; do not break boot
  }
}

export interface SupervisorOptions {
  /** 2200_HOME root per the commons-and-storage-root spec addendum. */
  home: string
  /** Override the bootstrap script path (testing). */
  agentBootstrapPath?: string
  /** Inject a listener (testing); defaults to a UDS listener at <home>/state/supervisor.sock. */
  listener?: Listener
  /** Inject a logger. */
  logger?: Logger
  /**
   * Web HTTP server config. Omit to skip the HTTP server entirely
   * (default for tests). Production bootstrap sets `{ port, host }`.
   */
  web?: {
    port: number
    host: string
  }
  /**
   * MCP connector listener config. Omit to skip the connector entirely
   * (default for tests). Production bootstrap sets `{ port }`; the
   * listener only actually binds if a bearer is present in the sealed
   * vault. CLI `2200 connector token regenerate` is what provisions
   * the bearer.
   *
   * `bodyLimitBytes` is the public-internet-facing operator escape
   * hatch for large `contribute_to_thread` payloads (research blobs,
   * long transcripts). Default 8 MiB. Larger = larger DoS surface;
   * see the as-shipped decision record.
   */
  connector?: {
    port: number
    bodyLimitBytes?: number
  }
  /**
   * On boot, walk on-disk state and revive previously-running pubs
   * (after killing any port-holding orphans) and restart agents
   * that were running. Default false ... only the production
   * daemon bootstrap opts in. Tests construct Supervisors against
   * leftover on-disk state without expecting child processes to
   * appear; flipping this on would fork those children and trip
   * the test pool.
   */
  recoverFromState?: boolean
  /**
   * Deployment tier this Supervisor is running in (Epic 17 substrate;
   * see [[../../wiki/decisions/2026-05-05-managed-service]] and
   * [[../../wiki/conventions/security-architecture-hosted-mode]]).
   *
   * Defaults to `self-hosted` when omitted; production daemon-start
   * resolves the value from the `TWENTYTWOHUNDRED_RUNTIME_MODE` env
   * var via `resolveRuntimeMode`. Tests can override directly.
   *
   * v1 ships only `self-hosted` as a real deployment; the other
   * values are accepted so the runtime substrate is in place for
   * Epic 17 (proxy provider binding, system-prompt clarification,
   * starter-inference rate limits) without a substrate change at
   * that time.
   */
  runtimeMode?: RuntimeMode
}

export class Supervisor {
  private state: SupervisorState
  private listener: Listener | undefined
  private readonly server: JsonRpcServer
  private readonly connections = new Set<Connection>()
  private readonly agentByConnection = new WeakMap<Connection, string>()
  private readonly tracked = new Map<string, TrackedAgent>()
  private readonly trackedPubs = new Map<string, StartedPub>()
  /**
   * Names of Agents whose current process exit is the result of an
   * operator-initiated stop (via `stopAgent`). The auto-restart path in
   * `handleAgentExit` checks this set to distinguish "process died
   * unexpectedly, supervisor should restart it" from "we asked it to
   * stop, leave it stopped".
   *
   * Add on stopAgent entry; remove after the post-stop state update.
   */
  private readonly intentionalStops = new Set<string>()
  /**
   * Per-Agent restart timestamps (epoch ms), capped to the last 3. Used
   * to enforce a crash-restart budget: if an Agent has been restarted 3
   * times in the last 60s, the 4th unexpected exit transitions it to
   * `errored` instead of restarting again. Prevents start-crash-start
   * tight loops from burning resources.
   */
  private readonly restartHistory = new Map<string, number[]>()
  /**
   * One PulseWatcher per running Agent (Epic 15 PulseDot live-feed).
   * Started when the agent is launched, stopped when the agent exits
   * or the supervisor shuts down. The watcher polls `pulse.json` and
   * forwards changes to the WS broadcast so connected web clients
   * see the dot animate without polling.
   */
  private readonly pulseWatchers = new Map<string, PulseWatcher>()
  /**
   * Pubs whose exit was initiated by the supervisor (via `stopPub` or
   * `shutdown`). Distinguishes user-initiated exit (final state =
   * 'stopped') from a crash (final state = 'errored'). Cleared when
   * the exit handler observes the entry.
   *
   * Without this flag, `handlePubExit` cannot tell whether a child
   * exit was unsolicited or requested, since `state.pubs[name].state`
   * is `'stopped'` in both cases (initial-create or stop-requested).
   */
  private readonly pubStopRequested = new Set<string>()
  private readonly log: Logger
  private isShuttingDown = false
  /** Fire-and-forget startup work (fleet regen, brain seed) that must
   * settle before shutdown closes the brain DB handles. Tracked so a
   * fast shutdown doesn't race the post-start work and surface
   * "database connection is not open" warnings. */
  private startupTasks: Promise<void>[] = []
  /**
   * Periodic timer that scans state.agents for dead PIDs. Transitions
   * silently-dead agents (running on disk, PID gone in OS) to errored
   * so the fleet view reflects truth and the operator gets the
   * surface to recover. Without this, an agent process can die from
   * an unhandled exception and the supervisor reports "running"
   * forever (the OpenClaw-tier brittleness Doug called out).
   */
  private livenessTimer: NodeJS.Timeout | undefined
  private credentialRequestSweeperTimer: NodeJS.Timeout | undefined
  private waitForSweeperTimer: NodeJS.Timeout | undefined
  private readonly scheduler: Scheduler
  private readonly tokenRefresh: TokenRefreshService
  private readonly onboardingSessions: OnboardingSessionStore
  private webHandle: { stop: () => Promise<void>; broadcast: (e: WsEvent) => void } | undefined
  private readonly webConfig: SupervisorOptions['web']
  private readonly connectorConfig: SupervisorOptions['connector']
  private connectorHandle: ConnectorListenerHandle | undefined
  private connectorAudit: ConnectorAuditEmitter | undefined
  private synthesisReconciler: SynthesisReconciler | undefined
  private connectorOutcomeWatcherTimer: ReturnType<typeof setInterval> | undefined
  /**
   * Work-package coordination tasks the supervisor is awaiting
   * terminal transitions on. Mirrors the synthesis-reconciler's own
   * inflight tracking; the supervisor's outcome watcher polls task
   * state every 30 s and dispatches `done`/`errored` to the right
   * handler (the reconciler's `observeTaskOutcome` for synthesis;
   * inline plan-ready / coordination-failed events here for work
   * packages).
   */
  private readonly workPackageCoordinationTasks = new Map<
    string,
    { packageId: string; primaryAgent: string }
  >()
  private readonly runtimeMode: RuntimeMode

  private constructor(state: SupervisorState, options: SupervisorOptions) {
    this.state = state
    this.log = options.logger ?? createLogger('supervisor')
    this.server = new JsonRpcServer(this.handlers(), this.log.child('rpc'))
    this.scheduler = new Scheduler({
      home: state.home,
      logger: this.log.child('scheduler'),
    })
    this.tokenRefresh = new TokenRefreshService({
      home: state.home,
      logger: this.log.child('oauth-refresh'),
      // When the fleet subscription token refreshes, the long-running
      // pub-server still holds the bearer it got at spawn. Restart running
      // pubs so they pick up the fresh credential (else the bartender +
      // fragment-gen 401 again ~6h after launch and re-destabilize agents).
      onFleetTokenRefreshed: () => {
        void this.restartRunningPubsForFreshFleetToken()
      },
    })
    this.onboardingSessions = new OnboardingSessionStore({
      logger: this.log.child('onboarding'),
    })
    this.webConfig = options.web
    this.connectorConfig = options.connector
    this.runtimeMode = options.runtimeMode ?? DEFAULT_RUNTIME_MODE
  }

  /**
   * The deployment tier this Supervisor is running in. Read by Agent
   * subprocess launch so the AgentLoop can branch on it (Epic 17
   * substrate); read by the daemon for startup logging.
   */
  getRuntimeMode(): RuntimeMode {
    return this.runtimeMode
  }

  /**
   * The shared onboarding-session store. Used by the HTTP server to
   * back the Card Stack onboarding flow's `POST /api/v1/onboarding/...`
   * endpoints. In-memory only ... a supervisor restart drops every
   * in-flight interview, matching the CLI's `Ctrl-C aborts the build`
   * behavior.
   */
  /**
   * Expose the supervisor's Scheduler so the HTTP server can request
   * a reload after a schedule mutation lands on disk. The CLI uses
   * the same surface via the `cli.scheduler.reload` RPC.
   */
  getScheduler(): Scheduler {
    return this.scheduler
  }

  getOnboardingSessions(): OnboardingSessionStore {
    return this.onboardingSessions
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
    await this.scheduler.start()
    this.tokenRefresh.start()
    this.onboardingSessions.start()
    if (this.webConfig) {
      try {
        const handle: HttpServerHandle = await startHttpServer({
          supervisor: this,
          home: this.state.home,
          port: this.webConfig.port,
          host: this.webConfig.host,
          logger: this.log.child('http'),
        })
        this.webHandle = handle
        this.log.info('http server listening', { url: handle.url })
      } catch (err) {
        this.log.warn('http server failed to start', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
      // Safety check: if an operator set TWENTYTWOHUNDRED_WEB_HOST to
      // something non-loopback, the web UI (with its session-bearer,
      // not the MCP connector bearer) is now reachable from the
      // network. The MCP-connector design assumes the web UI is
      // loopback-bound; surface this loudly so the operator either
      // reverts or knows they've widened the surface deliberately.
      // The connector listener has its own bearer and remains the
      // intended public-facing surface.
      if (!isLoopbackHost(this.webConfig.host)) {
        void warnWebHostNonLoopback({
          home: this.state.home,
          host: this.webConfig.host,
          port: this.webConfig.port,
          logger: this.log,
        })
      }
    }
    if (this.connectorConfig) {
      this.connectorAudit = new ConnectorAuditEmitter({ home: this.state.home })
      // Standing-brief synthesis reconciler runs whenever the connector
      // is configured (even if no bearer is provisioned yet) ... it
      // reconciles existing threads, which can exist before the user
      // pastes their first connector bearer if the operator created a
      // thread via a future CLI / other path.
      this.synthesisReconciler = new SynthesisReconciler({
        home: this.state.home,
        audit: this.connectorAudit,
        isAgentRunning: (name: string) => this.state.agents[name]?.state === 'running',
        submitSynthesisTask: (args) => this.submitSynthesisTask(args),
        logger: this.log.child('synthesis-reconciler'),
      })
      this.synthesisReconciler.start()
      // Outcome watcher: polls every 30 s for terminal transitions of
      // synthesis / work-package coordination tasks and routes them to
      // the right observer. Lightweight; runs only when the connector
      // is configured.
      this.connectorOutcomeWatcherTimer = setInterval(() => {
        void this.pollConnectorTaskOutcomes().catch((err: unknown) => {
          this.log.warn('connector outcome watcher tick failed', {
            error: err instanceof Error ? err.message : String(err),
          })
        })
      }, 30_000)
      this.connectorOutcomeWatcherTimer.unref()
      // The listener only binds if a bearer is already provisioned.
      // First-run sees no bearer; the listener stays down until the
      // operator runs `2200 connector token regenerate`.
      if (await hasBearer(this.state.home)) {
        try {
          this.connectorHandle = await startConnectorListener({
            home: this.state.home,
            port: this.connectorConfig.port,
            audit: this.connectorAudit,
            ...(this.connectorConfig.bodyLimitBytes !== undefined
              ? { bodyLimitBytes: this.connectorConfig.bodyLimitBytes }
              : {}),
            serverDeps: this.connectorServerDeps(),
          })
          this.log.info('connector listener listening', {
            port: this.connectorHandle.port,
          })
        } catch (err) {
          this.log.warn('connector listener failed to start', {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      } else {
        this.log.info('connector listener idle (no bearer in vault)')
      }
    }
    this.log.info('supervisor listening', {
      home: this.state.home,
      stateDir: this.state.state_dir,
      runtime_mode: this.runtimeMode,
    })
    // Recover from the previous incarnation: revive pubs and
    // restart agents that were running. Off by default so tests
    // that construct a Supervisor don't accidentally fork child
    // processes from leftover on-disk state. Production bootstrap
    // opts in (`recoverFromState: true`).
    if (options.recoverFromState === true) {
      // Ensure the default "studio" pub exists with every Agent enrolled BEFORE
      // reviving Agents, so they attach the studio wake source on their first
      // start (no double-restart, no race). Best-effort: never throws.
      await this.ensureStudioPub()
      void this.recoverFromState()
    }
    // Regenerate Fleet.md at boot so agents that come online during
    // start-up see a fresh fleet, not whatever was on disk from the
    // last shutdown. The lifecycle hooks keep it current after that.
    // Same call also rewrites the shared brain's "team" note.
    this.startupTasks.push(this.regenerateFleetSafe())
    // Seed the platform overview into the shared brain on first
    // boot. Idempotent ... if the note already exists, no-op. The
    // operator (or any Agent) is free to edit it like any other
    // markdown note; we don't overwrite their edits.
    this.startupTasks.push(this.seedSharedBrainSafe())
    // Liveness watcher: every 30s, scan state.agents for dead PIDs
    // and transition silently-dead agents to errored. Fixes the
    // OpenClaw-tier "supervisor reports running while the agent
    // process is gone" failure mode.
    this.startLivenessWatcher()
    // Credential-request sweeper: every 30s, expire pending requests
    // whose expires_at has passed. Decoupled from the running Agent's
    // own timeout fallback so requests left behind by a crashed Agent
    // still transition to expired and surface in the operator UI.
    this.startCredentialRequestSweeper()
    // One-shot sweep at boot: cover any requests that expired while
    // the supervisor was down. Async; intentional fire-and-forget.
    this.startupTasks.push(this.sweepCredentialRequestsOnce())
    // Wait-for sweeper: every 30s, scan every Agent's tasks for
    // wait_for blocks whose expires_at has passed. Resume those
    // tasks with a "no response" continuation so the Agent can
    // decide whether to give up, retry, or report the timeout.
    // Decision: 2026-05-16-task-continuation-primitive.
    this.startWaitForSweeper()
    this.startupTasks.push(this.sweepWaitForOnce())
  }

  /**
   * Start the liveness watcher: a 30-second tick that walks every
   * Agent record in state and verifies its PID is still alive.
   * Agents whose state is `running`/`waiting` but whose PID has
   * exited (or never existed) are transitioned to `errored` so the
   * fleet view reflects truth and the operator gets the surface
   * to recover.
   */
  private startLivenessWatcher(): void {
    if (this.livenessTimer) return
    const tick = (): void => {
      void this.scanAgentLiveness().catch((err: unknown) => {
        this.log.warn('liveness scan failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }
    this.livenessTimer = setInterval(tick, 30_000)
    if (typeof this.livenessTimer === 'object' && 'unref' in this.livenessTimer) {
      this.livenessTimer.unref()
    }
  }

  private async scanAgentLiveness(): Promise<void> {
    if (this.isShuttingDown) return
    for (const [name, record] of Object.entries(this.state.agents)) {
      if (record.state !== 'running' && record.state !== 'waiting') continue
      if (record.pid === null) continue
      // Lock-based liveness check on the Agent's PID file.
      // Hazard-free: a recycled PID owned by an unrelated process
      // cannot fake holdership of our lockfile.
      if (await isLockHeld(agentPaths(this.state.home, name).pidFile)) continue
      this.log.warn('agent process is dead but state says running; transitioning to errored', {
        name,
        pid: record.pid,
        last_heartbeat: record.last_heartbeat,
      })
      this.tracked.delete(name)
      this.stopPulseWatcher(name)
      const errored: AgentRecord = {
        ...record,
        state: 'errored',
        pid: null,
        errored_at: new Date().toISOString(),
        errored_reason:
          'supervisor liveness check found dead PID; agent process exited without notifying',
      }
      this.state = {
        ...this.state,
        agents: { ...this.state.agents, [name]: errored },
      }
      await saveState(this.state)
      if (this.webHandle) {
        this.webHandle.broadcast({
          event: 'agent.state_changed',
          payload: { agent: name, state: 'errored' },
        })
      }
      // Sweep any credential requests this Agent left pending so the
      // operator UI doesn't keep showing live paste cards for a dead
      // recipient. expired_reason 'agent_crashed' surfaces a distinct
      // operator-facing state from a vanilla timeout.
      void this.sweepCredentialRequestsForAgent(name, 'agent_crashed').catch((err: unknown) => {
        this.log.warn('credential-request sweep on crash failed', {
          agent: name,
          error: err instanceof Error ? err.message : String(err),
        })
      })
      void this.regenerateFleetSafe()
    }
  }

  /**
   * Start the credential-request sweeper. Mirrors the liveness watcher:
   * 30-second tick, off-loop, errors are logged but never throw. The
   * supervisor restart path is handled by a one-shot sweep call at
   * startup; this interval covers the steady-state case where an Agent
   * dispatches a request and the 5-min timeout elapses before any
   * operator resolution arrives.
   */
  private startCredentialRequestSweeper(): void {
    if (this.credentialRequestSweeperTimer) return
    const tick = (): void => {
      void this.sweepCredentialRequestsOnce().catch((err: unknown) => {
        this.log.warn('credential-request sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }
    this.credentialRequestSweeperTimer = setInterval(tick, 30_000)
    if (
      typeof this.credentialRequestSweeperTimer === 'object' &&
      'unref' in this.credentialRequestSweeperTimer
    ) {
      this.credentialRequestSweeperTimer.unref()
    }
  }

  /**
   * Scan every pending credential request and transition the ones whose
   * `expires_at` has passed to `expired` with reason `timeout`. Broadcast
   * an expire event so connected operator UIs update.
   */
  private async sweepCredentialRequestsOnce(): Promise<void> {
    if (this.isShuttingDown) return
    const store = new CredentialRequestStore(this.state.home)
    const pending = await store.list({ state: 'pending' })
    const nowMs = Date.now()
    for (const rec of pending) {
      if (Date.parse(rec.expires_at) > nowMs) continue
      const now = new Date().toISOString()
      try {
        const updated = await store.transition(rec.id, 'expired', {
          now,
          expired_reason: 'timeout',
        })
        if (this.webHandle) {
          this.webHandle.broadcast({
            event: 'credential_request.expired',
            payload: {
              agent: updated.agent,
              chat_id: updated.chat_id,
              request_id: updated.id,
              expired_at: updated.expired_at ?? now,
              expired_reason: updated.expired_reason ?? 'timeout',
              envelope: toCredentialRequestEnvelopeV1(updated),
            },
          })
        }
      } catch (err) {
        // Lost race to the in-process tool or another sweep; safe to
        // skip. The record's terminal state stands.
        this.log.debug('credential-request sweep transition skipped', {
          request_id: rec.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  /**
   * Sweep an Agent's pending requests with a specific expired_reason
   * (used by the crash- and archive-detection paths).
   */
  private async sweepCredentialRequestsForAgent(
    agentName: string,
    reason: 'agent_crashed' | 'agent_archived',
  ): Promise<void> {
    const store = new CredentialRequestStore(this.state.home)
    const pending = await store.list({ agent: agentName, state: 'pending' })
    for (const rec of pending) {
      const now = new Date().toISOString()
      try {
        const updated = await store.transition(rec.id, 'expired', {
          now,
          expired_reason: reason,
        })
        if (this.webHandle) {
          this.webHandle.broadcast({
            event: 'credential_request.expired',
            payload: {
              agent: updated.agent,
              chat_id: updated.chat_id,
              request_id: updated.id,
              expired_at: updated.expired_at ?? now,
              expired_reason: updated.expired_reason ?? reason,
              envelope: toCredentialRequestEnvelopeV1(updated),
            },
          })
        }
      } catch {
        // Lost a race; ignore.
      }
    }
  }

  /**
   * Start the wait-for sweeper. Mirrors the credential-request
   * sweeper: 30-second tick, off-loop, errors are logged but never
   * throw. Decision: 2026-05-16-task-continuation-primitive.
   */
  private startWaitForSweeper(): void {
    if (this.waitForSweeperTimer) return
    const tick = (): void => {
      void this.sweepWaitForOnce().catch((err: unknown) => {
        this.log.warn('wait_for sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }
    this.waitForSweeperTimer = setInterval(tick, 30_000)
    if (typeof this.waitForSweeperTimer === 'object' && 'unref' in this.waitForSweeperTimer) {
      this.waitForSweeperTimer.unref()
    }
  }

  /**
   * Scan every Agent's tasks for wait_for blocks whose `expires_at`
   * has passed. For each one: append a "no response within X" timeout
   * continuation to the task body, clear wait_for, transition the
   * task back to `pending` so the Agent's loop picks it up on the
   * next poll. The Agent then decides what to do (give up, retry,
   * report).
   */
  private async sweepWaitForOnce(): Promise<void> {
    if (this.isShuttingDown) return
    const now = new Date()
    for (const [agentName] of Object.entries(this.state.agents)) {
      const store = new TaskStore(this.state.home, agentName)
      let expired: Awaited<ReturnType<TaskStore['findExpiredWaits']>>
      try {
        expired = await store.findExpiredWaits(now)
      } catch (err) {
        this.log.warn('wait_for sweep: list failed for agent', {
          agent: agentName,
          error: err instanceof Error ? err.message : String(err),
        })
        continue
      }
      for (const task of expired) {
        const w = task.frontmatter.wait_for
        if (!w) continue
        const waitedFor = Math.max(
          0,
          Math.round((now.getTime() - new Date(w.waiting_since).getTime()) / 1000),
        )
        const replyHint =
          w.source_kind === 'pub'
            ? `If you want to forward the timeout, use \`pub_send\` or whichever \`*_send\` your original requester used.`
            : w.source_kind === 'connector'
              ? `If you want to forward the timeout, use \`${w.source_ref.connector_id ?? '<connector>'}_send\` ` +
                `with \`to: "${w.source_ref.conversation_id ?? '<conversation>'}"\`.`
              : `If you want to forward the timeout, use \`chat_send\`.`
        const continuation = buildTimeoutContinuationSection({
          context_note: w.context_note,
          expected_from: w.expected_from,
          source_kind: w.source_kind,
          waited_for_seconds: waitedFor,
          reply_hint: replyHint,
        })
        try {
          await store.updateRecord(task.frontmatter.id, (rec) => ({
            frontmatter: {
              ...rec.frontmatter,
              state: 'pending',
              wait_for: null,
            },
            body: `${rec.body}\n\n${continuation}`,
          }))
          this.log.info('wait_for sweep → resumed task after timeout', {
            agent: agentName,
            task_id: task.frontmatter.id,
            expected_from: w.expected_from,
            waited_for_seconds: waitedFor,
          })
        } catch (err) {
          this.log.warn('wait_for sweep: resume write failed', {
            agent: agentName,
            task_id: task.frontmatter.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }
  }

  /**
   * Walk supervisor.json on boot and revive previously-running pubs
   * and agents.
   *
   * Pubs: anything in 'running' or 'errored' state gets a fresh
   * launch. Before launching, we kill any orphan process listening on
   * the recorded port (left over when a prior supervisor was
   * SIGKILL'd before its child cleanup ran). This is the cure for
   * the "pub-server is alive but supervisor.json says errored, so
   * agent connects go into a zombie state" pattern that bit us
   * repeatedly during session-13 testing.
   *
   * Agents: anything previously in 'running' state is checked for a
   * live pid. If still alive, adopt; if dead, restart through the
   * normal startAgent path (which clears errored_* fields).
   *
   * All failures are warned-and-continue, never thrown ... boot
   * proceeds even if a single pub or agent fails to revive, so the
   * operator can fix the broken one without losing the rest.
   */
  private async recoverFromState(): Promise<void> {
    const reviveStart = Date.now()
    let pubsRevived = 0
    let agentsRevived = 0
    let agentsAdopted = 0

    for (const [name, record] of Object.entries(this.state.pubs)) {
      if (record.state !== 'running' && record.state !== 'errored') continue
      // If the recorded pub-server PID is still alive, the previous
      // supervisor exited via SIGHUP (preserveChildren) and the
      // pub-server is OUR child still listening on its port. Adopt
      // rather than kill-and-restart ... that flapping is what
      // disconnects every agent's WebSocket and breaks Studio after a
      // daemon restart. The pub-bridge will reconnect via its
      // existing retry path.
      if (record.pid !== null && isPidAlive(record.pid)) {
        this.log.info('boot: pub-server still alive; adopting', {
          name,
          pid: record.pid,
          port: record.port,
        })
        pubsRevived += 1
        continue
      }
      try {
        await killOrphanOnPort(record.port, this.log)
        await this.startPub(name)
        pubsRevived += 1
      } catch (err) {
        this.log.warn('boot: failed to revive pub', {
          name,
          port: record.port,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Brief settle so newly-started pub-servers have bound their
    // ports before agents try to connect. The agent's PubClient
    // also retries on connect failure but biasing toward "pub is
    // already up" reduces wake-source warnings on first boot.
    if (pubsRevived > 0) {
      await new Promise((r) => setTimeout(r, 800))
    }

    const expectedBootstrap = defaultBootstrapPath()
    let agentsRejectedAndRestarted = 0
    // Any non-terminal state was a live Agent at last shutdown; revive it.
    // 'stopped' is operator-requested rest; 'errored' is crashed beyond the
    // restart budget. Both stay down until the operator brings them back.
    const reviveStates: AgentRecord['state'][] = [
      'running',
      'waiting',
      'blocked_on_user',
      'blocked_on_agent',
      'blocked_on_detector',
    ]
    for (const [name, record] of Object.entries(this.state.agents)) {
      if (!reviveStates.includes(record.state)) continue
      const agentLockPath = agentPaths(this.state.home, name).pidFile
      const agentAlive = record.pid !== null && (await isLockHeld(agentLockPath))
      if (agentAlive && record.pid !== null) {
        // Adopt-time validation: confirm the surviving process is running
        // the currently-deployed bootstrap. If the dist was rebuilt while
        // the Agent was alive, the process holds stale code in memory and
        // will service tasks with old behavior (this is the orphan-PID bug
        // that bit the 2026-05-11 smoke run). Refuse to adopt mismatches;
        // kill and restart instead.
        const valid = validateAdoptedProcessArgv(record.pid, expectedBootstrap)
        if (valid) {
          this.log.info('boot: agent process still alive; adopting', {
            name,
            pid: record.pid,
          })
          const tracked = adoptAgent(name, record.pid, this.state.home, this.log.child('lifecycle'))
          this.tracked.set(name, tracked)
          void tracked.exited.then(({ code, signal }) => {
            void this.handleAgentExit(name, code, signal)
          })
          agentsAdopted += 1
          continue
        }
        // Stale-dist process: kill it, then restart fresh.
        this.log.warn('boot: adopted process failed argv validation; killing and restarting', {
          name,
          pid: record.pid,
          expected_bootstrap: expectedBootstrap,
        })
        try {
          const stale = adoptAgent(name, record.pid, this.state.home, this.log.child('lifecycle'))
          await stale.stop(5000)
        } catch (err) {
          this.log.warn('boot: failed to kill stale process; will restart anyway', {
            name,
            pid: record.pid,
            error: err instanceof Error ? err.message : String(err),
          })
        }
        try {
          await this.startAgent(name)
          agentsRejectedAndRestarted += 1
        } catch (err) {
          this.log.warn('boot: failed to restart after rejection', {
            name,
            error: err instanceof Error ? err.message : String(err),
          })
        }
        continue
      }
      try {
        await this.startAgent(name)
        agentsRevived += 1
      } catch (err) {
        this.log.warn('boot: failed to revive agent', {
          name,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    this.log.info('boot: state recovery complete', {
      pubs_revived: pubsRevived,
      agents_revived: agentsRevived,
      agents_adopted: agentsAdopted,
      agents_rejected_and_restarted: agentsRejectedAndRestarted,
      duration_ms: Date.now() - reviveStart,
    })
  }

  /**
   * Stop accepting new connections, send agent.stop to every running Agent,
   * persist final state, and clean up. Idempotent.
   */
  /**
   * Shut the supervisor down.
   *
   * Two modes via `preserveChildren`:
   *
   * - `false` (default): full stop. Sends `agent.stop` to every running
   *   Agent, waits for them to exit gracefully, then closes everything.
   *   The operator's intent for `2200 daemon stop` (and tests).
   *
   * - `true`: bounce mode. Stops listening on the UDS socket, runs
   *   teardown, but does NOT signal Agents to stop. Agent processes
   *   keep running; their heartbeat-reconnect path picks up the new
   *   supervisor when it boots. Pub-server children are also
   *   preserved. The operator's intent for "restart the daemon
   *   without flapping the fleet."
   */
  /**
   * Fast (sync, no-disk) snapshot of the connector listener's lifecycle
   * state. Returns the lifecycle fields truthfully (`configured`,
   * `listening`, `port`) but **always reports `bearer_present: false`**
   * and null timestamps — the bearer record lives in the sealed vault
   * and reading it requires an async disk + crypto round-trip.
   *
   * **NOT for operator surfaces.** The CLI `connector status`, web
   * Settings tile, and `cli.connector.status` RPC handler all use
   * `getConnectorStatusDetailed()` instead, which fills in the bearer
   * fields. Use this only when a synchronous lifecycle check is
   * actually needed (and there are no such callers today — kept as a
   * primitive so the async version doesn't have to duplicate the
   * lifecycle logic).
   */
  getConnectorStatusFast(): {
    configured: boolean
    listening: boolean
    port: number | null
    bearer_present: boolean
    bearer_created_at: string | null
    bearer_regenerated_at: string | null
  } {
    const configured = this.connectorConfig !== undefined
    const listening = this.connectorHandle !== undefined
    return {
      configured,
      listening,
      port: this.connectorHandle?.port ?? this.connectorConfig?.port ?? null,
      bearer_present: false,
      bearer_created_at: null,
      bearer_regenerated_at: null,
    }
  }

  /**
   * The status snapshot used by every operator surface (CLI `connector
   * status`, web Settings tile, `cli.connector.status` RPC). Reads the
   * vault for bearer metadata; otherwise mirrors the lifecycle fields
   * from {@link getConnectorStatusFast}.
   */
  async getConnectorStatusDetailed(): Promise<ReturnType<Supervisor['getConnectorStatusFast']>> {
    const base = this.getConnectorStatusFast()
    const record = await readBearer(this.state.home)
    return {
      ...base,
      bearer_present: record !== null,
      bearer_created_at: record?.createdAt ?? null,
      bearer_regenerated_at: record?.regeneratedAt ?? null,
    }
  }

  /**
   * Mint a fresh connector bearer, persist it to the sealed vault, and
   * (re)start the listener with the new token. Returns the plaintext
   * token; the caller is responsible for surfacing it to the operator
   * exactly once (CLI prints, web Settings tile reveals).
   *
   * If a prior token existed, this call instantly invalidates it at
   * the door. The operator must re-paste the new token wherever it
   * was registered upstream (grok.com/connectors, etc.).
   */
  async regenerateConnectorBearer(): Promise<{ token: string }> {
    if (!this.connectorConfig || !this.connectorAudit) {
      throw new Error(
        'connector not configured for this supervisor; pass `connector: { port }` to Supervisor.create',
      )
    }
    const token = mintBearerToken()
    const now = new Date().toISOString()
    const existed = await hasBearer(this.state.home)
    await saveBearer(this.state.home, {
      token,
      createdAt: now,
      ...(existed ? { regeneratedAt: now } : {}),
    })
    // Restart the listener so its cached bearer matches the new vault
    // value. Grok's review accepted a brief outage on regenerate over
    // hot-swap complexity.
    if (this.connectorHandle) {
      try {
        await this.connectorHandle.close('bearer_regenerated')
      } catch {
        // best-effort; we'll still try to start the new listener.
      }
      this.connectorHandle = undefined
    }
    this.connectorHandle = await startConnectorListener({
      home: this.state.home,
      port: this.connectorConfig.port,
      audit: this.connectorAudit,
      ...(this.connectorConfig.bodyLimitBytes !== undefined
        ? { bodyLimitBytes: this.connectorConfig.bodyLimitBytes }
        : {}),
      serverDeps: this.connectorServerDeps(),
    })
    return { token }
  }

  /** Build the connector-server dep bag from in-memory supervisor state. */
  private connectorServerDeps(): {
    snapshot: () => StateSnapshotResult
    knownAgents: () => Promise<Set<string>>
    resolveThreadPrimaryAgent: (threadSlug: string) => Promise<string | null>
    proposeWorkPackage: (args: {
      proposal: ProposedWorkPackage
      primaryAgent: string
    }) => Promise<{ packageId: string; packageSlug: string; coordinationTaskId: string }>
  } {
    return {
      snapshot: () => this.snapshot(),
      knownAgents: () => Promise.resolve(new Set(Object.keys(this.state.agents))),
      resolveThreadPrimaryAgent: async (threadSlug: string) => {
        const { listSynthesisStates } = await import('../mcp/connector/synthesis.js')
        const states = await listSynthesisStates(this.state.home)
        const state = states.find((s) => s.threadSlug === threadSlug)
        return state?.primaryAgent ?? null
      },
      proposeWorkPackage: (args) => this.proposeWorkPackage(args),
    }
  }

  /**
   * Hand a synthesis task to a primary Agent. Used by the reconciler.
   *
   * The task description tells the Agent everything it needs: the
   * thread slug, the `pending_synthesis_at` snapshot to advance the
   * brief through, the per-synthesis budget cap, the structure
   * recommendation, and which tool to call.
   */
  private async submitSynthesisTask(args: {
    agent: string
    threadSlug: string
    pendingSynthesisAt: string
    budgetUsd: number
  }): Promise<{ taskId: string }> {
    if (!(args.agent in this.state.agents)) {
      throw new Error(`no Agent record for ${args.agent}`)
    }
    const store = new TaskStore(this.state.home, args.agent)
    const title = `Synthesize standing brief for research thread "${args.threadSlug}"`
    const body = renderSynthesisTaskBody(args)
    const task = newPendingTask({
      id: newTaskId(),
      agent: args.agent,
      title,
      body,
      // Priority `0` is the existing default for newPendingTask. The
      // synthesis task does not pre-empt other Agent work.
      priority: 0,
      // PR 4 retrofit: synthesis is internal-coordination-only ... the
      // primary Agent reads the thread log and writes the brief; no
      // execution, no per-Agent brain mutations, no shell, no
      // schedules. The dispatcher enforces this list before any
      // identity-level check (see ToolDispatcher.dispatch step 0).
      tool_policy: 'strict_allowlist',
      allowed_tools: [...STANDING_BRIEF_SYNTHESIS_ALLOWED_TOOLS],
    })
    await store.save(task)
    this.log.info('synthesis task submitted', {
      agent: args.agent,
      thread: args.threadSlug,
      task_id: task.frontmatter.id,
      budget_usd: args.budgetUsd,
    })
    return { taskId: task.frontmatter.id }
  }

  /**
   * Accept an inbound work-package proposal from the MCP connector.
   * Writes the package note, submits the (strict-allowlist)
   * coordination task to the primary Agent, emits the
   * `work_package_arrived` Inbox event, returns the package id +
   * coordination task id.
   *
   * Phase 1 invariant (locked, do not break): the coordination task
   * runs under `tool_policy: strict_allowlist` with
   * WORK_PACKAGE_COORDINATION_ALLOWED_TOOLS. The dispatcher enforces
   * the allowlist mechanically — internal coordination only, no
   * execution surface, until the operator explicitly approves.
   */
  async proposeWorkPackage(args: {
    proposal: ProposedWorkPackage
    primaryAgent: string
    /**
     * OAuth client_id of the caller (set by the connector listener
     * when the call is OAuth-authenticated; null for static-bearer
     * / legacy paths). Routes the package note into the embassy's
     * brain when a conduit is registered for the client.
     */
    callingClientId?: string | null
  }): Promise<{ packageId: string; packageSlug: string; coordinationTaskId: string }> {
    if (!(args.primaryAgent in this.state.agents)) {
      throw new Error(`no Agent record for primary agent "${args.primaryAgent}"`)
    }
    const packageId = newWorkPackageId()
    const { resolveCallingEmbassy } = await import('../mcp/connector/embassy/routing.js')
    const embassy = await resolveCallingEmbassy(this.state.home, args.callingClientId ?? null)
    const writeResult = await writeProposedPackage({
      home: this.state.home,
      packageId,
      proposal: args.proposal,
      primaryAgent: args.primaryAgent,
      ...(embassy !== null ? { embassyAgent: embassy.embassyAgent } : {}),
    })
    const coordinationTaskId = await this.submitWorkPackageCoordinationTask({
      agent: args.primaryAgent,
      packageId,
    })
    await patchPackageFrontmatter({
      home: this.state.home,
      packageId,
      updates: { coordination_task_id: coordinationTaskId },
    })
    if (this.connectorAudit) {
      await this.connectorAudit
        .emitWorkPackageArrived({
          packageId,
          packageSlug: writeResult.slug,
          packagePath: writeResult.path,
          primaryAgent: args.primaryAgent,
          title: args.proposal.title,
          targetKind: args.proposal.target.kind,
          targetName:
            args.proposal.target.kind === 'thread'
              ? args.proposal.target.thread_slug
              : args.proposal.target.agent_name,
          coordinationTaskId,
        })
        .catch(() => undefined)
    }
    this.workPackageCoordinationTasks.set(coordinationTaskId, {
      packageId,
      primaryAgent: args.primaryAgent,
    })
    return { packageId, packageSlug: writeResult.slug, coordinationTaskId }
  }

  /** Submit a strict-allowlist coordination task to the primary Agent. */
  private async submitWorkPackageCoordinationTask(args: {
    agent: string
    packageId: string
  }): Promise<string> {
    const store = new TaskStore(this.state.home, args.agent)
    const task = newPendingTask({
      id: newTaskId(),
      agent: args.agent,
      title: `Produce reviewable plan for work package ${args.packageId}`,
      body: renderWorkPackageCoordinationTaskBody(args.packageId),
      priority: 0,
      tool_policy: 'strict_allowlist',
      allowed_tools: [...WORK_PACKAGE_COORDINATION_ALLOWED_TOOLS],
    })
    await store.save(task)
    this.log.info('work-package coordination task submitted', {
      agent: args.agent,
      package_id: args.packageId,
      task_id: task.frontmatter.id,
    })
    return task.frontmatter.id
  }

  /**
   * Approve a work package: parse the `## Plan` section from the
   * note body, submit one follow-on task per plan step to the
   * primary Agent (these run under the Agent's normal
   * `inherit_agent` policy — execution is now permitted because the
   * human approved), patch the note's frontmatter to `approved`,
   * emit the approval Inbox event.
   */
  async approveWorkPackage(packageId: string): Promise<{ followOnTaskIds: string[] }> {
    const record = await readWorkPackage(this.state.home, packageId)
    if (record === null) throw new Error(`unknown work package ${packageId}`)
    if (record.status !== 'reviewable') {
      throw new Error(
        `work package ${packageId} has status "${record.status}"; can only approve from "reviewable"`,
      )
    }
    const { BrainStore } = await import('../brain/store.js')
    const note = await BrainStore.forShared(this.state.home).read(workPackageSlug(packageId))
    const planSteps = parsePlanSteps(note.body)
    if (planSteps.length === 0) {
      throw new Error(
        `work package ${packageId} has no parseable Plan steps (looking for "- " bullets under "## Plan")`,
      )
    }
    const store = new TaskStore(this.state.home, record.primaryAgent)
    const followOnTaskIds: string[] = []
    for (const [idx, step] of planSteps.entries()) {
      const task = newPendingTask({
        id: newTaskId(),
        agent: record.primaryAgent,
        title: `Plan step ${String(idx + 1)} of ${String(planSteps.length)} for work package ${packageId}`,
        body: `Work package: ${packageId}\nSlug: ${record.slug}\n\nStep ${String(idx + 1)}: ${step}\n\nReference the full plan and original proposal at \`<shared>/brain/${record.slug}.md\` (read via \`brain_read_shared\`) for context.`,
        priority: 0,
      })
      await store.save(task)
      followOnTaskIds.push(task.frontmatter.id)
    }
    const now = new Date().toISOString()
    await patchPackageFrontmatter({
      home: this.state.home,
      packageId,
      updates: {
        package_status: 'approved',
        approved_at: now,
        approved_follow_on_task_ids: followOnTaskIds,
      },
    })
    if (this.connectorAudit) {
      await this.connectorAudit
        .emitWorkPackageApproved({
          packageId,
          primaryAgent: record.primaryAgent,
          followOnTaskIds,
        })
        .catch(() => undefined)
    }
    return { followOnTaskIds }
  }

  /** Reject a work package. */
  async rejectWorkPackage(packageId: string, reason: string | null): Promise<void> {
    const record = await readWorkPackage(this.state.home, packageId)
    if (record === null) throw new Error(`unknown work package ${packageId}`)
    if (record.status === 'approved' || record.status === 'rejected') {
      throw new Error(
        `work package ${packageId} has status "${record.status}"; cannot reject from terminal state`,
      )
    }
    const now = new Date().toISOString()
    await patchPackageFrontmatter({
      home: this.state.home,
      packageId,
      updates: {
        package_status: 'rejected',
        rejected_at: now,
        rejection_reason: reason,
      },
    })
    if (this.connectorAudit) {
      await this.connectorAudit
        .emitWorkPackageRejected({
          packageId,
          primaryAgent: record.primaryAgent,
          reason,
        })
        .catch(() => undefined)
    }
  }

  /**
   * Periodic poll over tracked connector tasks (synthesis-reconciler
   * inflight + work-package coordination). Dispatches terminal task
   * transitions to the right observer. Runs every 30 s while the
   * connector is configured.
   */
  private async pollConnectorTaskOutcomes(): Promise<void> {
    if (this.workPackageCoordinationTasks.size === 0) return
    for (const [taskId, ctx] of this.workPackageCoordinationTasks.entries()) {
      const store = new TaskStore(this.state.home, ctx.primaryAgent)
      const task = await store.get(taskId).catch(() => null)
      if (task === null) {
        // Task record gone; stop tracking but emit a coordination_failed
        // event so the operator sees the anomaly.
        this.workPackageCoordinationTasks.delete(taskId)
        if (this.connectorAudit) {
          await this.connectorAudit
            .emitWorkPackageCoordinationFailed({
              packageId: ctx.packageId,
              primaryAgent: ctx.primaryAgent,
              coordinationTaskId: taskId,
              errorSummary: 'task record missing',
            })
            .catch(() => undefined)
        }
        continue
      }
      const state = task.frontmatter.state
      if (state === 'done') {
        this.workPackageCoordinationTasks.delete(taskId)
        await patchPackageFrontmatter({
          home: this.state.home,
          packageId: ctx.packageId,
          updates: { package_status: 'reviewable' },
        })
        if (this.connectorAudit) {
          await this.connectorAudit
            .emitWorkPackagePlanReady({
              packageId: ctx.packageId,
              packageSlug: workPackageSlug(ctx.packageId),
              primaryAgent: ctx.primaryAgent,
              coordinationTaskId: taskId,
            })
            .catch(() => undefined)
        }
      } else if (state === 'errored') {
        this.workPackageCoordinationTasks.delete(taskId)
        if (this.connectorAudit) {
          await this.connectorAudit
            .emitWorkPackageCoordinationFailed({
              packageId: ctx.packageId,
              primaryAgent: ctx.primaryAgent,
              coordinationTaskId: taskId,
              errorSummary: task.frontmatter.error?.message ?? '(no detail)',
            })
            .catch(() => undefined)
        }
      }
      // Non-terminal states: leave tracking in place; next tick re-checks.
    }
  }

  /**
   * Public hook the reconciler exposes for the CLI / RPC `connector
   * synthesis unblock`: clear `synthesis_blocked` + reset the failure
   * count on a thread anchor. Operator's recovery path after three
   * consecutive synthesis failures.
   */
  async clearSynthesisBlocked(threadSlug: string): Promise<void> {
    await updateAnchorFrontmatter({
      home: this.state.home,
      threadSlug,
      updates: {
        synthesis_blocked: false,
        synthesis_failure_count: 0,
      },
    })
  }

  /**
   * Register a new OAuth client at the trusted (loopback) operator
   * surface. The operator's "I trust this Grok integration" decision
   * is captured here; subsequent /authorize calls from this client_id
   * proceed without operator presence. Returns the client_id + the
   * one-time plaintext secret (null if PKCE-only).
   *
   * See wiki/inbox/grok/2026-05-23-phase2-oauth-as-locked-decisions.md.
   */
  async registerOAuthClient(args: {
    displayName: string
    redirectUris: string[]
    mintSecret?: boolean
    scopesAllowed?: string[]
  }): Promise<{
    clientId: string
    clientSecret: string | null
    redirectUris: string[]
    scopesAllowed: string[]
    registeredAt: string
  }> {
    const result = await registerOAuthClient({
      home: this.state.home,
      displayName: args.displayName,
      redirectUris: args.redirectUris,
      ...(args.mintSecret !== undefined ? { mintSecret: args.mintSecret } : {}),
      ...(args.scopesAllowed !== undefined ? { scopesAllowed: args.scopesAllowed } : {}),
    })
    const record = await readOAuthClient(this.state.home, result.clientId)
    if (record === null) {
      throw new Error(
        `register-and-read race for client ${result.clientId}; bailing rather than silently lose the audit event`,
      )
    }
    if (this.connectorAudit) {
      await this.connectorAudit
        .emitOauthClientRegistered({
          clientId: record.client_id,
          displayName: record.display_name,
          redirectUris: record.redirect_uris,
          hasSecret: record.client_secret_hash !== null,
        })
        .catch(() => undefined)
    }
    return {
      clientId: record.client_id,
      clientSecret: result.clientSecret,
      redirectUris: record.redirect_uris,
      scopesAllowed: record.scopes_allowed,
      registeredAt: record.registered_at,
    }
  }

  async listOAuthClients(): Promise<
    {
      clientId: string
      displayName: string
      redirectUris: string[]
      hasSecret: boolean
      scopesAllowed: string[]
      registeredAt: string
      lastAuthorizeAt: string | null
      revokedAt: string | null
    }[]
  > {
    const records = await listOAuthClients(this.state.home)
    return records.map((r) => ({
      clientId: r.client_id,
      displayName: r.display_name,
      redirectUris: r.redirect_uris,
      hasSecret: r.client_secret_hash !== null,
      scopesAllowed: r.scopes_allowed,
      registeredAt: r.registered_at,
      lastAuthorizeAt: r.last_authorize_at,
      revokedAt: r.revoked_at,
    }))
  }

  /**
   * Revoke an OAuth client: mark the record revoked, purge every
   * access + refresh token associated with the client, emit the
   * Inbox event. Subsequent /authorize and /token requests from
   * this client_id will fail.
   */
  async revokeOAuthClient(clientId: string): Promise<{
    removedRefresh: number
    removedAccess: number
  }> {
    const existing = await readOAuthClient(this.state.home, clientId)
    if (existing === null) throw new Error(`unknown client_id "${clientId}"`)
    await markOAuthClientRevoked(this.state.home, clientId, new Date())
    const { removed_refresh, removed_access } = await revokeOAuthClientTokens(
      this.state.home,
      clientId,
    )
    if (this.connectorAudit) {
      await this.connectorAudit
        .emitOauthClientRevoked({
          clientId,
          displayName: existing.display_name,
          removedRefresh: removed_refresh,
          removedAccess: removed_access,
        })
        .catch(() => undefined)
    }
    return { removedRefresh: removed_refresh, removedAccess: removed_access }
  }

  /**
   * Rotate a client's secret in place. Returns the fresh plaintext
   * secret (shown once). Existing access + refresh tokens for the
   * client are NOT invalidated (per operator UX expectation: rotate
   * to revoke a leaked secret, but keep tokens flowing). Use
   * `revokeOAuthClient` instead if the goal is to kill the session.
   */
  async rotateOAuthClientSecret(clientId: string): Promise<{
    clientId: string
    clientSecret: string
  }> {
    const fresh = await rotateOAuthClientSecret(this.state.home, clientId)
    return { clientId, clientSecret: fresh }
  }

  /**
   * Register an embassy: bind an existing OAuth client to an Agent
   * (dedicated or attached) and write the conduit registry entry.
   *
   * Locked decisions (2026-05-26): the conduits registry is keyed
   * by the OAuth client_id; the embassy spec is additive to the
   * connector data model from the 2026-05-22 handoff.
   *
   * Dedicated mode creates a fresh Agent via `createAgent` with an
   * identity body rendered from the embassy template + frontmatter
   * carrying the embassy marker block. Attached mode patches an
   * existing Agent's canonical identity to add the marker block.
   *
   * Both modes:
   *   - Validate the OAuth client_id exists + is not revoked.
   *   - Refuse if the client_id already has a registered conduit.
   *   - Write a ConduitRecord under
   *     `<home>/state/connector/conduits/<client_id>.json`.
   *   - Initialize the embassy's brain subdirs (shelf/, etc.).
   *   - Regenerate the `<shared>/brain/conduits.md` operator index.
   *
   * Audit events for embassy lifecycle land in PR-B6.
   */
  async registerEmbassy(args: {
    clientId: string
    externalModel: string
    embassyAgent: string
    mode: 'dedicated' | 'attached'
    displayName: string
    registeredBy: string
    /** Required for `dedicated` mode; ignored for `attached`. */
    model?: IdentityFrontmatter['model']
    /** Optional for `dedicated` mode (defaults to empty tool set). */
    tools?: IdentityFrontmatter['tools']
  }): Promise<{ conduit: ConduitRecord; agentCreated: boolean }> {
    const client = await readOAuthClient(this.state.home, args.clientId)
    if (client === null) {
      throw new Error(
        `no OAuth client registered with client_id "${args.clientId}"; register one first via '2200 connector oauth-client register' (or Settings → OAuth clients)`,
      )
    }
    if (client.revoked_at !== null) {
      throw new Error(
        `OAuth client "${args.clientId}" is revoked; register a fresh client before registering an embassy for it`,
      )
    }
    const existingConduit = await readConduit(this.state.home, args.clientId)
    if (existingConduit !== null && existingConduit.retired_at === null) {
      throw new Error(
        `client_id "${args.clientId}" already has a registered conduit (embassy: ${existingConduit.embassy_agent}). Retire it first before re-registering.`,
      )
    }

    const now = new Date()
    const registeredAt = now.toISOString()
    let agentCreated = false

    if (args.mode === 'dedicated') {
      if (this.state.agents[args.embassyAgent] !== undefined) {
        throw new Error(
          `cannot register dedicated embassy: Agent "${args.embassyAgent}" already exists. Either pick a different name or use --mode attached.`,
        )
      }
      if (args.model === undefined) {
        throw new Error('dedicated mode requires a model binding (provider + model_id + tier)')
      }
      const sourcePath = await buildDedicatedSourceIdentity({
        home: this.state.home,
        agentName: args.embassyAgent,
        externalModel: args.externalModel,
        clientId: args.clientId,
        registeredAt,
        model: args.model,
        ...(args.tools !== undefined ? { tools: args.tools } : {}),
      })
      await this.createAgent(args.embassyAgent, sourcePath)
      agentCreated = true
    } else {
      if (this.state.agents[args.embassyAgent] === undefined) {
        throw new Error(
          `cannot attach embassy role to non-existent Agent "${args.embassyAgent}". Either pick an existing Agent or use --mode dedicated.`,
        )
      }
      const ap = agentPaths(this.state.home, args.embassyAgent).identity
      await patchIdentityWithEmbassyBlock(ap, {
        external_model: args.externalModel,
        client_id: args.clientId,
        mode: 'attached',
        registered_at: registeredAt,
      })
    }

    // Initialize embassy-specific brain subdirs (spec section 4).
    await initEmbassyBrainDirs(this.state.home, args.embassyAgent)

    const conduit = buildConduitRecord({
      clientId: args.clientId,
      externalModel: args.externalModel,
      embassyAgent: args.embassyAgent,
      mode: args.mode,
      displayName: args.displayName,
      registeredAt,
      registeredBy: args.registeredBy,
    })
    await writeConduit(this.state.home, conduit)
    await regenerateConduitsIndex(this.state.home)

    // One-time migration of pre-embassy ownerless notes (PR-B3).
    // Runs only when no prior embassy claimed them (the sentinel
    // tracks completion). Idempotent — re-runs no-op.
    const { migrateOwnerlessNotesToEmbassy } =
      await import('../mcp/connector/embassy/note-migration.js')
    const migration = await migrateOwnerlessNotesToEmbassy(this.state.home, args.embassyAgent)
    if (!migration.skipped_already_complete) {
      this.log.info('ownerless notes migrated to embassy', {
        embassy_agent: args.embassyAgent,
        migrated_threads: migration.migrated_threads,
        migrated_briefs: migration.migrated_briefs,
        migrated_agent_contributions: migration.migrated_agent_contributions,
      })
    }

    this.log.info('embassy registered', {
      client_id: args.clientId,
      embassy_agent: args.embassyAgent,
      external_model: args.externalModel,
      mode: args.mode,
    })

    // PR-B6 audit: embassy lifecycle event (normal tier). Distinct
    // from `oauth_client_registered` — that fired when the client
    // record was minted; this fires when the embassy / conduit
    // binding is established.
    if (this.connectorAudit) {
      await this.connectorAudit
        .emitEmbassyRegistered({
          clientId: args.clientId,
          externalModel: args.externalModel,
          embassyAgent: args.embassyAgent,
          mode: args.mode,
          displayName: args.displayName,
          agentCreated,
        })
        .catch(() => undefined)
    }

    return { conduit, agentCreated }
  }

  /**
   * Atomic embassy provisioning (PR-B5): mint a fresh OAuth client +
   * register an embassy for it in one operation. The operator's
   * "register a connection to Grok" intent maps to ONE Settings flow,
   * not two cascading ones. If embassy registration fails after the
   * OAuth client is minted, the client is revoked so the operator
   * isn't left with orphaned credentials.
   *
   * Returns the same shape `registerOAuthClient` returns (including
   * the one-time `clientSecret` when minted) plus the embassy record.
   */
  async registerEmbassyAndOAuthClient(args: {
    displayName: string
    externalModel: string
    embassyAgent: string
    mode: 'dedicated' | 'attached'
    redirectUris?: string[]
    mintSecret?: boolean
    scopesAllowed?: string[]
    registeredBy: string
    model?: IdentityFrontmatter['model']
    tools?: IdentityFrontmatter['tools']
  }): Promise<{
    conduit: ConduitRecord
    agentCreated: boolean
    clientId: string
    clientSecret: string | null
  }> {
    const { GROK_CONNECTOR_REDIRECT_URI } = await import('../mcp/connector/oauth/client-store.js')
    const oauth = await this.registerOAuthClient({
      displayName: args.displayName,
      redirectUris:
        args.redirectUris !== undefined && args.redirectUris.length > 0
          ? args.redirectUris
          : [GROK_CONNECTOR_REDIRECT_URI],
      ...(args.mintSecret !== undefined ? { mintSecret: args.mintSecret } : {}),
      ...(args.scopesAllowed !== undefined ? { scopesAllowed: args.scopesAllowed } : {}),
    })
    try {
      const embassy = await this.registerEmbassy({
        clientId: oauth.clientId,
        externalModel: args.externalModel,
        embassyAgent: args.embassyAgent,
        mode: args.mode,
        displayName: args.displayName,
        registeredBy: args.registeredBy,
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.tools !== undefined ? { tools: args.tools } : {}),
      })
      return {
        conduit: embassy.conduit,
        agentCreated: embassy.agentCreated,
        clientId: oauth.clientId,
        clientSecret: oauth.clientSecret,
      }
    } catch (err) {
      // Roll back the just-minted OAuth client so the operator
      // isn't left with an orphaned credential pointing nowhere.
      // Best-effort; if revoke also fails, surface the original
      // registration error so the operator knows what to fix.
      await this.revokeOAuthClient(oauth.clientId).catch(() => undefined)
      throw err
    }
  }

  async listConduits(): Promise<ConduitRecord[]> {
    return listConduits(this.state.home)
  }

  /** Retire a conduit. The Agent record stays (might be a dedicated embassy with valuable history); the conduit no longer routes traffic. */
  async retireConduit(clientId: string): Promise<void> {
    const existing = await readConduit(this.state.home, clientId)
    if (existing === null) throw new Error(`unknown conduit client_id "${clientId}"`)
    if (existing.retired_at !== null) return // idempotent
    await markConduitRetired(this.state.home, clientId, new Date())
    await regenerateConduitsIndex(this.state.home)
    this.log.info('embassy retired', {
      client_id: clientId,
      embassy_agent: existing.embassy_agent,
    })
    if (this.connectorAudit) {
      await this.connectorAudit
        .emitEmbassyRetired({
          clientId,
          embassyAgent: existing.embassy_agent,
          externalModel: existing.external_model,
        })
        .catch(() => undefined)
    }
  }

  /**
   * Approve a pending shelf-placement request. Operator runs
   * `2200 connector mcp shelf approve <token>` (or hits the web
   * Settings surface in B5). The approval transforms the pending
   * record into a real shelf-item file under the embassy's brain,
   * stamped with `source_type: human_curated` and the operator name
   * as curator (per spec section 9 mechanism, locked 2026-05-26).
   *
   * Idempotent on the token: a second approve call after the first
   * returns the same shelf_item_id without writing again. (We delete
   * the pending record on first approve.)
   */
  async approveShelfPlacement(args: {
    approvalToken: string
    operatorName: string
  }): Promise<{ shelfItemId: string; embassyAgent: string }> {
    const pending = await readApproval(this.state.home, args.approvalToken)
    if (pending === null) {
      throw new Error(
        `unknown approval_token "${args.approvalToken}"; either it was already approved/rejected, or never existed`,
      )
    }
    const now = new Date()
    const shelfItemId = newShelfItemId()
    const fm: ShelfItemFrontmatter = {
      schema_version: 1,
      shelf_item_id: shelfItemId,
      type: pending.proposed.type,
      source_type: 'human_curated',
      // The operator's approval transforms the source: the operator
      // becomes the curator; the source.origin is preserved from the
      // embassy's original proposal so the trail back to its reasoning
      // stays legible.
      source: {
        ...pending.proposed.source,
        curator: args.operatorName,
        timestamp: now.toISOString(),
      },
      target_model: pending.proposed.target_model,
      provenance: {
        ingested_at: now.toISOString(),
        ingested_by: pending.embassy_agent,
        original_contribution_slug:
          pending.proposed.source.origin === 'contribution'
            ? pending.proposed.source.reference
            : null,
        chain: [],
      },
      priority: pending.proposed.priority,
      status: 'pending',
      collected_at: null,
      sensitivity: 'none', // operator approval IS the desensitization
    }
    await writeShelfItem(this.state.home, pending.embassy_agent, fm, pending.proposed.body)
    await deleteApproval(this.state.home, args.approvalToken)
    if (this.connectorAudit) {
      await this.connectorAudit
        .emitEmbassyShelfItemPlaced({
          embassyAgent: pending.embassy_agent,
          shelfItemId,
          itemType: pending.proposed.type,
          priority: pending.proposed.priority,
          sourceType: 'human_curated',
          curator: args.operatorName,
        })
        .catch(() => undefined)
      // PR-B6: operator-decision lifecycle event (normal tier). The
      // _item_placed event above is the "what landed on disk" signal
      // (passive); this is the "operator made a decision" signal.
      await this.connectorAudit
        .emitEmbassyShelfApprovalResolved({
          embassyAgent: pending.embassy_agent,
          approvalToken: args.approvalToken,
          decision: 'approved',
          shelfItemId,
        })
        .catch(() => undefined)
    }
    return { shelfItemId, embassyAgent: pending.embassy_agent }
  }

  /** Reject a pending shelf-placement request: delete it without writing the shelf item. */
  async rejectShelfPlacement(args: { approvalToken: string }): Promise<void> {
    const pending = await readApproval(this.state.home, args.approvalToken)
    if (pending === null) {
      throw new Error(
        `unknown approval_token "${args.approvalToken}"; either it was already approved/rejected, or never existed`,
      )
    }
    await deleteApproval(this.state.home, args.approvalToken)
    if (this.connectorAudit) {
      await this.connectorAudit
        .emitEmbassyShelfApprovalResolved({
          embassyAgent: pending.embassy_agent,
          approvalToken: args.approvalToken,
          decision: 'rejected',
        })
        .catch(() => undefined)
    }
  }

  /**
   * Disable the MCP connector: delete the sealed bearer and stop the
   * listener. The vault file is removed entirely (not just blanked) so
   * a casual operator inspecting state/connector/ sees no dormant
   * credential. Re-enable by running `regenerateConnectorBearer`.
   */
  async disableConnector(): Promise<void> {
    if (!this.connectorConfig) {
      throw new Error('connector not configured for this supervisor')
    }
    if (this.connectorHandle) {
      try {
        await this.connectorHandle.close('user_disabled')
      } catch {
        // best-effort
      }
      this.connectorHandle = undefined
    }
    await deleteBearer(this.state.home)
  }

  async shutdown(timeoutMs = 5000, options: { preserveChildren?: boolean } = {}): Promise<void> {
    if (this.isShuttingDown) return
    this.isShuttingDown = true
    const preserveChildren = options.preserveChildren === true
    this.log.info('supervisor shutting down', { preserveChildren })
    if (this.listener) {
      await this.listener.close()
      this.listener = undefined
    }
    if (this.webHandle) {
      try {
        await this.webHandle.stop()
      } catch (err) {
        this.log.warn('error stopping http server', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
      this.webHandle = undefined
    }
    if (this.synthesisReconciler) {
      this.synthesisReconciler.stop()
      this.synthesisReconciler = undefined
    }
    if (this.connectorOutcomeWatcherTimer !== undefined) {
      clearInterval(this.connectorOutcomeWatcherTimer)
      this.connectorOutcomeWatcherTimer = undefined
    }
    if (this.connectorHandle) {
      try {
        await this.connectorHandle.close('supervisor_shutdown')
      } catch (err) {
        this.log.warn('error stopping connector listener', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
      this.connectorHandle = undefined
    }
    this.scheduler.stop()
    this.tokenRefresh.stop()
    this.onboardingSessions.stop()
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer)
      this.livenessTimer = undefined
    }
    if (this.credentialRequestSweeperTimer) {
      clearInterval(this.credentialRequestSweeperTimer)
      this.credentialRequestSweeperTimer = undefined
    }
    if (this.waitForSweeperTimer) {
      clearInterval(this.waitForSweeperTimer)
      this.waitForSweeperTimer = undefined
    }
    for (const watcher of this.pulseWatchers.values()) watcher.stop()
    this.pulseWatchers.clear()
    const stops = preserveChildren
      ? []
      : Array.from(this.tracked.values()).map(async (sa) => {
          try {
            await sa.stop(timeoutMs)
          } catch (err) {
            this.log.warn('error stopping agent', {
              name: sa.name,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        })
    const pubStops = preserveChildren
      ? []
      : Array.from(this.trackedPubs.values()).map(async (sp) => {
          // Mark intent so `handlePubExit` routes to 'stopped', not 'errored'.
          this.pubStopRequested.add(sp.name)
          try {
            await sp.stop(timeoutMs)
          } catch (err) {
            this.log.warn('error stopping pub', {
              name: sp.name,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        })
    await Promise.all([...stops, ...pubStops])
    // Close every connection with a per-connection timeout. Without
    // this, a single hung connection (typical cause: agent process
    // stopped acking on its UDS read end but didn't close it) blocks
    // the entire supervisor.shutdown() indefinitely. The shutdown
    // path is hot during daemon bounces; we cannot afford to hang.
    await Promise.all(
      Array.from(this.connections).map(async (conn) => {
        try {
          await Promise.race([conn.close(), new Promise((resolve) => setTimeout(resolve, 1500))])
        } catch {
          // best-effort
        }
      }),
    )
    // Drain any startup tasks still in flight (fleet regen, shared
    // brain seed) before closing brain handles, so a fast
    // start/shutdown sequence doesn't surface
    // "database connection is not open" warnings from racing writes.
    if (this.startupTasks.length > 0) {
      await Promise.allSettled(this.startupTasks)
      this.startupTasks = []
    }
    // Close any cached brain handles (per-Agent + shared) so SQLite
    // releases the DB files. Required for tests that rm -r the temp
    // home in afterEach; otherwise SQLite's WAL/SHM aux files keep
    // the directory non-empty and the cleanup fails.
    const { closeAllBrains } = await import('../brain/registry.js')
    closeAllBrains()
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
  async createAgent(
    name: string,
    sourceIdentityPath: string,
    opts: {
      /**
       * Pick a specific pub to register the Agent against (when the
       * Identity has a `pub:` block). Required only when more than
       * one pub exists; with exactly one, the supervisor uses it.
       * Ignored when the Identity has no `pub:` block.
       */
      pub?: string
      /** Test injection: override the identity-client factory. */
      identityClientFactory?: (baseUrl: string) => IdentityClient
    } = {},
  ): Promise<void> {
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

    // Pub identity provisioning (Epic 3 PR B follow-up). Every Agent
    // joins the Studio (the default pub on this instance) by default;
    // if the source Identity does not declare a pub: block we
    // synthesize one from the agent name so the supervisor still
    // mints a keypair, registers it, and patches the canonical
    // identity.md. Operators who explicitly want a pub-less Agent
    // can author an Identity with `pub: null` ... but the v1 default
    // is "every Agent at all times in the Studio."
    const identityWithPub = identity.frontmatter.pub
      ? identity
      : {
          ...identity,
          frontmatter: {
            ...identity.frontmatter,
            pub: synthesizeDefaultPubBlock(this.state.home, name),
          },
        }
    if (identityWithPub.frontmatter.pub) {
      await this.provisionAgentPubIdentity({
        agentName: name,
        canonicalIdentityPath: canonical,
        loadedIdentity: identityWithPub,
        pickPub: opts.pub,
        identityClientFactory: opts.identityClientFactory,
      })
    }

    const record: AgentRecord = {
      name,
      identity_path: canonical,
      state: 'stopped',
      pid: null,
      created_at: null,
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
      pubProvisioned: !!identity.frontmatter.pub,
    })
    if (this.webHandle) {
      this.webHandle.broadcast({
        event: 'agent.created',
        payload: { agent: name },
      })
    }
    void this.regenerateFleetSafe()
  }

  /**
   * Mint, persist, and (best-effort) register the Agent's pub
   * keypair, then patch the canonical identity.md with the
   * resulting fields. Called by `createAgent` only when the source
   * Identity declares a `pub:` block.
   *
   * Skip-mint path: if the source Identity already has a non-empty
   * `pub.identity`, treat the Agent as pre-provisioned and only
   * verify the credential file exists.
   */
  private async provisionAgentPubIdentity(args: {
    agentName: string
    canonicalIdentityPath: string
    loadedIdentity: Awaited<ReturnType<typeof loadIdentity>>
    pickPub: string | undefined
    identityClientFactory: ((baseUrl: string) => IdentityClient) | undefined
  }): Promise<void> {
    const { agentName, canonicalIdentityPath, loadedIdentity, pickPub, identityClientFactory } =
      args
    const pubBlock = loadedIdentity.frontmatter.pub
    if (!pubBlock) return // Should not happen; guard for type narrowing.

    const canonicalCredPath = agentPaths(this.state.home, agentName).pubSecret

    // Determine target pub. With zero pubs, deferred (write empty
    // identity, register on next create-or-explicit-step). With one
    // pub, use it. With multiple, require pickPub.
    const targetPub = pickTargetPub(this.state.pubs, pickPub)
    if (pickPub && !this.state.pubs[pickPub]) {
      throw new Error(`no pub record for "${pickPub}"`)
    }

    // If the source Identity declares pub.identity already, treat as
    // pre-provisioned: just verify credential file exists. Do not
    // re-mint, do not re-register.
    if (pubBlock.identity) {
      try {
        await readCredentialFile(pubBlock.credentials.id || canonicalCredPath)
      } catch (err) {
        throw new Error(
          `Agent "${agentName}" Identity declares pub.identity="${pubBlock.identity}" but credential file is unreadable: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        )
      }
      return
    }

    // Mint a fresh keypair.
    const issuerUrl = targetPub
      ? `local://127.0.0.1:${String(targetPub.port)}`
      : 'local://unregistered'
    const cred = generateKeypair({ display_name: pubBlock.display_name, issuer_url: issuerUrl })
    await writeCredentialFile(canonicalCredPath, cred)

    let agentId: string | null = null
    let registeredIssuer = cred.issuer_url
    if (targetPub?.state === 'running') {
      const baseUrl = `http://127.0.0.1:${String(targetPub.port)}`
      const client = identityClientFactory
        ? identityClientFactory(baseUrl)
        : createIdentityClient({ baseUrl })
      try {
        const targetPubPaths = pubPaths(this.state.home, targetPub.name)
        const pubSecrets = await readPubSecrets({
          adminSecret: targetPubPaths.adminSecret,
          signingKey: targetPubPaths.signingKey,
        })
        const updated = await ensureRegistered(client, cred, pubSecrets.adminSecret, targetPub.name)
        const registeredId = updated.pub_agent_ids?.[targetPub.name] ?? updated.agent_id
        if (registeredId) {
          agentId = registeredId
          registeredIssuer = updated.issuer_url
          await writeCredentialFile(canonicalCredPath, updated)
        }
      } catch (err) {
        this.log.warn('Agent pub identity registration failed; will retry on next create', {
          agent: agentName,
          pub: targetPub.name,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Patch the canonical identity.md to fill in pub.identity,
    // pub.issuer_url, pub.credentials.id (canonicalize). Other fields
    // in pub block (display_name, handle, key_version, domains,
    // member_of) are preserved from the source.
    const patchedFrontmatter = {
      ...loadedIdentity.frontmatter,
      pub: {
        ...pubBlock,
        identity: agentId ?? pubBlock.identity,
        issuer_url: registeredIssuer,
        key_version: cred.key_version,
        credentials: {
          source: 'file' as const,
          id: canonicalCredPath,
        },
      },
    }
    await writeIdentity(canonicalIdentityPath, patchedFrontmatter, loadedIdentity.body)
    this.log.info('Agent pub identity provisioned', {
      agent: agentName,
      agent_id: agentId,
      registered_against: targetPub?.state === 'running' ? targetPub.name : null,
    })

    // Append/update this Agent's entry in the per-pub roster so other
    // Agents' wake sources can include it as a routing candidate.
    // Failures here are non-fatal... ambient routing degrades to "this
    // Agent isn't a candidate for the router," but the Agent still works
    // for direct @-mentions and the rest of the deterministic rules.
    if (targetPub && agentId) {
      try {
        await upsertRosterEntry(this.state.home, targetPub.name, {
          agent_id: agentId,
          agent_name: agentName,
          display_name: pubBlock.display_name,
          role_blurb: loadedIdentity.frontmatter.agent_role,
        })
      } catch (err) {
        this.log.warn('roster upsert failed; ambient routing will not see this Agent', {
          agent: agentName,
          pub: targetPub.name,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  /**
   * Enroll an EXISTING Agent into an already-running pub: mint a keypair if it
   * has none yet, register against the pub (idempotent ... `ensureRegistered`
   * no-ops if already registered), fill in identity.md `pub.identity` on first
   * registration, and upsert the routing roster.
   *
   * This is the on-demand provisioning path. An Agent created fresh OR imported
   * from OpenClaw before any pub existed has a pub block with an empty
   * `pub.identity` (provisioning at create time only fills it when a pub was
   * already running). Room creation and the Studio bootstrap call this so those
   * Agents ... whatever their origin ... get provisioned the moment a pub exists
   * to register against. The pub must be running.
   */
  async enrollAgentInPub(agentName: string, pubName: string): Promise<void> {
    const rec = this.state.agents[agentName]
    if (!rec) throw new Error(`no Agent record for "${agentName}"`)
    const pub = this.state.pubs[pubName]
    if (!pub) throw new Error(`no pub record for "${pubName}"`)
    if (pub.state !== 'running') {
      throw new Error(`pub "${pubName}" is not running; start it before enrolling Agents`)
    }
    const loaded = await loadIdentity(rec.identity_path)
    const pubBlock = loaded.frontmatter.pub
    if (!pubBlock) return // No pub-identity surface in this Identity; nothing to enroll.

    const credPath = agentPaths(this.state.home, agentName).pubSecret
    let cred
    try {
      cred = await readCredentialFile(credPath)
    } catch {
      // Created/migrated before any pub existed and never minted a keypair.
      cred = generateKeypair({
        display_name: pubBlock.display_name,
        issuer_url: `local://127.0.0.1:${String(pub.port)}`,
      })
      await writeCredentialFile(credPath, cred)
    }

    const client = createIdentityClient({ baseUrl: `http://127.0.0.1:${String(pub.port)}` })
    const paths = pubPaths(this.state.home, pubName)
    const pubSecrets = await readPubSecrets({
      adminSecret: paths.adminSecret,
      signingKey: paths.signingKey,
    })
    // Register (idempotent: ensureRegistered trusts a registration already
    // recorded for this pub and does NOT re-mint). A genuine display-name
    // conflict here means a DIFFERENT identity already holds this Agent's
    // name in the pub ... almost always the operator's own identity sharing
    // the name (the regression where setup defaulted the operator name to
    // $USER). We do NOT silently relabel the Agent to "<name> (agent)"; the
    // operator renames THEMSELF in the web app so the names stop colliding.
    // Surface the conflict so the studio bootstrap logs it rather than
    // minting a shadow Agent.
    const updated = await ensureRegistered(client, cred, pubSecrets.adminSecret, pubName)
    await writeCredentialFile(credPath, updated)
    const registeredId = updated.pub_agent_ids?.[pubName] ?? updated.agent_id ?? null

    // Fill in pub.identity the FIRST time an Agent is registered anywhere (was
    // empty for an Agent created/migrated before a pub existed). Later pubs keep
    // the canonical id; their per-pub ids live in the credential's pub_agent_ids.
    if (registeredId && !pubBlock.identity) {
      await writeIdentity(
        rec.identity_path,
        { ...loaded.frontmatter, pub: { ...pubBlock, identity: registeredId } },
        loaded.body,
      )
    }
    if (registeredId) {
      try {
        await upsertRosterEntry(this.state.home, pubName, {
          agent_id: registeredId,
          agent_name: agentName,
          display_name: pubBlock.display_name,
          role_blurb: loaded.frontmatter.agent_role,
        })
      } catch (err) {
        this.log.warn('roster upsert failed during enroll; ambient routing degrades', {
          agent: agentName,
          pub: pubName,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  /**
   * Ensure a default "studio" pub exists with EVERY Agent enrolled ... the
   * shared room "everyone is in." Run at boot BEFORE Agents are revived (so
   * they attach the studio wake source on their first start, no extra restart).
   *
   * Idempotent + self-healing: creates the studio pub only if missing, and
   * enrolls every Agent every boot (enrollAgentInPub + addPubToAgentFile both
   * no-op when already done). It iterates EVERY Agent in state regardless of
   * origin, so an Agent created fresh OR imported from OpenClaw ... including one
   * added after the studio already existed ... gets enrolled. FULLY best-effort:
   * any failure is logged and swallowed so it can never break boot.
   */
  private async ensureStudioPub(): Promise<void> {
    const STUDIO = 'studio'
    try {
      const agentNames = Object.keys(this.state.agents)
      if (agentNames.length === 0) return // nothing to put in a studio yet
      // createPub derives the owner from the user identity; defer if it doesn't
      // exist yet (fresh instance pre-user-init) ... a later boot will create it.
      const user = await loadUserIdentityIfExists(homePaths(this.state.home).configUserMd)
      if (!user) {
        this.log.info('studio bootstrap deferred: no user identity yet')
        return
      }

      let port = this.state.pubs[STUDIO]?.port
      if (!this.state.pubs[STUDIO]) {
        const created = await this.createPub(STUDIO, {
          description: 'The shared studio ... every Agent on this instance is here.',
        })
        port = created.port
      }
      await this.startPub(STUDIO)
      port ??= this.state.pubs[STUDIO]?.port
      if (port === undefined) {
        this.log.warn('studio bootstrap: no port for studio pub; skipping')
        return
      }

      // Wait for the pub-server HTTP listener to bind before registering.
      const baseUrl = `http://127.0.0.1:${String(port)}`
      const deadline = Date.now() + 5_000
      let ready = false
      while (Date.now() < deadline) {
        try {
          await fetch(baseUrl, { method: 'GET' })
          ready = true
          break
        } catch {
          await new Promise((r) => setTimeout(r, 200))
        }
      }
      if (!ready) {
        this.log.warn('studio bootstrap: pub listener never bound; skipping')
        return
      }

      // Register the operator's user identity (the pub bridge needs it to
      // mint a token to read room state). Best-effort + idempotent.
      try {
        const paths = pubPaths(this.state.home, STUDIO)
        const pubSecrets = await readPubSecrets({
          adminSecret: paths.adminSecret,
          signingKey: paths.signingKey,
        })
        const client = createIdentityClient({ baseUrl })
        const userCredPath = homePaths(this.state.home).configUserPubSecret
        const userCred = await readCredentialFile(userCredPath)
        const updated = await ensureRegistered(client, userCred, pubSecrets.adminSecret, STUDIO)
        await writeCredentialFile(userCredPath, updated)
      } catch (err) {
        this.log.warn('studio bootstrap: user registration failed (continuing)', {
          error: err instanceof Error ? err.message : String(err),
        })
      }

      // Enroll every Agent + add the studio to its pubs.md (both idempotent).
      const { addPubToAgentFile } = await import('../agent/pubs-file.js')
      for (const name of agentNames) {
        try {
          await this.enrollAgentInPub(name, STUDIO)
          await addPubToAgentFile(agentPaths(this.state.home, name).pubsFile, name, STUDIO, {
            seedIfMissing: [],
          })
        } catch (err) {
          this.log.warn('studio bootstrap: enrolling Agent failed (continuing)', {
            agent: name,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      this.log.info('studio pub ensured', { members: agentNames.length })
    } catch (err) {
      this.log.warn('studio bootstrap failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** Start the Agent process for an existing record. */
  async startAgent(name: string, options: { agentBootstrapPath?: string } = {}): Promise<void> {
    const record = this.state.agents[name]
    if (!record) {
      throw new Error(`no Agent record for ${name}`)
    }
    if (this.tracked.has(name)) {
      throw new Error(`Agent ${name} is already running`)
    }
    const socketPath = Supervisor.socketPath(this.state.home)
    const startOpts: StartAgentOptions = {
      name,
      identityPath: record.identity_path,
      socketPath,
      home: this.state.home,
      ...(options.agentBootstrapPath ? { bootstrapPath: options.agentBootstrapPath } : {}),
    }
    const tracked = launchAgentProcess(startOpts, this.log.child('lifecycle'))
    this.tracked.set(name, tracked)
    void tracked.exited.then(({ code, signal }) => {
      void this.handleAgentExit(name, code, signal)
    })
    this.startPulseWatcher(name)
    // Clear any prior crash context on successful (re)start. The
    // errored_at / errored_reason fields are sticky through stops,
    // restarts, and snapshot reads; clearing them here keeps the
    // AgentDetail hero honest about current state.
    await this.updateAgent(name, {
      pid: tracked.pid,
      created_at: new Date().toISOString(),
      state: 'running',
      errored_at: null,
      errored_reason: null,
    })
  }

  /**
   * Start a PulseWatcher for the named agent if one is not already
   * running. Idempotent. The watcher forwards pulse.json changes
   * through the supervisor's WS broadcast as `pulse.changed` events.
   */
  private startPulseWatcher(name: string): void {
    if (this.pulseWatchers.has(name)) return
    const watcher = new PulseWatcher({
      home: this.state.home,
      agentName: name,
      onChange: (pulse) => {
        if (!this.webHandle) return
        this.webHandle.broadcast({
          event: 'pulse.changed',
          payload: {
            agent: name,
            pulse: {
              state: pulse.state,
              intensity: pulse.intensity,
              detector_kind: pulse.detector_kind,
              trip_id: pulse.trip_id,
              updated_at: pulse.updated_at,
            },
          },
        })
      },
      logger: this.log.child(`pulse-watcher/${name}`),
    })
    watcher.start()
    this.pulseWatchers.set(name, watcher)
  }

  /** Stop and forget the PulseWatcher for the named agent. Idempotent. */
  private stopPulseWatcher(name: string): void {
    const watcher = this.pulseWatchers.get(name)
    if (!watcher) return
    watcher.stop()
    this.pulseWatchers.delete(name)
  }

  /**
   * Send `agent.stop` to a running Agent and wait for graceful exit.
   *
   * Sets `intentionalStops` BEFORE the kill so `handleAgentExit` sees
   * the intent flag whether it fires synchronously (inside `tracked.stop`)
   * or asynchronously (microtask after we return). The flag is NOT
   * cleared here; `handleAgentExit` clears it after consuming it. This
   * fixes a microtask race observed 2026-05-12 where `stopAgent` cleared
   * the flag in a `finally` block, then `handleAgentExit` ran one tick
   * later, saw no flag, and auto-restarted the agent we'd just asked to
   * stop. Symptom: `agent stop X && agent start X` failed with "X is
   * already running" because the supervisor had already restarted X.
   */
  async stopAgent(name: string, reason = 'user_requested'): Promise<void> {
    this.intentionalStops.add(name)
    const tracked = this.tracked.get(name)
    if (!tracked) {
      // No tracked process — but an orphaned Agent process may still
      // hold the pid lock (this happens whenever the supervisor was
      // restarted while the Agent kept running, e.g., via the
      // `daemon restart --preserve-fleet` path or any earlier
      // supervisor restart). Treat the lock file as the source of
      // truth for "is this Agent alive?", not the in-memory `tracked`
      // map. Without this, `stopAgent` silently no-ops on orphans —
      // which breaks every flow that does stop+start (model switch,
      // identity edit, manual restart), because the subsequent
      // `startAgent` fails to acquire the lock the orphan still holds.
      await this.killOrphanedAgentIfAny(name, reason)
      this.intentionalStops.delete(name)
      await this.updateAgent(name, { state: 'stopped', pid: null })
      return
    }
    // Send the RPC; the Agent acks and then exits. After the OS process
    // exits, `handleAgentExit` updates the record. If the Agent is
    // unresponsive, `tracked.stop()` falls back to SIGKILL (5s timeout).
    const conn = this.findConnectionFor(name)
    if (conn) {
      try {
        // Best-effort: send the stop notification via the existing client
        // RPC server. We do not use a JsonRpcClient here because the
        // supervisor is the SERVER side of the connection. Sending a
        // request from the server side is reserved for a future change
        // where the supervisor owns a bidirectional client.
        // For v1, the supervisor signals stop by ending the connection
        // and sending SIGTERM/SIGKILL to the process.
        await conn.close()
      } catch {
        // ignore
      }
    }
    try {
      await tracked.stop()
      await this.updateAgent(name, { state: 'stopped', pid: null })
      this.log.info('Agent stopped', { name, reason })
    } catch (err) {
      // If the stop path itself errors, clear the flag so we don't leak
      // it and inadvertently suppress a future legitimate auto-restart.
      this.intentionalStops.delete(name)
      throw err
    }
  }

  /**
   * Detect and SIGTERM/SIGKILL an orphaned Agent process whose pid lock
   * is still held but which the supervisor's `tracked` map does not
   * know about. Orphans arise whenever the supervisor restarted while
   * the Agent kept running (the lock survives because Agents auto-
   * detach from the supervisor's lifecycle).
   *
   * No-op when the pid file is missing, the PID can't be parsed, the
   * lock is stale (process already dead), or the PID doesn't resolve
   * to a live process.
   *
   * Polls for graceful exit up to 2 seconds before escalating to
   * SIGKILL. The lock directory is removed in either case so a fresh
   * `startAgent` can acquire it cleanly.
   */
  private async killOrphanedAgentIfAny(name: string, reason: string): Promise<void> {
    const ap = agentPaths(this.state.home, name)
    let held: boolean
    try {
      held = await isLockHeld(ap.pidFile)
    } catch {
      return
    }
    if (!held) {
      // No live orphan. The pid file or lock dir may be stale (post-
      // crash leftovers); remove them so the next startAgent has a
      // clean slate. Best-effort.
      await this.cleanupStaleAgentLock(name)
      return
    }
    // The lock is held. Read the pid file to get the PID.
    let pid: number | null = null
    try {
      const { readFile } = await import('node:fs/promises')
      const raw = await readFile(ap.pidFile, 'utf-8')
      const parsed = Number.parseInt(raw.trim(), 10)
      if (Number.isInteger(parsed) && parsed > 0) pid = parsed
    } catch {
      // pid file unreadable — fall back to lock-only handling below.
    }
    if (pid === null) {
      // Lock dir exists but no PID we can SIGTERM. Treat as stale —
      // the lockfile library considers an empty lock dir "held"
      // because its mtime is recent, but there's nothing live to
      // signal. Clean up the leftover so the next startAgent has a
      // fresh slate.
      this.log.warn('Agent lock held but pid file unreadable; treating as stale', { name })
      await this.cleanupStaleAgentLock(name)
      return
    }
    this.log.info('orphaned Agent detected; signalling', { name, pid, reason })
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Process already gone; fall through to cleanup.
    }
    // Poll up to 2s for the lock to clear (graceful exit + lock release).
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 100))
      if (!(await isLockHeld(ap.pidFile).catch(() => true))) break
    }
    // Still held? SIGKILL the orphan.
    if (await isLockHeld(ap.pidFile).catch(() => false)) {
      try {
        process.kill(pid, 'SIGKILL')
        this.log.warn('orphaned Agent did not exit on SIGTERM; SIGKILLed', { name, pid })
      } catch {
        // Process already gone between checks.
      }
      // Give the OS a moment to reap before lock cleanup.
      await new Promise<void>((r) => setTimeout(r, 200))
    }
    await this.cleanupStaleAgentLock(name)
  }

  /**
   * Remove the Agent's pid file + lock directory. Used after killing
   * an orphan or to recover from a leftover-empty-lock-dir case.
   * Best-effort; logs but does not throw.
   */
  private async cleanupStaleAgentLock(name: string): Promise<void> {
    const ap = agentPaths(this.state.home, name)
    const { rm } = await import('node:fs/promises')
    await rm(`${ap.pidFile}.lock`, { recursive: true, force: true }).catch((err: unknown) => {
      this.log.warn('failed to remove stale Agent lock dir', {
        name,
        error: err instanceof Error ? err.message : String(err),
      })
    })
    await rm(ap.pidFile, { force: true }).catch((err: unknown) => {
      this.log.warn('failed to remove stale Agent pid file', {
        name,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  /**
   * Restart an Agent: stop the running process gracefully, then start
   * a fresh one. Used by the `cli.agent.restart_self` RPC (the Agent-
   * facing `restart_self` baseline tool) and any future operator-
   * triggered restart flow.
   *
   * The intentionalStops flag set by `stopAgent` is cleared at the end
   * so future auto-restart paths are not suppressed. If startAgent
   * fails after stopAgent succeeded, the error propagates and the
   * Agent is left in `stopped` state (operator can `2200 agent start
   * <name>` to recover); same semantics as a stop+start CLI sequence.
   */
  async restartAgent(name: string, reason = 'restart_self'): Promise<void> {
    if (!this.state.agents[name]) {
      throw new Error(`no Agent record for ${name}`)
    }
    await this.stopAgent(name, reason)
    // Brief settle so the process is fully gone before respawn.
    // Mirrors the daemon restart path (200ms grace before the new
    // process launches).
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    await this.startAgent(name)
    this.log.info('Agent restarted', { name, reason })
  }

  /**
   * Remove an Agent: stop the running process if any, clear the
   * in-memory record, persist the state change, and delete the
   * on-disk per-Agent directory tree under `<home>/agents/<name>/`.
   *
   * Used by the Epic 5 migration orchestrator's `--force` path to
   * make re-migration possible after a botched first attempt. No-op
   * (returns silently) if no Agent of the given name is registered.
   *
   * The brain index file at `<home>/state/brain/<name>/brain.db` is
   * left in place; the next BrainStore.write recreates it cleanly.
   * Notification files under `<home>/state/notifications/` belong
   * to the home, not the per-Agent dir, and are not removed here.
   */
  async removeAgent(name: string): Promise<void> {
    if (!this.state.agents[name]) return
    if (this.tracked.get(name)) {
      await this.stopAgent(name, 'remove_agent')
    }
    const next: Record<string, AgentRecord> = {}
    for (const [k, v] of Object.entries(this.state.agents)) {
      if (k !== name) next[k] = v
    }
    this.state.agents = next
    await saveState(this.state)
    const dir = dirname(agentPaths(this.state.home, name).identity)
    await rm(dir, { recursive: true, force: true })
    this.log.info('Agent removed', { name })
  }

  /**
   * Archive an Agent. Stops the running process, drops the Agent from
   * its pubs.md (so future starts attach no wake sources), cancels its
   * scheduled tasks, renames every per-Agent on-disk subtree (agents/,
   * state/agents/, state/brain/, state/budget/, state/credentials/,
   * state/identities/, state/telemetry/) from `<name>/` to
   * `<name>-archived-<YYYY-MM-DD>/`, rewrites identity.md so its
   * `agent_name` matches the new dir + adds an `archived` block, and
   * updates the supervisor record. The original name is freed for
   * reuse.
   *
   * Returns the chosen archived name (which may carry a `-2` suffix
   * if a same-day archive collision happened).
   */
  async archiveAgent(name: string, opts: { reason?: string } = {}): Promise<string> {
    const rec = this.state.agents[name]
    if (!rec) throw new Error(`no Agent record for ${name}`)
    if (rec.state === 'archived') throw new Error(`Agent ${name} is already archived`)

    const archivedName = pickArchiveName(this.state.home, name, todayUtc())
    const archivedAt = new Date().toISOString()

    // Stop the process (if any). Forces user-stop semantics so the
    // exit handler routes to 'stopped' rather than auto-restarting.
    if (this.tracked.get(name)) {
      await this.stopAgent(name, 'archive')
    }
    this.stopPulseWatcher(name)

    // Clear pubs.md so the archived Agent attaches no wake sources if
    // anyone re-starts it. (We won't, but defense in depth.)
    try {
      const pubsFile = agentPaths(this.state.home, name).pubsFile
      const existing = await readAgentPubsFile(pubsFile)
      if (existing && existing.pubs.length > 0) {
        await writeAgentPubsFile(pubsFile, name, [])
      }
    } catch (err) {
      this.log.warn('archive: failed to clear pubs.md; continuing', {
        name,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // Cancel scheduled tasks. Removing the schedules dir under the
    // OLD name avoids carrying stale entries through the rename ...
    // schedule entries embed `agent: <old-name>` and would otherwise
    // fire against a non-existent record post-rename.
    const stateAgentsDir = join(this.state.home, 'state', 'agents', name)
    await rm(stateAgentsDir, { recursive: true, force: true })
    try {
      await this.scheduler.reload()
    } catch (err) {
      this.log.warn('archive: scheduler reload failed; continuing', {
        name,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // Rewrite identity.md (agent_name + archived block) BEFORE the
    // rename ... the file is at the old path until renameAgentTrees
    // moves it.
    const identityPath = agentPaths(this.state.home, name).identity
    const raw = await readFile(identityPath, 'utf8')
    const updated = applyArchiveEdit(raw, {
      agent_name: archivedName,
      archived: {
        at: archivedAt,
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      },
    })
    await writeFile(identityPath, updated, 'utf8')

    // Move every per-Agent subtree.
    await renameAgentTrees(this.state.home, name, archivedName)

    // Rebuild the supervisor record under the new name and persist.
    const archivedRec: AgentRecord = {
      ...rec,
      name: archivedName,
      state: 'archived',
      pid: null,
      created_at: null,
      identity_path: agentPaths(this.state.home, archivedName).identity,
      current_task_id: null,
    }
    const nextAgents: Record<string, AgentRecord> = {}
    for (const [k, v] of Object.entries(this.state.agents)) {
      if (k === name) nextAgents[archivedName] = archivedRec
      else nextAgents[k] = v
    }
    this.state = { ...this.state, agents: nextAgents }
    await saveState(this.state)

    this.log.info('Agent archived', { from: name, to: archivedName })
    if (this.webHandle) {
      this.webHandle.broadcast({
        event: 'agent.archived',
        payload: { from: name, to: archivedName, archived_at: archivedAt },
      })
    }
    // Sweep any pending credential requests owned by the now-archived
    // Agent. The credential-requests directory lives at
    // <home>/state/credential-requests/ (flat, request-id-keyed) and
    // is NOT moved by renameAgentTrees, so the records' `agent` field
    // still references the original (pre-archive) name. Sweep under
    // that name. Reason=agent_archived so the operator UI distinguishes
    // from a plain timeout.
    void this.sweepCredentialRequestsForAgent(name, 'agent_archived').catch((err: unknown) => {
      this.log.warn('credential-request sweep on archive failed', {
        agent: name,
        error: err instanceof Error ? err.message : String(err),
      })
    })
    void this.regenerateFleetSafe()
    return archivedName
  }

  /**
   * Reverse `archiveAgent`. Renames the on-disk subtrees back to the
   * target name (default: strip the `-archived-<date>` suffix), clears
   * the `archived` frontmatter block, and restores the supervisor
   * record to the `stopped` state. Does NOT auto-start the Agent ...
   * the operator brings it back up explicitly.
   *
   * Refuses if the target name is already in use; the operator can
   * pass `rename_to` to pick a different available name.
   */
  async unarchiveAgent(name: string, opts: { rename_to?: string } = {}): Promise<string> {
    const rec = this.state.agents[name]
    if (!rec) throw new Error(`no Agent record for ${name}`)
    if (rec.state !== 'archived') throw new Error(`Agent ${name} is not archived`)

    const target = opts.rename_to ?? stripArchiveSuffix(name)
    if (!/^[a-z][a-z0-9_-]*$/.test(target)) {
      throw new Error(
        `unarchive target "${target}" is not a valid agent name (lowercase, digits, _, - only)`,
      )
    }
    if (target === name) {
      throw new Error(`unarchive target must differ from the archived name`)
    }
    if (this.state.agents[target]) {
      throw new Error(`agent name "${target}" is already in use; pass rename_to to pick another`)
    }

    // Rewrite identity.md to clear the archived block and restore the
    // agent_name. File is at the OLD (archived) path until the rename
    // below moves it.
    const identityPath = agentPaths(this.state.home, name).identity
    const raw = await readFile(identityPath, 'utf8')
    const updated = applyArchiveEdit(raw, { agent_name: target, archived: null })
    await writeFile(identityPath, updated, 'utf8')

    // Move every per-Agent subtree back to the target name.
    await renameAgentTrees(this.state.home, name, target)

    const restored: AgentRecord = {
      ...rec,
      name: target,
      state: 'stopped',
      pid: null,
      created_at: null,
      last_heartbeat: null,
      identity_path: agentPaths(this.state.home, target).identity,
    }
    const nextAgents: Record<string, AgentRecord> = {}
    for (const [k, v] of Object.entries(this.state.agents)) {
      if (k === name) nextAgents[target] = restored
      else nextAgents[k] = v
    }
    this.state = { ...this.state, agents: nextAgents }
    await saveState(this.state)

    this.log.info('Agent unarchived', { from: name, to: target })
    if (this.webHandle) {
      this.webHandle.broadcast({
        event: 'agent.unarchived',
        payload: { from: name, to: target },
      })
    }
    void this.regenerateFleetSafe()
    return target
  }

  /**
   * Permanently destroy a pub: stop the running pub-server process,
   * drop the supervisor record, and `rm -rf` the on-disk pub state
   * directory. The HTTP layer is responsible for updating affected
   * agents' pubs.md and restarting them BEFORE calling this so the
   * agents do not flap trying to reconnect to a vanished pub.
   *
   * Idempotent: a no-op when the pub record is absent. Caller is
   * responsible for refusing to call this on the canonical Studio.
   */
  async removePub(name: string): Promise<void> {
    if (!this.state.pubs[name]) return
    if (this.trackedPubs.get(name)) {
      this.pubStopRequested.add(name)
      try {
        await this.stopPub(name, 'remove_pub')
      } catch (err) {
        this.log.warn('removePub: stopPub failed; continuing with state cleanup', {
          name,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    const next: Record<string, PubRecord> = {}
    for (const [k, v] of Object.entries(this.state.pubs)) {
      if (k !== name) next[k] = v
    }
    this.state = { ...this.state, pubs: next }
    await saveState(this.state)
    await this.clearPubFromCreds(name)
    const pubDir = join(this.state.home, 'state', 'openpub', name)
    await rm(pubDir, { recursive: true, force: true })
    this.log.info('Pub removed', { name, dir: pubDir })
  }

  /**
   * After a pub is removed its store (agents.json) is deleted, so the per-pub
   * registration ids recorded in each cred are now stale. Clear them so a pub
   * later recreated under the SAME name re-registers fresh ... the idempotency
   * guard (ensureRegistered) trusts a recorded id and would otherwise skip
   * registration, leaving the Agent absent from the new pub. Best-effort: an
   * unreadable cred (never registered) is skipped, never blocks removal.
   */
  private async clearPubFromCreds(pubName: string): Promise<void> {
    const credPaths = [
      homePaths(this.state.home).configUserPubSecret,
      ...Object.keys(this.state.agents).map((n) => agentPaths(this.state.home, n).pubSecret),
    ]
    for (const credPath of credPaths) {
      try {
        const cred = await readCredentialFile(credPath)
        if (!cred.pub_agent_ids?.[pubName]) continue
        const nextMap = Object.fromEntries(
          Object.entries(cred.pub_agent_ids).filter(([k]) => k !== pubName),
        )
        await writeCredentialFile(credPath, { ...cred, pub_agent_ids: nextMap })
      } catch {
        // Missing/unreadable cred (Agent never registered) ... nothing to clear.
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Pub lifecycle (Epic 3 PR A)
  // ---------------------------------------------------------------------------

  /**
   * Register a new pub. Allocates a free local port, writes PUB.md,
   * adds the supervised child entry to state. Does NOT start the
   * pub-server process; callers run `startPub` after.
   *
   * Two-step (create then start) mirrors `createAgent` + `startAgent`
   * and lets the user inspect or edit PUB.md between create and first
   * start. Idempotency: throws if a pub by that name already exists.
   */
  async createPub(
    name: string,
    opts: {
      description?: string
      capacity?: number
      port?: number
      issuer?: 'local' | 'hub'
      hub_url?: string
      owner?: string
    } = {},
  ): Promise<{ port: number; pub_md_path: string }> {
    assertPubName(name)
    if (this.state.pubs[name]) {
      throw new Error(`Pub already exists: ${name}`)
    }
    const port = opts.port ?? (await findFreePort())
    // The PUB.md owner is the operator's pub handle, derived from the
    // user identity minted at first-run ... never a baked-in default.
    // An explicit opts.owner (tests, advanced callers) overrides.
    let owner = opts.owner
    if (owner === undefined) {
      const user = await loadUserIdentityIfExists(homePaths(this.state.home).configUserMd)
      if (!user) {
        throw new Error(
          `cannot create pub "${name}": no user identity exists to derive the pub owner from. ` +
            `Complete first-run (bare \`2200\`) or \`2200 user init\` first, or pass an explicit owner.`,
        )
      }
      owner = user.frontmatter.pub.handle.replace(/^@/, '')
    }
    const pubMd = composePubMd({
      name,
      owner,
      ...(opts.description !== undefined ? { description: opts.description } : {}),
      ...(opts.capacity !== undefined ? { capacity: opts.capacity } : {}),
    })
    await initPubDirs(this.state.home, name, pubMd)
    const paths = pubPaths(this.state.home, name)
    // Per-pub secret material (Epic 3 PR F): generate the admin secret
    // and signing keypair pub-server v0.3.3 requires in LOCAL_TRUST mode.
    // Persist mode 0600. Loaded into env on every cli.pub.start.
    const secrets = generatePubSecrets()
    await writePubSecrets({ adminSecret: paths.adminSecret, signingKey: paths.signingKey }, secrets)
    const record: PubRecord = {
      name,
      pub_md_path: paths.pubMd,
      port,
      state: 'stopped',
      pid: null,
      created_at: null,
      errored_at: null,
      errored_reason: null,
    }
    this.state = {
      ...this.state,
      pubs: { ...this.state.pubs, [name]: record },
    }
    await saveState(this.state)
    this.log.info('Pub record created', {
      name,
      port,
      pubMdPath: paths.pubMd,
      issuer: opts.issuer ?? 'local',
    })
    return { port, pub_md_path: paths.pubMd }
  }

  /**
   * Start the pub-server process for an existing pub record.
   * Idempotent: starting an already-running pub returns the current
   * pid without re-launching.
   */
  /**
   * Restart every running pub so it re-resolves the fleet subscription and
   * picks up a freshly-refreshed OAuth bearer. Called by the token-refresh
   * service after the fleet xai-oauth token rotates (~once per token lifetime,
   * not per tick). Best-effort + serial: a failure on one pub is logged and
   * does not block the rest.
   */
  private async restartRunningPubsForFreshFleetToken(): Promise<void> {
    const running = Object.entries(this.state.pubs)
      .filter(([, p]) => p.state === 'running')
      .map(([name]) => name)
    if (running.length === 0) return
    this.log.info('restarting pubs to pick up refreshed fleet token', { pubs: running })
    for (const name of running) {
      try {
        await this.stopPub(name, 'fleet_token_refresh')
        await this.startPub(name)
      } catch (err) {
        this.log.warn('pub restart after fleet-token refresh failed (continuing)', {
          pub: name,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  async startPub(
    name: string,
    opts: {
      issuer?: 'local' | 'hub'
      hub_url?: string
      executablePath?: string
    } = {},
  ): Promise<{ pid: number; port: number }> {
    const record = this.state.pubs[name]
    if (!record) {
      throw new Error(`no pub record for ${name}`)
    }
    const existing = this.trackedPubs.get(name)
    if (existing) {
      return { pid: existing.pid, port: record.port }
    }
    const paths = pubPaths(this.state.home, name)
    const secrets = await readPubSecrets({
      adminSecret: paths.adminSecret,
      signingKey: paths.signingKey,
    })
    // Wire the pub-server's own LLM (Bartender + memory fragments) onto the
    // fleet subscription. Without this it gets no credential, 401s, and the
    // failed broadcasts destabilize agent WebSockets (kicking them from the
    // room). When no subscription is active we omit the LLM_* vars so the
    // pub-server's patched guards make those features clean no-ops.
    const fleet = await resolveFleetDefaults(this.state.home)
    const pubEnv: Record<string, string> = {}
    if (fleet.pubServerLlm) {
      pubEnv['LLM_PROVIDER'] = fleet.pubServerLlm.provider
      pubEnv['LLM_BASE_URL'] = fleet.pubServerLlm.baseUrl
      pubEnv['LLM_API_KEY'] = fleet.pubServerLlm.apiKey
      pubEnv['LLM_MODEL'] = fleet.pubServerLlm.model
    }
    const tracked = launchPubProcess(
      {
        name,
        home: this.state.home,
        port: record.port,
        adminSecret: secrets.adminSecret,
        signingPrivateKey: secrets.signingPrivateKey,
        signingPublicKey: secrets.signingPublicKey,
        ...(Object.keys(pubEnv).length > 0 ? { env: pubEnv } : {}),
        ...(opts.issuer !== undefined ? { issuer: opts.issuer } : {}),
        ...(opts.hub_url !== undefined ? { hubUrl: opts.hub_url } : {}),
        ...(opts.executablePath !== undefined ? { executablePath: opts.executablePath } : {}),
      },
      this.log.child('pub-lifecycle'),
    )
    this.trackedPubs.set(name, tracked)
    // Order of operations matters here. Persist `state: 'running'`
    // FIRST and only THEN attach the exit handler. If we attach the
    // handler before awaiting the disk write, an immediate-exit child
    // (the abnormal-exit case) can fire the exit handler during the
    // running-update's await window, and the running-update would
    // race-overwrite the errored state. By attaching the handler
    // after the running-update settles, the exit handler always sees
    // the correct prior state. If the child has already exited by
    // the time we attach the handler, .then on the resolved promise
    // queues a microtask that runs immediately after this turn,
    // which is exactly what we want.
    await this.updatePub(name, {
      pid: tracked.pid,
      created_at: new Date().toISOString(),
      state: 'running',
    })
    void tracked.exited.then(({ code, signal }) => {
      void this.handlePubExit(name, code, signal)
    })
    return { pid: tracked.pid, port: record.port }
  }

  /**
   * Stop a running pub-server. Idempotent: stopping an already-stopped
   * pub records the state change but is otherwise a no-op.
   */
  async stopPub(name: string, reason = 'user_requested'): Promise<void> {
    const tracked = this.trackedPubs.get(name)
    if (!tracked) {
      await this.updatePub(name, { state: 'stopped', pid: null })
      return
    }
    // Mark intent BEFORE awaiting the actual stop so the exit handler
    // (which may race with us) sees the flag and routes to 'stopped'
    // rather than 'errored'.
    this.pubStopRequested.add(name)
    await tracked.stop()
    this.trackedPubs.delete(name)
    await this.updatePub(name, { state: 'stopped', pid: null })
    this.log.info('Pub stopped', { name, reason })
  }

  /** Read-only enumeration of pubs known to the supervisor. */
  listPubs(): PubListEntry[] {
    return Object.values(this.state.pubs).map((p) => ({
      name: p.name,
      state: p.state,
      port: p.port,
      pid: p.pid,
      created_at: p.created_at,
      errored_reason: p.errored_reason,
    }))
  }

  /** Detailed status for one pub. Throws if the pub doesn't exist. */
  pubStatus(name: string): PubRecord {
    const record = this.state.pubs[name]
    if (!record) {
      throw new Error(`no pub record for ${name}`)
    }
    return record
  }

  // ---------------------------------------------------------------------------
  // User identity (Epic 3 PR B)
  // ---------------------------------------------------------------------------

  /**
   * Initialize the user's pub identity. Generates an Ed25519 keypair,
   * persists the credential file at `<home>/config/user.pub.secret`
   * (mode 0600), writes `<home>/config/user.md`, and (if a pub is
   * available and running) registers against it via the v0.3.2
   * LOCAL_TRUST endpoints.
   *
   * Idempotent on re-run with the same display_name; refuses if a
   * different display_name is requested when user.md already exists
   * (force-overwrite is a deliberate user action: delete the file
   * by hand and re-run).
   *
   * `pickPub`: when zero pubs exist, registration is skipped and the
   * result reports `agent_id: null`. When exactly one exists, that
   * one is used. When multiple exist, the caller MUST pass a `pub`
   * name; otherwise this throws.
   */
  async createUserIdentity(opts: {
    display_name: string
    handle?: string
    pub?: string
    /** Test injection: override the identity-client factory. */
    identityClientFactory?: (baseUrl: string) => IdentityClient
  }): Promise<{
    user_md_path: string
    credentials_path: string
    agent_id: string | null
    registered_against: string | null
  }> {
    const paths = homePaths(this.state.home)
    const handle = opts.handle ?? defaultHandleFor(opts.display_name)

    // If user.md already exists, refuse on display_name mismatch;
    // otherwise treat as idempotent re-run.
    const existing = await loadUserIdentityIfExists(paths.configUserMd)
    if (existing && existing.frontmatter.display_name !== opts.display_name) {
      throw new Error(
        `user identity already exists with display_name "${existing.frontmatter.display_name}"; cannot change to "${opts.display_name}". Delete ${paths.configUserMd} to reset.`,
      )
    }

    const targetPub = pickTargetPub(this.state.pubs, opts.pub)
    if (opts.pub && !this.state.pubs[opts.pub]) {
      throw new Error(`no pub record for "${opts.pub}"`)
    }

    // If user.md already exists, reuse the existing credential file
    // (preserve the keypair on idempotent re-run). Otherwise mint a
    // fresh one.
    let cred
    if (existing) {
      cred = await readCredentialFile(paths.configUserPubSecret)
    } else {
      const issuerUrl = targetPub
        ? `local://127.0.0.1:${String(targetPub.port)}`
        : 'local://unregistered'
      cred = generateKeypair({ display_name: opts.display_name, issuer_url: issuerUrl })
      await writeCredentialFile(paths.configUserPubSecret, cred)
    }

    let agentId: string | null = cred.agent_id
    let registeredAgainst: string | null = null
    if (targetPub?.state === 'running') {
      const baseUrl = `http://127.0.0.1:${String(targetPub.port)}`
      const client = opts.identityClientFactory
        ? opts.identityClientFactory(baseUrl)
        : createIdentityClient({ baseUrl })
      try {
        const targetPubPaths = pubPaths(this.state.home, targetPub.name)
        const pubSecrets = await readPubSecrets({
          adminSecret: targetPubPaths.adminSecret,
          signingKey: targetPubPaths.signingKey,
        })
        const updated = await ensureRegistered(client, cred, pubSecrets.adminSecret, targetPub.name)
        const registeredId = updated.pub_agent_ids?.[targetPub.name] ?? updated.agent_id
        if (registeredId) {
          agentId = registeredId
          registeredAgainst = targetPub.name
          // Persist the updated credential (with per-pub agent_id map) to disk.
          await writeCredentialFile(paths.configUserPubSecret, updated)
        }
      } catch (err) {
        this.log.warn('user identity registration failed; will retry on next run', {
          pub: targetPub.name,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const frontmatter: UserIdentityFrontmatter = {
      schema_version: 1,
      display_name: opts.display_name,
      // Setup mints with a defaulted name ($USER); only the operator setting
      // their name in-app flips this true (see setUserDisplayName). Preserve
      // it on an idempotent re-run.
      name_set_by_operator: existing?.frontmatter.name_set_by_operator ?? false,
      pub: {
        identity: agentId ?? '',
        handle,
        credentials: { source: 'file', id: paths.configUserPubSecret },
        key_version: cred.key_version,
        issuer_url: cred.issuer_url,
      },
      scut: {},
      created: existing?.frontmatter.created ?? today(),
    }
    await writeUserIdentity(paths.configUserMd, frontmatter, existing?.body ?? '')
    this.log.info('User identity initialized', {
      display_name: opts.display_name,
      handle,
      agent_id: agentId,
      registered_against: registeredAgainst,
    })
    return {
      user_md_path: paths.configUserMd,
      credentials_path: paths.configUserPubSecret,
      agent_id: agentId,
      registered_against: registeredAgainst,
    }
  }

  /**
   * Set (or change) the operator's display name. Unlike createUserIdentity,
   * this ALLOWS changing an existing name ... the operator owns it. It backs
   * both the first-run "what should we call you?" ask and Settings → Your
   * name. It marks the name operator-set, then re-registers the operator in
   * the studio pub under the new name so the room reflects it immediately.
   *
   * The keypair is preserved (identity continuity). The pub-server (0.3.3)
   * keys on display_name with no key-idempotency and no delete route, so a
   * rename mints a fresh agent_id and the prior "name" registration is left
   * inert in the store ... hidden by the member view's stale-shadow collapse.
   */
  async setUserDisplayName(opts: {
    display_name: string
    handle?: string
  }): Promise<{ display_name: string; handle: string; registered_against: string | null }> {
    const display_name = opts.display_name.trim()
    if (!display_name) throw new Error('display_name cannot be empty')
    const paths = homePaths(this.state.home)
    const existing = await loadUserIdentityIfExists(paths.configUserMd)
    if (!existing) {
      throw new Error('no user identity yet; run setup before naming the operator')
    }
    const handle = opts.handle ?? defaultHandleFor(display_name)
    const nameChanged = existing.frontmatter.display_name !== display_name

    let cred = await readCredentialFile(paths.configUserPubSecret)
    const studio = this.state.pubs['studio']
    let agentId: string | null = existing.frontmatter.pub.identity || null
    let registeredAgainst: string | null = null

    if (nameChanged) {
      // Force a fresh registration under the new name: clear the studio
      // record so the idempotency short-circuit doesn't skip the re-register.
      const nextPubAgentIds = { ...(cred.pub_agent_ids ?? {}) }
      delete nextPubAgentIds['studio']
      cred = { ...cred, display_name, pub_agent_ids: nextPubAgentIds, agent_id: null }
      await writeCredentialFile(paths.configUserPubSecret, cred)
    }

    if (studio?.state === 'running') {
      const baseUrl = `http://127.0.0.1:${String(studio.port)}`
      const client = createIdentityClient({ baseUrl })
      try {
        const sp = pubPaths(this.state.home, 'studio')
        const secrets = await readPubSecrets({
          adminSecret: sp.adminSecret,
          signingKey: sp.signingKey,
        })
        const updated = await ensureRegistered(client, cred, secrets.adminSecret, 'studio')
        const id = updated.pub_agent_ids?.['studio'] ?? updated.agent_id
        if (id) {
          agentId = id
          registeredAgainst = 'studio'
        }
        await writeCredentialFile(paths.configUserPubSecret, updated)
        cred = updated
      } catch (err) {
        // On a name change the cred was already cleared (agent_id=null) before
        // the failed register, so user.md must mirror that ... not the old id.
        // The studio bootstrap re-registers on the next boot.
        if (nameChanged) agentId = null
        this.log.warn('operator rename: studio re-registration failed (retries next boot)', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const frontmatter: UserIdentityFrontmatter = {
      schema_version: 1,
      display_name,
      name_set_by_operator: true,
      pub: {
        identity: agentId ?? existing.frontmatter.pub.identity,
        handle,
        credentials: existing.frontmatter.pub.credentials,
        key_version: cred.key_version,
        issuer_url: cred.issuer_url,
      },
      scut: existing.frontmatter.scut,
      created: existing.frontmatter.created,
    }
    await writeUserIdentity(paths.configUserMd, frontmatter, existing.body)
    this.log.info('Operator display name set', {
      display_name,
      handle,
      registered_against: registeredAgainst,
    })
    return { display_name, handle, registered_against: registeredAgainst }
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
      'agent.chatMessage': (params, ctx: HandlerContext) => {
        // Agent-side appends (e.g. credential_request tool inserting a
        // credential_request_v1 system-role message into the chat
        // thread) bypass the HTTP route's broadcast path. Fanout here
        // mirrors the broadcastChatEvent('chat.message', ...) call
        // that HTTP handlers make on operator-driven appends so the
        // web's useLiveSignal hook invalidates the messages query and
        // re-fetches.
        const name = this.agentByConnection.get(ctx.connection)
        if (!name) return { ack: true as const }
        if (this.webHandle) {
          this.webHandle.broadcast({
            event: 'chat.message',
            payload: {
              agent: name,
              chat_id: params.chat_id,
              message_id: params.message_id,
              role: params.role,
              kind: params.kind ?? null,
              at: new Date().toISOString(),
            },
          })
        }
        return { ack: true as const }
      },
      'agent.toolEvent': (params, ctx: HandlerContext) => {
        // Pass-through fanout: each tool call start/end becomes a
        // WebSocket event the web app's ToolStream subscribes to.
        // Also nudges the agents-list query to refetch so the Fleet
        // pulse dot updates instantly instead of waiting for the
        // next 2s poll cycle.
        const name = this.agentByConnection.get(ctx.connection)
        if (!name) return { ack: true as const }
        this.log.info('tool event', {
          agent: name,
          kind: params.kind,
          tool: params.tool,
          arg_summary: params.arg_summary ?? null,
          ws_subscribers: this.webHandle ? 'connected' : 'no_web',
        })
        if (this.webHandle) {
          this.webHandle.broadcast({
            event: 'agent.tool_event',
            payload: {
              agent: name,
              kind: params.kind,
              task_id: params.task_id,
              call_id: params.call_id,
              tool: params.tool,
              arg_summary: params.arg_summary ?? null,
              ok: params.ok ?? null,
              error_class: params.error_class ?? null,
              duration_ms: params.duration_ms ?? null,
              at: new Date().toISOString(),
            },
          })
        }
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
        await this.createAgent(params.name, params.identity_path, {
          ...(params.pub !== undefined ? { pub: params.pub } : {}),
        })
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
            // Preserve the trip context for the loop to read on pickup so it
            // can inject a forcing message that discourages retrying the
            // broken thing. Overwrites any previous resume snapshot, which is
            // the right semantic: only the most recent trip matters.
            resumed_from_trip: fm.detector_block,
            detector_block: null,
          }))
          resumedId = target.frontmatter.id
        }
        await resetPulseToGreen({ home: this.state.home, agentName: params.name })
        await this.updateAgent(params.name, { state: 'running' })
        this.log.info('Agent resumed', { name: params.name, resumed_task_id: resumedId })
        return { ok: true as const, resumed_task_id: resumedId }
      },
      'cli.agent.restart_self': (params) => {
        // Agent-self-restart (from the `restart_self` baseline tool).
        // Scheduled for next tick (500ms) so the calling tool's RPC
        // response flushes back to the Agent's loop before the
        // process is recycled. The RPC returns immediately with
        // scheduled_at; the actual stop+start happens shortly after.
        //
        // Security note: the `name` param is locked to ctx.callingAgent
        // by the calling tool (no caller-supplied target). Cross-Agent
        // restart goes through the operator (cli.agent.stop +
        // cli.agent.start), not through this RPC.
        if (!this.state.agents[params.name]) {
          throw new Error(`no Agent record for ${params.name}`)
        }
        const scheduledAt = new Date().toISOString()
        setTimeout(() => {
          void this.restartAgent(params.name, params.reason ?? 'restart_self').catch(
            (err: unknown) => {
              this.log.error('scheduled self-restart failed', {
                name: params.name,
                error: err instanceof Error ? err.message : String(err),
              })
            },
          )
        }, 500)
        this.log.info('self-restart scheduled', {
          name: params.name,
          reason: params.reason ?? 'restart_self',
          scheduled_at: scheduledAt,
        })
        return { ok: true as const, scheduled_at: scheduledAt }
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
      // Pub lifecycle (Epic 3 PR A). Routes through the running daemon
      // so in-memory state and on-disk state stay consistent.
      'cli.pub.create': async (params) => {
        const out = await this.createPub(params.name, {
          ...(params.description !== undefined ? { description: params.description } : {}),
          ...(params.capacity !== undefined ? { capacity: params.capacity } : {}),
          ...(params.port !== undefined ? { port: params.port } : {}),
          ...(params.issuer !== undefined ? { issuer: params.issuer } : {}),
          ...(params.hub_url !== undefined ? { hub_url: params.hub_url } : {}),
        })
        return {
          ok: true as const,
          name: params.name,
          port: out.port,
          pub_md_path: out.pub_md_path,
        }
      },
      'cli.pub.start': async (params) => {
        const out = await this.startPub(params.name)
        return { ok: true as const, pid: out.pid, port: out.port }
      },
      'cli.pub.stop': async (params) => {
        await this.stopPub(params.name, params.reason ?? 'cli_request')
        return { ok: true as const }
      },
      'cli.pub.list': () => {
        return { pubs: this.listPubs() }
      },
      'cli.pub.status': (params) => {
        return this.pubStatus(params.name)
      },
      'cli.user.init': async (params) => {
        const out = await this.createUserIdentity({
          display_name: params.display_name,
          ...(params.handle !== undefined ? { handle: params.handle } : {}),
          ...(params.pub !== undefined ? { pub: params.pub } : {}),
        })
        return {
          ok: true as const,
          user_md_path: out.user_md_path,
          credentials_path: out.credentials_path,
          agent_id: out.agent_id,
          registered_against: out.registered_against,
        }
      },

      'cli.user.get': async () => {
        const existing = await loadUserIdentityIfExists(homePaths(this.state.home).configUserMd)
        return {
          identity: existing
            ? {
                display_name: existing.frontmatter.display_name,
                handle: existing.frontmatter.pub.handle,
                name_set_by_operator: existing.frontmatter.name_set_by_operator,
              }
            : null,
        }
      },

      'cli.user.set-name': async (params) => {
        const out = await this.setUserDisplayName({
          display_name: params.display_name,
          ...(params.handle !== undefined ? { handle: params.handle } : {}),
        })
        return {
          ok: true as const,
          display_name: out.display_name,
          handle: out.handle,
          registered_against: out.registered_against,
        }
      },

      // Schedules (Epic 6 PR C). Mutations write to disk first, then
      // ask the running Scheduler to reload so a live daemon picks up
      // changes without a restart.
      'cli.schedule.add': async (params) => {
        if (!this.state.agents[params.agent]) {
          throw new Error(`no Agent record for ${params.agent}`)
        }
        const entry = await persistCreateSchedule({
          home: this.state.home,
          agentName: params.agent,
          prompt: params.prompt,
          ...(params.description !== undefined ? { description: params.description } : {}),
          timing: params.timing,
        })
        await this.scheduler.reload()
        this.log.info('schedule added', {
          agent: params.agent,
          id: entry.id,
          next_fire_at: entry.next_fire_at,
        })
        return { ok: true as const, id: entry.id, next_fire_at: entry.next_fire_at }
      },

      'cli.schedule.list': async (params) => {
        const targets = params.agent ? [params.agent] : Object.keys(this.state.agents)
        if (params.agent && !this.state.agents[params.agent]) {
          throw new Error(`no Agent record for ${params.agent}`)
        }
        const entries: ScheduleListEntry[] = []
        for (const name of targets) {
          const list = await persistListSchedules(this.state.home, name)
          for (const e of list) {
            entries.push(toListEntry(e))
          }
        }
        entries.sort((a, b) => a.created_at.localeCompare(b.created_at))
        return { entries }
      },

      'cli.schedule.remove': async (params) => {
        if (!this.state.agents[params.agent]) {
          throw new Error(`no Agent record for ${params.agent}`)
        }
        await persistDeleteSchedule(this.state.home, params.agent, params.id)
        await this.scheduler.reload()
        this.log.info('schedule removed', { agent: params.agent, id: params.id })
        return { ok: true as const }
      },

      'cli.schedule.set-enabled': async (params) => {
        if (!this.state.agents[params.agent]) {
          throw new Error(`no Agent record for ${params.agent}`)
        }
        const updated = await persistSetScheduleEnabled(
          this.state.home,
          params.agent,
          params.id,
          params.enabled,
        )
        await this.scheduler.reload()
        this.log.info('schedule set-enabled', {
          agent: params.agent,
          id: params.id,
          enabled: params.enabled,
        })
        return { ok: true as const, next_fire_at: updated.next_fire_at }
      },

      'cli.schedule.run-once': async (params) => {
        if (!this.state.agents[params.agent]) {
          throw new Error(`no Agent record for ${params.agent}`)
        }
        const taskId = await this.scheduler.runOnce(params.agent, params.id)
        this.log.info('schedule run-once', {
          agent: params.agent,
          id: params.id,
          task_id: taskId,
        })
        return { ok: true as const, task_id: taskId }
      },

      'cli.scheduler.reload': async () => {
        const armed = await this.scheduler.reload()
        this.log.info('scheduler reloaded via cli', { armed })
        return { ok: true as const, armed }
      },

      'cli.build.from-handoff': async (params) => {
        const { migrateFromHandoff } = await import('../migration/orchestrator.js')
        const result = await migrateFromHandoff({
          handoff: {
            frontmatter: params.handoff.frontmatter,
            body: params.handoff.body,
            source_path: params.handoff.source_path,
          },
          home: this.state.home,
          supervisor: this,
          today: new Date(),
          seedFirstTask: true,
          ...(params.force === true ? { force: true } : {}),
        })
        this.log.info('agent built via cli.build.from-handoff', {
          name: result.agent_name,
          identity_path: result.identity_path,
        })
        return {
          agent_name: result.agent_name,
          identity_path: result.identity_path,
          continuity_note_slug: result.continuity_note_slug,
          brain_imported_count: result.brain_imported_count,
          notification_id: result.notification_id,
        }
      },
      'cli.connector.status': async () => {
        return this.getConnectorStatusDetailed()
      },
      'cli.connector.regenerate': async () => {
        const { token } = await this.regenerateConnectorBearer()
        return { token }
      },
      'cli.connector.disable': async () => {
        await this.disableConnector()
        return { disabled: true as const }
      },
      'cli.connector.synthesis.unblock': async (params) => {
        await this.clearSynthesisBlocked(params.thread_slug)
        return { unblocked: true as const }
      },
      'cli.connector.work-package.approve': async (params) => {
        const { followOnTaskIds } = await this.approveWorkPackage(params.package_id)
        return { approved: true as const, follow_on_task_ids: followOnTaskIds }
      },
      'cli.connector.work-package.reject': async (params) => {
        await this.rejectWorkPackage(params.package_id, params.reason ?? null)
        return { rejected: true as const }
      },
      'cli.connector.oauth-client.register': async (params) => {
        const result = await this.registerOAuthClient({
          displayName: params.display_name,
          redirectUris: params.redirect_uris,
          ...(params.mint_secret !== undefined ? { mintSecret: params.mint_secret } : {}),
          ...(params.scopes_allowed !== undefined ? { scopesAllowed: params.scopes_allowed } : {}),
        })
        return {
          client_id: result.clientId,
          client_secret: result.clientSecret,
          redirect_uris: result.redirectUris,
          scopes_allowed: result.scopesAllowed,
          registered_at: result.registeredAt,
        }
      },
      'cli.connector.oauth-client.list': async () => {
        const items = await this.listOAuthClients()
        return {
          items: items.map((c) => ({
            client_id: c.clientId,
            display_name: c.displayName,
            redirect_uris: c.redirectUris,
            has_secret: c.hasSecret,
            scopes_allowed: c.scopesAllowed,
            registered_at: c.registeredAt,
            last_authorize_at: c.lastAuthorizeAt,
            revoked_at: c.revokedAt,
          })),
        }
      },
      'cli.connector.oauth-client.revoke': async (params) => {
        const { removedRefresh, removedAccess } = await this.revokeOAuthClient(params.client_id)
        return {
          revoked: true as const,
          removed_refresh: removedRefresh,
          removed_access: removedAccess,
        }
      },
      'cli.connector.oauth-client.rotate-secret': async (params) => {
        const { clientId, clientSecret } = await this.rotateOAuthClientSecret(params.client_id)
        return { client_id: clientId, client_secret: clientSecret }
      },
      'cli.connector.mcp.register': async (params) => {
        const result = await this.registerEmbassy({
          clientId: params.client_id,
          externalModel: params.external_model,
          embassyAgent: params.embassy_agent,
          mode: params.mode,
          displayName: params.display_name,
          registeredBy: 'cli',
          ...(params.model !== undefined
            ? {
                model: params.model as IdentityFrontmatter['model'],
              }
            : {}),
          ...(params.tools !== undefined ? { tools: params.tools } : {}),
        })
        return {
          client_id: result.conduit.client_id,
          embassy_agent: result.conduit.embassy_agent,
          mode: result.conduit.mode,
          agent_created: result.agentCreated,
          registered_at: result.conduit.registered_at,
        }
      },
      'cli.connector.mcp.list': async () => {
        const items = await this.listConduits()
        return {
          items: items.map((c) => ({
            client_id: c.client_id,
            external_model: c.external_model,
            embassy_agent: c.embassy_agent,
            mode: c.mode,
            display_name: c.display_name,
            registered_at: c.registered_at,
            last_seen_at: c.last_seen_at,
            retired_at: c.retired_at,
          })),
        }
      },
      'cli.connector.mcp.retire': async (params) => {
        await this.retireConduit(params.client_id)
        return { retired: true as const }
      },
      'cli.connector.mcp.shelf.approve': async (params) => {
        const { shelfItemId, embassyAgent } = await this.approveShelfPlacement({
          approvalToken: params.approval_token,
          operatorName: params.operator_name ?? 'operator',
        })
        return { shelf_item_id: shelfItemId, embassy_agent: embassyAgent }
      },
      'cli.connector.mcp.shelf.reject': async (params) => {
        await this.rejectShelfPlacement({ approvalToken: params.approval_token })
        return { rejected: true as const }
      },
    }
  }

  private async handleAgentExit(
    name: string,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    this.tracked.delete(name)
    this.stopPulseWatcher(name)
    const record = this.state.agents[name]
    if (!record) return
    if (record.state === 'errored') {
      // Already updated by agent.errored RPC.
      return
    }

    // Was this exit operator-initiated? Then no restart; transition to stopped.
    // The flag is a one-shot: consume it here so a subsequent unexpected
    // exit isn't suppressed.
    const intentional = this.intentionalStops.delete(name)
    if (intentional) {
      // User-requested stop. Always transition to 'stopped' regardless
      // of how the OS reported the exit: SIGTERM-ack with code 0 looks
      // identical to a SIGKILL with code=null, but both express the
      // same operator intent. Marking either as 'errored' wedges the
      // Agent and blocks the follow-up startAgent that the Studio-
      // membership-change flow expects.
      await this.updateAgent(name, {
        state: 'stopped',
        pid: null,
      })
      this.log.info('Agent process exited', {
        name,
        code,
        signal,
        nextState: 'stopped',
        intentional: true,
      })
      return
    }
    if (this.isShuttingDown) {
      // Daemon-driven shutdown: the operator didn't ask for this Agent to
      // stop, they asked for the supervisor to stop. Preserve the Agent's
      // last live state (running / waiting / blocked_*) so the next boot's
      // state-recovery pass revives it. Only the pid is cleared.
      //
      // The "is this a crash?" call: a non-zero exit code OR a fatal
      // signal other than the SIGTERM we sent is a real crash; anything
      // else (clean exit 0, SIGTERM, or the weird code=null signal=null
      // case where Node child_process couldn't capture the exit info
      // before the parent went down) is benign. The original "code===0
      // && signal===null" condition was too strict ... it conflated
      // "Agent gracefully exited" with "Agent's exit info was lost in
      // the shutdown race" and wedged Agents like Jodin into errored
      // state on what was really just a polite SIGTERM. Doctor tab
      // catches the residual stuck-in-errored cases this fix doesn't
      // get to retroactively.
      const isCrash = (code !== null && code !== 0) || (signal !== null && signal !== 'SIGTERM')
      const nextState: AgentRecord['state'] = isCrash ? 'errored' : record.state
      await this.updateAgent(name, {
        state: nextState,
        pid: null,
        errored_at: nextState === 'errored' ? new Date().toISOString() : record.errored_at,
        errored_reason:
          nextState === 'errored'
            ? `process exited during daemon shutdown code=${String(code)} signal=${String(signal)}`
            : record.errored_reason,
      })
      this.log.info('Agent process exited during shutdown', {
        name,
        code,
        signal,
        nextState,
        will_revive_next_boot: nextState !== 'errored',
      })
      return
    }

    // Unexpected exit. Apply the restart budget: max 3 restarts in 60s. The
    // budget prevents a misbehaving agent from triggering a start-crash-start
    // tight loop. After exhausting the budget, the agent is left errored so
    // the operator can investigate.
    const now = Date.now()
    const recent = (this.restartHistory.get(name) ?? []).filter((t) => now - t < 60_000)
    if (recent.length >= 3) {
      this.log.warn('Agent crashed too many times in 60s; not restarting', {
        name,
        code,
        signal,
        recent_restarts: recent.length,
      })
      await this.updateAgent(name, {
        state: 'errored',
        pid: null,
        errored_at: new Date().toISOString(),
        errored_reason: `crashed ${String(recent.length + 1)} times in 60s (code=${String(code)} signal=${String(signal)}); auto-restart budget exhausted`,
      })
      return
    }
    recent.push(now)
    this.restartHistory.set(name, recent)

    this.log.warn('Agent process exited unexpectedly; auto-restarting', {
      name,
      code,
      signal,
      attempt: recent.length,
    })

    // Best-effort restart. If startAgent throws, fall through to errored.
    try {
      await this.startAgent(name)
      this.log.info('Agent auto-restarted', { name, attempt: recent.length })
    } catch (err) {
      this.log.warn('auto-restart failed', {
        name,
        error: err instanceof Error ? err.message : String(err),
      })
      await this.updateAgent(name, {
        state: 'errored',
        pid: null,
        errored_at: new Date().toISOString(),
        errored_reason: `auto-restart failed after exit code=${String(code)} signal=${String(signal)}: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
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
    if (this.webHandle && existing.state !== next.state) {
      this.webHandle.broadcast({
        event: 'agent.status_changed',
        payload: {
          agent: name,
          old_status: existing.state,
          new_status: next.state,
        },
      })
    }
    // Regenerate Fleet.md when membership-shaping fields change.
    // Heartbeat-only updates (last_heartbeat, current_task_id, pid)
    // do not influence the fleet's content, so we skip the rebuild
    // for those. The regenerate function itself also no-ops on
    // identical content, so this is a defensive fast-path.
    if (
      existing.state !== next.state ||
      existing.identity_path !== next.identity_path ||
      existing.errored_reason !== next.errored_reason
    ) {
      void this.regenerateFleetSafe()
    }
  }

  /**
   * Fire-and-forget fleet regeneration. Called after every event that
   * could change the fleet's contents (agent create / start / stop /
   * identity update). Logs failures but never propagates them ... a
   * fleet write failure should never tank a lifecycle event.
   */
  private async regenerateFleetSafe(): Promise<void> {
    try {
      await regenerateFleet({
        home: this.state.home,
        paths: homePaths(this.state.home),
        state: this.state,
        logger: this.log.child('fleet'),
      })
    } catch (err) {
      this.log.warn('fleet regeneration failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    // Mirror the fleet snapshot into the shared brain as the "team"
    // note so freshly-started Agents can read it via brain.* without
    // traversing the supervisor state file. Failures here are
    // non-fatal: the fleet.md regen above already provides the
    // ground-truth surface; this is the orientation surface for
    // Agents.
    try {
      await regenerateTeamNote(this.state.home, this)
    } catch (err) {
      this.log.warn('team note regeneration failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Seed the shared brain's starter pack (platform overview, tool
   * reference, conventions, workflows) if any are absent. Called
   * once at supervisor.start(). Idempotent on re-run; existing
   * notes are not overwritten.
   */
  private async seedSharedBrainSafe(): Promise<void> {
    try {
      await seedStarterPack(this.state.home)
    } catch (err) {
      this.log.warn('shared brain starter-pack seed failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: pub lifecycle helpers (Epic 3 PR A)
  // ---------------------------------------------------------------------------

  private async handlePubExit(
    name: string,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    this.trackedPubs.delete(name)
    const record = this.state.pubs[name]
    if (!record) return
    const wasRequested = this.pubStopRequested.delete(name)
    if (wasRequested) {
      // The supervisor (via stopPub or shutdown) initiated the exit;
      // the eventual `updatePub({state: 'stopped'})` call in stopPub
      // is the one that should determine final state. No-op here.
      return
    }
    // Unsolicited exit. The pub-server is supposed to keep running
    // until stopPub asks it to stop, so any exit not driven by us is
    // an error condition regardless of the exit code.
    await this.updatePub(name, {
      state: 'errored',
      pid: null,
      errored_at: new Date().toISOString(),
      errored_reason: `pub-server exited code=${String(code)} signal=${String(signal)}`,
    })
    this.log.warn('Pub process exited unexpectedly', { name, code, signal })
  }

  private async updatePub(name: string, patch: Partial<PubRecord>): Promise<void> {
    const existing = this.state.pubs[name]
    if (!existing) return
    const next: PubRecord = { ...existing, ...patch }
    this.state = {
      ...this.state,
      pubs: { ...this.state.pubs, [name]: next },
    }
    await saveState(this.state)
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers (Epic 3 PR B)
// ---------------------------------------------------------------------------

/**
 * Resolve which pub to register a new identity against. Rules:
 *  - explicit `requested` name wins (caller is asserting)
 *  - exactly one pub: use it
 *  - zero pubs: return null (registration deferred)
 *  - multiple pubs: throw (caller must specify)
 *
 * Returns the matching record or null. Throws on ambiguity.
 */
/**
 * Build a default pub block for an Agent whose Identity does not
 * declare one. Used by createAgent so every Agent gets a pub
 * provisioning pass by default ... "every Agent at all times in
 * the Studio."
 *
 * The supervisor's provisionAgentPubIdentity fills in the runtime
 * fields (identity UUID, issuer_url) once the keypair is minted and
 * registered with the chosen pub.
 */
function synthesizeDefaultPubBlock(home: string, agentName: string): AgentPubBlock {
  return {
    identity: '',
    display_name: agentName,
    handle: `@${agentName}`,
    credentials: {
      source: 'file' as const,
      id: agentPaths(home, agentName).pubSecret,
    },
    key_version: 1,
    issuer_url: '',
    domains: [],
    member_of: [],
  }
}

function pickTargetPub(
  pubs: Readonly<Record<string, PubRecord>>,
  requested: string | undefined,
): PubRecord | null {
  if (requested) {
    return pubs[requested] ?? null
  }
  const all = Object.values(pubs)
  if (all.length === 0) return null
  if (all.length === 1) return all[0] ?? null
  // With multiple pubs and no explicit pick, prefer `studio` (the
  // canonical team room) so the web onboarding flow can land a new
  // Agent in the right place without forcing a picker UI. Operator
  // can move them via the Studio guests editor later. Falls back to
  // the alphabetically-first pub if no `studio` exists so the rule
  // is deterministic regardless of pub-creation order.
  const studio = pubs['studio']
  if (studio) return studio
  const sorted = all.slice().sort((a, b) => a.name.localeCompare(b.name))
  return sorted[0] ?? null
}

/** Default handle: lowercase the display_name and strip whitespace. */
function defaultHandleFor(displayName: string): string {
  const base = displayName.toLowerCase().replace(/\s+/g, '')
  return base.startsWith('@') ? base : `@${base}`
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Cheap process-alive probe: signal 0 just checks permission to
 * signal the pid, doesn't actually deliver one. Returns false on
 * ESRCH (no such process) or any other error.
 *
 * Implementation moved to ./lifecycle.ts; this comment block kept here
 * for the next reader who searches supervisor.ts for the function name.
 */

/**
 * SIGKILL whatever is listening on `port`. Used during boot recovery
 * to clear a pub-server orphan left over from a force-killed prior
 * supervisor before re-launching a fresh one on the same port.
 *
 * Best-effort: if `lsof` is missing or returns nothing, we no-op.
 * Failures are logged at warn but never thrown.
 */
async function killOrphanOnPort(port: number, log: Logger): Promise<void> {
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const exec = promisify(execFile)
    const { stdout } = await exec('lsof', ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-t'])
    const pids = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n > 0)
    if (pids.length === 0) return
    for (const pid of pids) {
      log.info('boot: killing orphan process holding pub port', { pid, port })
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone; race with the OS reaper, fine.
      }
    }
    // Settle for the kernel to actually release the listener so the
    // imminent launch doesn't hit EADDRINUSE.
    await new Promise((r) => setTimeout(r, 400))
  } catch (err) {
    // lsof is missing or otherwise failed. Probably non-fatal: if
    // there really is an orphan, the launch that follows will hit
    // EADDRINUSE and surface a clear error. Linux/Alpine images
    // sometimes lack lsof; that's a packaging concern, not a runtime
    // one.
    log.warn('boot: lsof failed; cannot reclaim orphan port', {
      port,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

function toListEntry(e: ScheduleEntry): ScheduleListEntry {
  return {
    id: e.id,
    agent: e.agent,
    description: e.description,
    prompt: e.prompt,
    timing: e.timing,
    enabled: e.enabled,
    created_at: e.created_at,
    last_fired_at: e.last_fired_at,
    next_fire_at: e.next_fire_at,
  }
}
