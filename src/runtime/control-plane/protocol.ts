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

export const StateSnapshotResultSchema = z.object({
  schema_version: z.literal('0.1'),
  state_dir: z.string(),
  agents: z.record(z.string(), AgentRecordSchema),
})
export type StateSnapshotResult = z.infer<typeof StateSnapshotResultSchema>

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
