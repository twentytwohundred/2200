/**
 * Supervisor ↔ Agent control-plane protocol.
 *
 * Locks the JSON-RPC method namespaces, params, and result shapes per the
 * decision at wiki/decisions/2026-04-26-control-plane-protocol.md. Every
 * message is validated by Zod at the transport boundary; mismatches are
 * rejected before reaching handlers.
 *
 * Direction conventions in the comments:
 *   - "S→A": supervisor sends to Agent
 *   - "A→S": Agent sends to supervisor
 *   - "C→S": CLI (or other client) sends to supervisor
 *
 * Notifications (no `id` field on the JSON-RPC envelope) vs. requests
 * (with `id`): we use requests for everything that needs an ack. There are
 * no fire-and-forget notifications at v1; every message gets a response.
 * This keeps the protocol observable and lets tests assert outcomes.
 */
import { z } from 'zod'
import { HandoffFrontmatterSchema } from '../migration/types.js'

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

export const AgentStateSchema = z.enum([
  'running',
  'waiting',
  'blocked_on_user',
  'blocked_on_agent',
  'blocked_on_detector',
  'errored',
  'stopped',
  'archived',
])
export type AgentState = z.infer<typeof AgentStateSchema>

export const NotificationTierSchema = z.enum(['passive', 'normal', 'important', 'critical'])
export type NotificationTier = z.infer<typeof NotificationTierSchema>

export const TaskIdempotencySchema = z.enum(['pure', 'checkpointed', 'destructive'])
export type TaskIdempotency = z.infer<typeof TaskIdempotencySchema>

export const DetectorKindSchema = z.enum([
  'tool_repetition',
  'no_progress',
  'tool_timeout',
  'cost_burst',
  'error_storm',
])
export type DetectorKind = z.infer<typeof DetectorKindSchema>

// ---------------------------------------------------------------------------
// agent.* methods (lifecycle)
// ---------------------------------------------------------------------------

/** A→S: Agent reports it has booted and is ready to receive commands. */
export const AgentRegisterParamsSchema = z.object({
  name: z.string().min(1),
  pid: z.number().int().positive(),
})
export type AgentRegisterParams = z.infer<typeof AgentRegisterParamsSchema>

export const AgentRegisterResultSchema = z.object({
  accepted: z.boolean(),
  reason: z.string().optional(),
})
export type AgentRegisterResult = z.infer<typeof AgentRegisterResultSchema>

/** A→S: Agent reports it is alive (sent on a periodic timer when otherwise idle). */
export const AgentHeartbeatParamsSchema = z.object({
  state: AgentStateSchema,
})
export type AgentHeartbeatParams = z.infer<typeof AgentHeartbeatParamsSchema>

export const AgentHeartbeatResultSchema = z.object({
  ack: z.literal(true),
})
export type AgentHeartbeatResult = z.infer<typeof AgentHeartbeatResultSchema>

/**
 * A→S: live tool-call event from the AgentLoop. Powers the ToolStream
 * UI in the web app: each running tool surfaces as a chip with the
 * `tool` name and a short `arg_summary`, the spinning ring resolves
 * to a check on the `end` event. The supervisor fans these out over
 * WebSocket to subscribed clients so the chat surface stays live
 * without polling.
 */
export const AgentToolEventParamsSchema = z.object({
  kind: z.enum(['start', 'end']),
  task_id: z.string(),
  call_id: z.string(),
  tool: z.string(),
  /** Optional one-line argument label for the chip. */
  arg_summary: z.string().nullable().optional(),
  /** Only on `end`. */
  ok: z.boolean().optional(),
  /** Only on `end`. */
  error_class: z.string().nullable().optional(),
  /** Only on `end`. */
  duration_ms: z.number().optional(),
})
export type AgentToolEventParams = z.infer<typeof AgentToolEventParamsSchema>

export const AgentToolEventResultSchema = z.object({
  ack: z.literal(true),
})
export type AgentToolEventResult = z.infer<typeof AgentToolEventResultSchema>

