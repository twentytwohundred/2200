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
import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { JsonRpcServer, type Handlers, type HandlerContext } from '../control-plane/server.js'
import { listenUds } from '../control-plane/transport-uds.js'
import type { Connection, Listener } from '../control-plane/transport.js'
import { saveState, loadState } from './state.js'
import { type SupervisorState, type AgentRecord, type PubRecord } from './types.js'
import { spawnAgent, type SpawnedAgent, type SpawnAgentOptions } from './lifecycle.js'
import { spawnPub, composePubMd, type SpawnedPub } from './pub-lifecycle.js'
import { loadIdentity, writeIdentity } from '../identity/loader.js'
import { homePaths, agentPaths, pubPaths, assertPubName } from '../storage/layout.js'
import { initHome, initAgentDirs, initPubDirs } from '../storage/init.js'
import { createLogger, type Logger } from '../util/logger.js'
import { TaskStore } from '../agent/task/store.js'
import { newPendingTask } from '../agent/task/types.js'
import { newTaskId } from '../util/id.js'
import { findFreePort } from '../util/free-port.js'
import type { TaskListEntry, PubListEntry } from '../control-plane/protocol.js'
import { resetPulseToGreen } from '../agent/detectors/trip-record.js'
import { generateKeypair, writeCredentialFile, readCredentialFile } from '../pub/keypair.js'
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
import type { ScheduleListEntry } from '../control-plane/protocol.js'
import { startHttpServer, type HttpServerHandle, type WsEvent } from '../http/server.js'

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
}

export class Supervisor {
  private state: SupervisorState
  private listener: Listener | undefined
  private readonly server: JsonRpcServer
  private readonly connections = new Set<Connection>()
  private readonly agentByConnection = new WeakMap<Connection, string>()
  private readonly spawned = new Map<string, SpawnedAgent>()
  private readonly spawnedPubs = new Map<string, SpawnedPub>()
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
  private readonly scheduler: Scheduler
  private webHandle: { stop: () => Promise<void>; broadcast: (e: WsEvent) => void } | undefined
  private readonly webConfig: SupervisorOptions['web']

  private constructor(state: SupervisorState, options: SupervisorOptions) {
    this.state = state
    this.log = options.logger ?? createLogger('supervisor')
    this.server = new JsonRpcServer(this.handlers(), this.log.child('rpc'))
    this.scheduler = new Scheduler({
      home: state.home,
      logger: this.log.child('scheduler'),
    })
    this.webConfig = options.web
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
    }
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
    this.scheduler.stop()
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
    const pubStops = Array.from(this.spawnedPubs.values()).map(async (sp) => {
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

    // Pub identity provisioning (Epic 3 PR B follow-up). If the source
    // Identity declares a pub: block and the Agent has not been
    // pre-provisioned (pub.identity is empty), mint a keypair, register
    // against the picked pub if one is running, and patch the canonical
    // identity.md to fill in pub.identity / pub.issuer_url. If pub:
    // block is absent, skip entirely (non-pub Agent).
    if (identity.frontmatter.pub) {
      await this.provisionAgentPubIdentity({
        agentName: name,
        canonicalIdentityPath: canonical,
        loadedIdentity: identity,
        pickPub: opts.pub,
        identityClientFactory: opts.identityClientFactory,
      })
    }

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
      pubProvisioned: !!identity.frontmatter.pub,
    })
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
        const updated = await ensureRegistered(client, cred, pubSecrets.adminSecret)
        if (updated.agent_id) {
          agentId = updated.agent_id
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
    if (this.spawned.get(name)) {
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
    const pubMd = composePubMd({
      name,
      ...(opts.description !== undefined ? { description: opts.description } : {}),
      ...(opts.capacity !== undefined ? { capacity: opts.capacity } : {}),
      ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
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
      spawned_at: null,
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
   * Spawn the pub-server process for an existing pub record.
   * Idempotent: starting an already-running pub returns the current
   * pid without re-spawning.
   */
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
    const existing = this.spawnedPubs.get(name)
    if (existing) {
      return { pid: existing.pid, port: record.port }
    }
    const paths = pubPaths(this.state.home, name)
    const secrets = await readPubSecrets({
      adminSecret: paths.adminSecret,
      signingKey: paths.signingKey,
    })
    const spawned = spawnPub(
      {
        name,
        home: this.state.home,
        port: record.port,
        adminSecret: secrets.adminSecret,
        signingPrivateKey: secrets.signingPrivateKey,
        signingPublicKey: secrets.signingPublicKey,
        ...(opts.issuer !== undefined ? { issuer: opts.issuer } : {}),
        ...(opts.hub_url !== undefined ? { hubUrl: opts.hub_url } : {}),
        ...(opts.executablePath !== undefined ? { executablePath: opts.executablePath } : {}),
      },
      this.log.child('pub-lifecycle'),
    )
    this.spawnedPubs.set(name, spawned)
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
      pid: spawned.pid,
      spawned_at: new Date().toISOString(),
      state: 'running',
    })
    void spawned.exited.then(({ code, signal }) => {
      void this.handlePubExit(name, code, signal)
    })
    return { pid: spawned.pid, port: record.port }
  }

  /**
   * Stop a running pub-server. Idempotent: stopping an already-stopped
   * pub records the state change but is otherwise a no-op.
   */
  async stopPub(name: string, reason = 'user_requested'): Promise<void> {
    const spawned = this.spawnedPubs.get(name)
    if (!spawned) {
      await this.updatePub(name, { state: 'stopped', pid: null })
      return
    }
    // Mark intent BEFORE awaiting the actual stop so the exit handler
    // (which may race with us) sees the flag and routes to 'stopped'
    // rather than 'errored'.
    this.pubStopRequested.add(name)
    await spawned.stop()
    this.spawnedPubs.delete(name)
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
      spawned_at: p.spawned_at,
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
        const updated = await ensureRegistered(client, cred, pubSecrets.adminSecret)
        if (updated.agent_id) {
          agentId = updated.agent_id
          registeredAgainst = targetPub.name
          // Persist the updated credential (now with agent_id) back to disk.
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

  // ---------------------------------------------------------------------------
  // Internal: pub lifecycle helpers (Epic 3 PR A)
  // ---------------------------------------------------------------------------

  private async handlePubExit(
    name: string,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    this.spawnedPubs.delete(name)
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
  throw new Error(
    `multiple pubs exist; please specify --pub <name> (available: ${all.map((p) => p.name).join(', ')})`,
  )
}

/** Default handle: lowercase the display_name and strip whitespace. */
function defaultHandleFor(displayName: string): string {
  const base = displayName.toLowerCase().replace(/\s+/g, '')
  return base.startsWith('@') ? base : `@${base}`
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
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
