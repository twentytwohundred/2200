/**
 * Task data model.
 *
 * A Task is a single unit of work for an Agent. v1 of Epic 2 is single-task:
 * the CLI submits one task; the Agent works on it; if it blocks, the user
 * resumes; when complete, the Agent records the outcome. Multi-task scheduling
 * lands in Epic 6.
 *
 * Persisted shape per [[upgrade-readiness]] discipline 1: integer
 * `schema_version` on every task record. Stored at
 * `<home>/agents/<name>/tasks/<task_id>.md` with markdown body and YAML
 * frontmatter so a human can read and edit the task file directly.
 *
 * Idempotency is per [[02-architecture]] and the locked compatibility matrix
 * in PR #9: pure tasks may only call pure tools; checkpointed tasks may call
 * pure or checkpointed tools; destructive tasks may call any. Mis-categorization
 * fails at the perm layer on the first wrong call.
 */
import { z } from 'zod'
import {
  AgentStateSchema,
  DetectorKindSchema,
  TaskIdempotencySchema,
} from '../../control-plane/protocol.js'

/**
 * Task lifecycle states.
 *
 * `pending`: submitted, not yet picked up by the loop.
 * `running`: the loop is actively stepping this task.
 * `blocked_*`: the loop yielded waiting on something (mirror of AgentState).
 * `done`: terminal success.
 * `errored`: terminal failure.
 *
 * The Agent's overall AgentState (per the state machine) reflects the in-flight
 * task's state plus any extra context (errored Agent vs errored task, etc.).
 */
export const TaskStateSchema = z.enum([
  'pending',
  'running',
  'blocked_on_user',
  'blocked_on_agent',
  'blocked_on_detector',
  'done',
  'errored',
])
export type TaskState = z.infer<typeof TaskStateSchema>

/**
 * Optional checkpoint payload for `checkpointed` tasks. The loop persists the
 * last completed step's pre-call message history here so a restart can resume
 * mid-task. `null` for pure tasks (which always re-run from start) and for
 * destructive tasks (which never auto-resume).
 *
 * Shape is intentionally loose at v1: the loop owns the schema. A future PR
 * that introduces cross-version checkpoint compatibility will tighten this.
 */
export const TaskCheckpointSchema = z
  .object({
    /** Iteration count completed before this checkpoint was taken. */
    iteration: z.number().int().nonnegative(),
    /** ISO 8601 UTC. */
    taken_at: z.string(),
    /** Opaque payload owned by the loop. */
    payload: z.unknown(),
  })
  .nullable()
export type TaskCheckpoint = z.infer<typeof TaskCheckpointSchema>

/**
 * Detector trip context recorded on a task that paused for a detector. Held
 * inline on the task so consumers (CLI, future UI) can see why a task is
 * blocked without cross-referencing the trip-record store.
 */
export const TaskDetectorBlockSchema = z
  .object({
    trip_id: z.string(),
    kind: DetectorKindSchema,
    detail: z.string(),
    /** ISO 8601 UTC of when the trip fired. */
    at: z.string(),
  })
  .nullable()
export type TaskDetectorBlock = z.infer<typeof TaskDetectorBlockSchema>

/** Final outcome on a `done` or `errored` task. Null while still in flight. */
export const TaskOutcomeSchema = z
  .object({
    /** Final assistant message text from the model. */
    summary: z.string(),
    /** ISO 8601 UTC. */
    at: z.string(),
    /** Number of model calls that fired across the task's life. */
    iterations: z.number().int().nonnegative(),
  })
  .nullable()
export type TaskOutcome = z.infer<typeof TaskOutcomeSchema>

/** Error context on an `errored` task. */
export const TaskErrorSchema = z
  .object({
    message: z.string(),
    class: z.string(),
    /** ISO 8601 UTC. */
    at: z.string(),
  })
  .nullable()
export type TaskError = z.infer<typeof TaskErrorSchema>

/**
 * Task frontmatter, locked v1 schema.
 */
export const TaskFrontmatterSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().regex(/^task_[a-f0-9]{32}$/, {
    message: 'task id must be `task_<32 hex>`',
  }),
  agent: z.string().min(1),
  /** ISO 8601 UTC of submission. */
  created: z.string(),
  state: TaskStateSchema,
  idempotency: TaskIdempotencySchema,
  /** Higher number wins; default 0. */
  priority: z.number().int(),
  /** Free-form one-line summary; the body has the full task text. */
  title: z.string().min(1),
  /** Latest checkpoint, if any. */
  checkpoint: TaskCheckpointSchema,
  /** Currently-blocking detector context, if any. Mirrors `state == blocked_on_detector`. */
  detector_block: TaskDetectorBlockSchema,
  /** Outcome on terminal states. */
  outcome: TaskOutcomeSchema,
  /** Error on `errored`. */
  error: TaskErrorSchema,
  /**
   * Mirror of the live agent state at the moment the task transitioned to a
   * terminal state. Useful for post-mortem grep ("which tasks errored while
   * agent was blocked_on_detector?").
   */
  agent_state_at_terminal: AgentStateSchema.nullable(),
})
export type TaskFrontmatter = z.infer<typeof TaskFrontmatterSchema>

/**
 * In-memory task record: frontmatter plus the task body (the prompt the model
 * sees as user input).
 */
export interface TaskRecord {
  frontmatter: TaskFrontmatter
  /** The task body — markdown, no frontmatter. This is the prompt to the model. */
  body: string
}

/** Construct a fresh `pending` task ready to be persisted. */
export function newPendingTask(args: {
  id: string
  agent: string
  title: string
  body: string
  idempotency?: TaskFrontmatter['idempotency']
  priority?: number
  now?: () => Date
}): TaskRecord {
  const now = args.now ?? (() => new Date())
  return {
    frontmatter: {
      schema_version: 1,
      id: args.id,
      agent: args.agent,
      created: now().toISOString(),
      state: 'pending',
      idempotency: args.idempotency ?? 'pure',
      priority: args.priority ?? 0,
      title: args.title,
      checkpoint: null,
      detector_block: null,
      outcome: null,
      error: null,
      agent_state_at_terminal: null,
    },
    body: args.body,
  }
}