/** S→A: supervisor asks Agent to stop gracefully. */
export const AgentStopParamsSchema = z.object({
  reason: z.string(),
})
export type AgentStopParams = z.infer<typeof AgentStopParamsSchema>

export const AgentStopResultSchema = z.object({
  status: z.literal('stopping'),
})
export type AgentStopResult = z.infer<typeof AgentStopResultSchema>

/** A→S: Agent reports it has hit an unrecoverable error and is exiting. */
export const AgentErroredParamsSchema = z.object({
  message: z.string(),
  stack: z.string().optional(),
})
export type AgentErroredParams = z.infer<typeof AgentErroredParamsSchema>

export const AgentErroredResultSchema = z.object({
  ack: z.literal(true),
})
export type AgentErroredResult = z.infer<typeof AgentErroredResultSchema>

// ---------------------------------------------------------------------------
// state.* methods (CLI-facing introspection)
// ---------------------------------------------------------------------------

/** C→S: snapshot of the supervisor's current state. */
export const StateSnapshotParamsSchema = z.object({}).strict()
export type StateSnapshotParams = z.infer<typeof StateSnapshotParamsSchema>

export const AgentRecordSchema = z.object({
  name: z.string(),
  identity_path: z.string(),
  state: AgentStateSchema,
  pid: z.number().int().positive().nullable(),
  spawned_at: z.string().nullable(),
  last_heartbeat: z.string().nullable(),
  errored_at: z.string().nullable(),
  errored_reason: z.string().nullable(),
  current_task_id: z.string().nullable(),
})
export type AgentRecord = z.infer<typeof AgentRecordSchema>

/**
 * Pub lifecycle states. Mirrors `AgentStateSchema` but only the
 * states a supervised pub-server can actually be in. v1: running,
 * stopped, errored. No `waiting` (pub-server is always either up or
 * down) and no `blocked_*` (pubs do not have a task pipe of their
 * own; they relay messages).
 */
export const PubStateSchema = z.enum(['running', 'stopped', 'errored'])
export type PubState = z.infer<typeof PubStateSchema>

/**
 * Per-pub record in the supervisor's state. One entry per supervised
 * `openpub-server` process. `pub_md_path` is the absolute path to
 * the per-pub `PUB.md` file (the openpub-server config). `port` is
 * the supervisor-allocated local port the pub listens on.
 *
 * The pub-server child receives `PUB_MD_PATH` and `PORT` env vars on
 * exec; everything else lives in PUB.md or is owned by openpub-server.
 *
 * Per Epic 3's "channel = pub" model from Poe's contract, a pub IS
 * the conversation. There is no "channel" abstraction inside a pub;
 * a multi-pub install runs N supervised pub-server children.
 */
export const PubRecordSchema = z.object({
  name: z.string(),
  pub_md_path: z.string(),
  port: z.number().int().positive(),
  state: PubStateSchema,
  pid: z.number().int().positive().nullable(),
  spawned_at: z.string().nullable(),
  errored_at: z.string().nullable(),
  errored_reason: z.string().nullable(),
})
export type PubRecord = z.infer<typeof PubRecordSchema>

/**
 * Supervisor state shape. `schema_version` is an integer per
 * [[2026-04-26-schema-version-format]]; bump to `2`, `3`, ... on breaking
 * changes. Backwards-compatible field additions stay at version `1`.
 *
 * `home` is the user-chosen 2200_HOME root per
 * [[2026-04-26-commons-and-storage-root]]; `state_dir` is its `state/`
 * subdirectory where the supervisor's own files (this snapshot, the
 * UDS, the PID file, the log) live. Both are reported so callers can
 * derive other paths (commons/, agents/<name>/, etc.) from `home`
 * without hardcoding the layout.
 *
 * `pubs` is the supervisor's per-pub state, populated as the user
 * runs `2200 pub create`. Empty on a fresh install. Backwards
 * compatible with v1 supervisor.json files that predate Epic 3:
 * the loader defaults `pubs` to `{}` if missing.
 */
