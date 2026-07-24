/**
 * Orphaned-task reconciliation on Agent boot.
 *
 * `AgentProcess.tickTaskPoll()` flips a task to `running` before
 * handing it to the loop, and `TaskStore.pickPending()` only ever
 * returns `pending` tasks. So a task that was in flight when the
 * Agent process died stays `running` forever: never re-dispatched,
 * never errored, never surfaced to the operator. It just stops.
 *
 * That is the failure mode behind "I asked the Agent something and it
 * never came back." It is not rare ... the standing practice of
 * restarting the whole fleet after every build guarantees it fires on
 * any task that happens to be mid-flight. On the box this was
 * diagnosed against, nine tasks across four Agents were sitting in
 * `running`, the oldest three weeks old. One of them was a Discord
 * relay that had already successfully collected its answer from the
 * studio and died holding it.
 *
 * A task cannot be legitimately `running` at boot. Agents are
 * single-task (the `taskInFlight` guard) and hold a `proper-lockfile`
 * lock on their PID file for the process lifetime (see decision
 * 2026-05-21-pid-file-liveness-via-lockfiles), so no second process
 * can be running the same Agent's tasks. Every `running` task this
 * sees is orphaned by definition.
 *
 * Disposition follows the task's own `idempotency` contract rather
 * than inventing new policy:
 *
 *   pure          -> requeue. Re-running from the start is safe by
 *                    definition; pure tasks may only call pure tools.
 *   checkpointed  -> requeue. The loop resumes from the last
 *                    checkpoint, and checkpointed tools are no-ops
 *                    when re-applied to the same state.
 *   destructive   -> error out. Re-running could duplicate an
 *                    irreversible side effect, and the whole point of
 *                    the `destructive` category is that we do not
 *                    make that call automatically. The task lands in
 *                    the inbox as a failure with the reason spelled
 *                    out, so the operator sees it and decides.
 *
 * The load-bearing property is that nothing is silent. A requeued
 * task announces itself in the body so the model knows it is picking
 * up a turn that was cut off mid-flight; an errored task announces
 * itself to the operator.
 */
import type { TaskStore } from './task/store.js'
import type { TaskRecord } from './task/types.js'
import type { Logger } from '../util/logger.js'

/** What the reconciler did with a single orphaned task. */
export interface OrphanDisposition {
  task_id: string
  title: string
  idempotency: TaskRecord['frontmatter']['idempotency']
  action: 'requeued' | 'errored'
}

export interface ReconcileResult {
  /** Every orphan found, with what happened to it. Empty on a clean boot. */
  dispositions: OrphanDisposition[]
}

/** Error class recorded on destructive orphans. Stable string ... the inbox groups on it. */
export const ORPHANED_TASK_ERROR_CLASS = 'OrphanedTask'

/**
 * Note appended to a requeued task's body. The model needs to know it
 * is resuming a turn that was interrupted rather than starting fresh,
 * otherwise it re-narrates the work as if it had never begun.
 */
export function orphanRequeueNote(at: string): string {
  return [
    '---',
    '',
    '## Interrupted: the Agent process stopped mid-task',
    '',
    `This task was in flight when the Agent process stopped (detected at ${at}).`,
    'It has been requeued. Any work recorded above already happened ... files',
    'written are written, messages sent are sent. Verify the current state before',
    'redoing anything, then carry on from where the record leaves off.',
    '',
    'If the record shows you already delivered the answer, say so and finish.',
  ].join('\n')
}

/** Message recorded on a destructive orphan's error block. */
export function orphanErrorMessage(at: string): string {
  return (
    `Agent process stopped while this task was running (detected at ${at}). ` +
    'The task is marked destructive, so it was not automatically requeued ... ' +
    're-running it could repeat an irreversible action. Review what completed ' +
    'and resubmit if the work still needs doing.'
  )
}

/**
 * Find tasks left in `running` by a dead process and dispose of them
 * per their idempotency category. Call once, at Agent boot, before
 * the task-poll timer starts.
 *
 * Best-effort per task: a write failure on one orphan is logged and
 * the sweep continues to the next. Never throws ... a reconciliation
 * failure must not stop an Agent from booting.
 */
export async function reconcileOrphanedTasks(args: {
  taskStore: TaskStore
  logger: Logger
  now?: () => Date
}): Promise<ReconcileResult> {
  const now = args.now ?? ((): Date => new Date())
  const at = now().toISOString()
  const dispositions: OrphanDisposition[] = []

  let all: TaskRecord[]
  try {
    all = await args.taskStore.list()
  } catch (err) {
    args.logger.warn('orphan sweep: task list failed; skipping', {
      error: err instanceof Error ? err.message : String(err),
    })
    return { dispositions }
  }

  const orphans = all.filter((t) => t.frontmatter.state === 'running')
  if (orphans.length === 0) return { dispositions }

  for (const orphan of orphans) {
    const { id, title, idempotency } = orphan.frontmatter
    const requeue = idempotency !== 'destructive'
    try {
      if (requeue) {
        await args.taskStore.updateRecord(id, (rec) => ({
          frontmatter: { ...rec.frontmatter, state: 'pending' },
          body: `${rec.body}\n\n${orphanRequeueNote(at)}`,
        }))
      } else {
        await args.taskStore.update(id, (fm) => ({
          ...fm,
          state: 'errored',
          error: {
            class: ORPHANED_TASK_ERROR_CLASS,
            message: orphanErrorMessage(at),
            at,
          },
        }))
      }
    } catch (err) {
      args.logger.warn('orphan sweep: write failed for task; leaving as-is', {
        task_id: id,
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }
    dispositions.push({
      task_id: id,
      title,
      idempotency,
      action: requeue ? 'requeued' : 'errored',
    })
  }

  if (dispositions.length > 0) {
    args.logger.info('orphan sweep: reclaimed tasks left running by a dead process', {
      requeued: dispositions.filter((d) => d.action === 'requeued').length,
      errored: dispositions.filter((d) => d.action === 'errored').length,
      task_ids: dispositions.map((d) => d.task_id),
    })
  }

  return { dispositions }
}