export const StateSnapshotResultSchema = z.object({
  schema_version: z.literal(1),
  home: z.string(),
  state_dir: z.string(),
  agents: z.record(z.string(), AgentRecordSchema),
  pubs: z.record(z.string(), PubRecordSchema).default({}),
})
export type StateSnapshotResult = z.infer<typeof StateSnapshotResultSchema>

/**
 * Model identifier format: `<provider>/<model_id>` per
 * [[2026-04-26-model-field-format]]. Lowercase alphanumeric provider, slash,
 * lowercase alphanumeric or dash model_id. Used by plan records and Identity
 * model bindings. Not enforced on the supervisor RPC layer at v1 (no plan
 * records yet); exported here so downstream layers (plan-record writer,
 * Identity loader) share one source of truth.
 */
export const ModelIdSchema = z.string().regex(/^[a-z0-9]+\/[a-z0-9.-]+$/, {
  message: 'model identifier must be <provider>/<model_id>, e.g., "anthropic/claude-opus-4-7"',
})
export type ModelId = z.infer<typeof ModelIdSchema>

// ---------------------------------------------------------------------------
// cli.* methods (CLI -> supervisor; mutate state via the running daemon)
// ---------------------------------------------------------------------------

/** C->S: register a new Agent record. Mirrors `Supervisor.createAgent`. */
export const CliAgentCreateParamsSchema = z.object({
  name: z.string().min(1),
  identity_path: z.string().min(1),
  /**
   * Pick a specific pub to register the Agent against (when the
   * Identity has a `pub:` block). Required only when more than one
   * pub exists; with exactly one, the supervisor uses it. Ignored
   * when the Identity has no `pub:` block.
   */
  pub: z.string().optional(),
})
export type CliAgentCreateParams = z.infer<typeof CliAgentCreateParamsSchema>

export const CliAgentCreateResultSchema = z.object({
  ok: z.literal(true),
})
export type CliAgentCreateResult = z.infer<typeof CliAgentCreateResultSchema>

/** C->S: spawn the Agent process for an existing record. */
export const CliAgentStartParamsSchema = z.object({
  name: z.string().min(1),
})
export type CliAgentStartParams = z.infer<typeof CliAgentStartParamsSchema>

export const CliAgentStartResultSchema = z.object({
  ok: z.literal(true),
  pid: z.number().int().positive(),
})
export type CliAgentStartResult = z.infer<typeof CliAgentStartResultSchema>

/** C->S: stop a running Agent process gracefully. */
export const CliAgentStopParamsSchema = z.object({
  name: z.string().min(1),
  reason: z.string().optional(),
})
export type CliAgentStopParams = z.infer<typeof CliAgentStopParamsSchema>

export const CliAgentStopResultSchema = z.object({
  ok: z.literal(true),
})
export type CliAgentStopResult = z.infer<typeof CliAgentStopResultSchema>

/** C->S: resume an Agent paused on a detector trip. */
export const CliAgentResumeParamsSchema = z.object({
  name: z.string().min(1),
})
export type CliAgentResumeParams = z.infer<typeof CliAgentResumeParamsSchema>

export const CliAgentResumeResultSchema = z.object({
  ok: z.literal(true),
  resumed_task_id: z.string().nullable(),
})
export type CliAgentResumeResult = z.infer<typeof CliAgentResumeResultSchema>

/** C->S: submit a task to an Agent. */
export const CliTaskSubmitParamsSchema = z.object({
  agent: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  idempotency: TaskIdempotencySchema.optional(),
  priority: z.number().int().optional(),
})
export type CliTaskSubmitParams = z.infer<typeof CliTaskSubmitParamsSchema>

export const CliTaskSubmitResultSchema = z.object({
  ok: z.literal(true),
  task_id: z.string(),
})
export type CliTaskSubmitResult = z.infer<typeof CliTaskSubmitResultSchema>

/** C->S: list tasks for an Agent. */
export const CliTaskListParamsSchema = z.object({
  agent: z.string().min(1),
})
export type CliTaskListParams = z.infer<typeof CliTaskListParamsSchema>

export const TaskListEntrySchema = z.object({
  id: z.string(),
  state: z.string(),
  idempotency: TaskIdempotencySchema,
  priority: z.number().int(),
  title: z.string(),
  created: z.string(),
  detector_block_kind: DetectorKindSchema.nullable(),
  detector_block_detail: z.string().nullable(),
})
export type TaskListEntry = z.infer<typeof TaskListEntrySchema>

export const CliTaskListResultSchema = z.object({
  agent: z.string(),
  tasks: z.array(TaskListEntrySchema),
})
export type CliTaskListResult = z.infer<typeof CliTaskListResultSchema>

// ---------------------------------------------------------------------------
// cli.pub.* methods (CLI -> supervisor; supervised pub-server lifecycle)
// ---------------------------------------------------------------------------
//
// Per Epic 3 spec v0.3 [[03-local-pub-integration]]: each pub is its own
// `openpub-server` process, supervised alongside Agent processes. The
// supervisor allocates a free local port on `cli.pub.create`, writes
// PUB.md, and execs the configured pub-server binary with PUB_MD_PATH
// + PORT env vars.

/** C->S: create a new pub. Allocates a port, writes PUB.md, registers the supervised child. */
export const CliPubCreateParamsSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  capacity: z.number().int().positive().optional(),
  /** Override the port the supervisor would otherwise allocate. Useful for tests. */
  port: z.number().int().positive().optional(),
  /** Override the issuer mode written into PUB.md. Defaults to `local` per Doug's Flag B call. */
  issuer: z.enum(['local', 'hub']).optional(),
  /** Required when `issuer === 'hub'`; ignored otherwise. */
  hub_url: z.url().optional(),
})
export type CliPubCreateParams = z.infer<typeof CliPubCreateParamsSchema>

export const CliPubCreateResultSchema = z.object({
  ok: z.literal(true),
  name: z.string(),
  port: z.number().int().positive(),
  pub_md_path: z.string(),
})
export type CliPubCreateResult = z.infer<typeof CliPubCreateResultSchema>

/** C->S: start a registered pub. Idempotent: starting an already-running pub returns its current pid. */
export const CliPubStartParamsSchema = z.object({
  name: z.string().min(1),
})
export type CliPubStartParams = z.infer<typeof CliPubStartParamsSchema>

export const CliPubStartResultSchema = z.object({
  ok: z.literal(true),
  pid: z.number().int().positive(),
  port: z.number().int().positive(),
})
export type CliPubStartResult = z.infer<typeof CliPubStartResultSchema>

/** C->S: stop a running pub. Idempotent: stopping an already-stopped pub returns ok. */
export const CliPubStopParamsSchema = z.object({
  name: z.string().min(1),
  reason: z.string().optional(),
})
export type CliPubStopParams = z.infer<typeof CliPubStopParamsSchema>

export const CliPubStopResultSchema = z.object({
  ok: z.literal(true),
})
export type CliPubStopResult = z.infer<typeof CliPubStopResultSchema>

/** C->S: list pubs known to the supervisor. */
export const CliPubListParamsSchema = z.object({}).strict()
export type CliPubListParams = z.infer<typeof CliPubListParamsSchema>

export const PubListEntrySchema = z.object({
  name: z.string(),
  state: PubStateSchema,
  port: z.number().int().positive(),
  pid: z.number().int().positive().nullable(),
  spawned_at: z.string().nullable(),
  errored_reason: z.string().nullable(),
})
export type PubListEntry = z.infer<typeof PubListEntrySchema>

export const CliPubListResultSchema = z.object({
  pubs: z.array(PubListEntrySchema),
})
export type CliPubListResult = z.infer<typeof CliPubListResultSchema>

/** C->S: detailed status for one pub. */
export const CliPubStatusParamsSchema = z.object({
  name: z.string().min(1),
})
export type CliPubStatusParams = z.infer<typeof CliPubStatusParamsSchema>

export const CliPubStatusResultSchema = PubRecordSchema
export type CliPubStatusResult = z.infer<typeof CliPubStatusResultSchema>

// ---------------------------------------------------------------------------
// cli.user.* methods (CLI -> supervisor; user identity provisioning)
// Epic 3 PR B
// ---------------------------------------------------------------------------

/**
 * C->S: initialize the user's pub identity. Generates an Ed25519
 * keypair, persists the credential file at `<home>/config/user.pub.secret`
 * (mode 0600), writes `<home>/config/user.md` with the user's identity
 * frontmatter, and (if a pub is available and running) registers
 * against it via the v0.3.2 LOCAL_TRUST endpoints.
 *
 * Idempotent on re-run with the same display_name; refuses with a
 * clear error if user.md already exists with a different display_name.
 */
export const CliUserInitParamsSchema = z.object({
  display_name: z.string().min(1),
  /** Defaults to `@<lowercased display_name with spaces removed>`. */
  handle: z.string().optional(),
  /**
   * Pick a specific pub to register against. Required only when more
   * than one pub exists; with exactly one, the supervisor uses it.
   */
  pub: z.string().optional(),
})
export type CliUserInitParams = z.infer<typeof CliUserInitParamsSchema>

export const CliUserInitResultSchema = z.object({
  ok: z.literal(true),
  user_md_path: z.string(),
  credentials_path: z.string(),
  /**
   * Assigned agent_id from the pub-server, or null when no pub was
   * available at init time. Re-run after creating + starting a pub to
   * register.
   */
  agent_id: z.string().nullable(),
  /** Pub the user was registered against (if any). */
  registered_against: z.string().nullable(),
})
export type CliUserInitResult = z.infer<typeof CliUserInitResultSchema>

// ---------------------------------------------------------------------------
// cli.schedule.* methods (CLI -> supervisor; recurring/timed task scheduling)
// Epic 6 PR C
// ---------------------------------------------------------------------------
//
// Schedules live at <home>/state/agents/<agent>/schedules/<id>.json
// (see PR A). The supervisor owns a Scheduler service (PR B) that arms
// timers from those files and enqueues synthetic tasks on fire. The
// CLI mutates files via these RPCs; the supervisor calls
// scheduler.reload() after each mutation so a running daemon picks
// changes up without a restart.

const ScheduleAddCronSchema = z.object({
  kind: z.literal('cron'),
  expression: z.string().min(1),
  timezone: z.string().default('UTC'),
})
const ScheduleAddIntervalSchema = z.object({
  kind: z.literal('interval'),
  interval_seconds: z.number().int().min(5),
})
const ScheduleAddTimingSchema = z.discriminatedUnion('kind', [
  ScheduleAddCronSchema,
  ScheduleAddIntervalSchema,
])

export const CliScheduleAddParamsSchema = z.object({
  agent: z.string().min(1),
  prompt: z.string().min(1),
  description: z.string().optional(),
  timing: ScheduleAddTimingSchema,
})
export type CliScheduleAddParams = z.infer<typeof CliScheduleAddParamsSchema>

export const CliScheduleAddResultSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  next_fire_at: z.string().nullable(),
})
export type CliScheduleAddResult = z.infer<typeof CliScheduleAddResultSchema>

export const CliScheduleListParamsSchema = z.object({
  /** Restrict to one Agent. Omit for all Agents. */
  agent: z.string().optional(),
})
export type CliScheduleListParams = z.infer<typeof CliScheduleListParamsSchema>

export const ScheduleListEntrySchema = z.object({
  id: z.string(),
  agent: z.string(),
  description: z.string(),
  prompt: z.string(),
  timing: ScheduleAddTimingSchema,
  enabled: z.boolean(),
  created_at: z.string(),
  last_fired_at: z.string().nullable(),
  next_fire_at: z.string().nullable(),
})
export type ScheduleListEntry = z.infer<typeof ScheduleListEntrySchema>

export const CliScheduleListResultSchema = z.object({
  entries: z.array(ScheduleListEntrySchema),
})
export type CliScheduleListResult = z.infer<typeof CliScheduleListResultSchema>

export const CliScheduleRemoveParamsSchema = z.object({
  agent: z.string().min(1),
  id: z.string().min(1),
})
export type CliScheduleRemoveParams = z.infer<typeof CliScheduleRemoveParamsSchema>

export const CliScheduleRemoveResultSchema = z.object({
  ok: z.literal(true),
})
export type CliScheduleRemoveResult = z.infer<typeof CliScheduleRemoveResultSchema>

export const CliScheduleSetEnabledParamsSchema = z.object({
  agent: z.string().min(1),
  id: z.string().min(1),
  enabled: z.boolean(),
})
export type CliScheduleSetEnabledParams = z.infer<typeof CliScheduleSetEnabledParamsSchema>

export const CliScheduleSetEnabledResultSchema = z.object({
  ok: z.literal(true),
  next_fire_at: z.string().nullable(),
})
export type CliScheduleSetEnabledResult = z.infer<typeof CliScheduleSetEnabledResultSchema>

export const CliScheduleRunOnceParamsSchema = z.object({
  agent: z.string().min(1),
  id: z.string().min(1),
})
export type CliScheduleRunOnceParams = z.infer<typeof CliScheduleRunOnceParamsSchema>

export const CliScheduleRunOnceResultSchema = z.object({
  ok: z.literal(true),
  task_id: z.string(),
})
export type CliScheduleRunOnceResult = z.infer<typeof CliScheduleRunOnceResultSchema>

/**
 * Generic scheduler reload (Epic 12 Phase B-2). The CLI calls this
 * after `2200 extension install / uninstall / update` mutates
 * per-Extension schedule files on disk so the running supervisor's
 * Scheduler picks them up without a daemon restart. Re-uses the same
 * reload entry point as per-Agent schedule mutations; the Scheduler
 * doesn't distinguish trigger sources internally.
 */
export const CliSchedulerReloadParamsSchema = z.object({})
export type CliSchedulerReloadParams = z.infer<typeof CliSchedulerReloadParamsSchema>

export const CliSchedulerReloadResultSchema = z.object({
  ok: z.literal(true),
  /** Number of timers armed after the reload. */
  armed: z.number().int().nonnegative(),
})
export type CliSchedulerReloadResult = z.infer<typeof CliSchedulerReloadResultSchema>

/**
 * cli.spawn.from-handoff
 *
 * Run the migration orchestrator (the same path used by `agent
 * migrate` and `agent spawn`'s standalone branch) inside the running
 * supervisor. The CLI uses this when the daemon is up so the spawn
 * pipeline goes through the daemon's Supervisor instance instead of
 * opening a second one (which would race on state files).
 *
 * The CLI runs the interview and tool/schedule suggestion steps
 * locally, then ships the resulting HandoffDocument over the wire.
 * The daemon does Identity-write, agent registration, brain notes,
 * and the summary notification.
 */

export const HandoffDocumentInputSchema = z.object({
  frontmatter: HandoffFrontmatterSchema,
  body: z.string(),
  source_path: z.string().nullable(),
})
export type HandoffDocumentInput = z.infer<typeof HandoffDocumentInputSchema>

export const CliSpawnFromHandoffParamsSchema = z.object({
  handoff: HandoffDocumentInputSchema,
  /** Replace any existing Agent of the same name. Destructive. */
  force: z.boolean().optional(),
})
export type CliSpawnFromHandoffParams = z.infer<typeof CliSpawnFromHandoffParamsSchema>

export const CliSpawnFromHandoffResultSchema = z.object({
  agent_name: z.string(),
  identity_path: z.string(),
  continuity_note_slug: z.string(),
  brain_imported_count: z.number().int().nonnegative(),
  notification_id: z.string(),
})
export type CliSpawnFromHandoffResult = z.infer<typeof CliSpawnFromHandoffResultSchema>

// ---------------------------------------------------------------------------
// Method registry (a single source of truth for handlers and validation)
// ---------------------------------------------------------------------------

/**
 * Method definitions, keyed by JSON-RPC method name. Each carries the param
 * and result schemas; the JsonRpcServer uses these to validate incoming
 * params and outgoing results, and the JsonRpcClient uses them for the
 * caller-facing types.
 */
export const METHODS = {
  'agent.register': {
    params: AgentRegisterParamsSchema,
    result: AgentRegisterResultSchema,
  },
  'agent.heartbeat': {
    params: AgentHeartbeatParamsSchema,
    result: AgentHeartbeatResultSchema,
  },
  'agent.toolEvent': {
    params: AgentToolEventParamsSchema,
    result: AgentToolEventResultSchema,
  },
  'agent.stop': {
    params: AgentStopParamsSchema,
    result: AgentStopResultSchema,
  },
  'agent.errored': {
    params: AgentErroredParamsSchema,
    result: AgentErroredResultSchema,
  },
  'state.snapshot': {
    params: StateSnapshotParamsSchema,
    result: StateSnapshotResultSchema,
  },
  'cli.agent.create': {
    params: CliAgentCreateParamsSchema,
    result: CliAgentCreateResultSchema,
  },
  'cli.agent.start': {
    params: CliAgentStartParamsSchema,
    result: CliAgentStartResultSchema,
  },
  'cli.agent.stop': {
    params: CliAgentStopParamsSchema,
    result: CliAgentStopResultSchema,
  },
  'cli.agent.resume': {
    params: CliAgentResumeParamsSchema,
    result: CliAgentResumeResultSchema,
  },
  'cli.task.submit': {
    params: CliTaskSubmitParamsSchema,
    result: CliTaskSubmitResultSchema,
  },
  'cli.task.list': {
    params: CliTaskListParamsSchema,
    result: CliTaskListResultSchema,
  },
  'cli.pub.create': {
    params: CliPubCreateParamsSchema,
    result: CliPubCreateResultSchema,
  },
  'cli.pub.start': {
    params: CliPubStartParamsSchema,
    result: CliPubStartResultSchema,
  },
  'cli.pub.stop': {
    params: CliPubStopParamsSchema,
    result: CliPubStopResultSchema,
  },
  'cli.pub.list': {
    params: CliPubListParamsSchema,
    result: CliPubListResultSchema,
  },
  'cli.pub.status': {
    params: CliPubStatusParamsSchema,
    result: CliPubStatusResultSchema,
  },
  'cli.user.init': {
    params: CliUserInitParamsSchema,
    result: CliUserInitResultSchema,
  },
  'cli.schedule.add': {
    params: CliScheduleAddParamsSchema,
    result: CliScheduleAddResultSchema,
  },
  'cli.schedule.list': {
    params: CliScheduleListParamsSchema,
    result: CliScheduleListResultSchema,
  },
  'cli.schedule.remove': {
    params: CliScheduleRemoveParamsSchema,
    result: CliScheduleRemoveResultSchema,
  },
  'cli.schedule.set-enabled': {
    params: CliScheduleSetEnabledParamsSchema,
    result: CliScheduleSetEnabledResultSchema,
  },
  'cli.schedule.run-once': {
    params: CliScheduleRunOnceParamsSchema,
    result: CliScheduleRunOnceResultSchema,
  },
  'cli.scheduler.reload': {
    params: CliSchedulerReloadParamsSchema,
    result: CliSchedulerReloadResultSchema,
  },
  'cli.spawn.from-handoff': {
    params: CliSpawnFromHandoffParamsSchema,
    result: CliSpawnFromHandoffResultSchema,
  },
} as const

export type MethodName = keyof typeof METHODS

export type ParamsOf<M extends MethodName> = z.infer<(typeof METHODS)[M]['params']>
export type ResultOf<M extends MethodName> = z.infer<(typeof METHODS)[M]['result']>

// ---------------------------------------------------------------------------
// JSON-RPC envelope schemas
// ---------------------------------------------------------------------------

/** Reserved JSON-RPC error codes per https://www.jsonrpc.org/specification#error_object */
export const JsonRpcErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // Implementation-defined errors start at -32000
  HANDLER_ERROR: -32000,
  VALIDATION_FAILED: -32001,
} as const

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string()]),
  method: z.string(),
  params: z.unknown().optional(),
})
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>

export const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string()]),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
})
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>
