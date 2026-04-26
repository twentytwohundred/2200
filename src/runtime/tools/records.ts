/**
 * plan / run / perm record writer.
 *
 * Per [[2026-04-25-tool-baseline]], every tool call leaves three
 * records on disk:
 *
 *   <brain>/.records/plan/<task_id>/<call_id>.md
 *   <brain>/.records/perm/<task_id>/<call_id>.md
 *   <brain>/.records/run/<task_id>/<call_id>.md
 *
 * For ad-hoc calls (no task), `<task_id>` is the literal `_no_task`.
 *
 * Each record is markdown with YAML frontmatter; the schemas are
 * locked in the Epic 2 spec and use integer `schema_version: 1` per
 * [[2026-04-26-schema-version-format]]. Cross-record linking is by
 * `call_id` (every record carries it) and `plan_ref` (run/perm records
 * reference the plan's `id`).
 *
 * Atomic writes via `atomicWriteFile` so a crash mid-write never
 * leaves a torn record.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile } from '../util/atomic-write.js'
import * as YAML from 'yaml'
import type { CheckOutcome } from './perm/types.js'

export type RecordKind = 'plan' | 'run' | 'perm'

const NO_TASK = '_no_task'

export function recordsRoot(brainDir: string): string {
  return join(brainDir, '.records')
}

export function recordPath(
  brainDir: string,
  kind: RecordKind,
  taskId: string | null,
  recordId: string,
): string {
  const taskSegment = taskId ?? NO_TASK
  return join(recordsRoot(brainDir), kind, taskSegment, `${recordId}.md`)
}

// ---------------------------------------------------------------------------
// Plan records
// ---------------------------------------------------------------------------

export interface PlanRecord {
  schema_version: 1
  id: string
  ts: string
  agent: string
  task_id: string | null
  call_id: string
  /** `<provider>/<model_id>` per [[2026-04-26-model-field-format]]. */
  model: string
  tool: string
  args: unknown
  precondition: string | null
  predicted_outcome: string
  reason: string
}

export async function writePlanRecord(brainDir: string, plan: PlanRecord): Promise<string> {
  const path = recordPath(brainDir, 'plan', plan.task_id, plan.id)
  await ensureDir(path)
  const body = `# Plan ${plan.id}

Tool call planned by ${plan.agent} via ${plan.model}.
`
  await atomicWriteFile(path, frontmatter(plan) + body)
  return path
}

// ---------------------------------------------------------------------------
// Perm records
// ---------------------------------------------------------------------------

export interface PermRecord {
  schema_version: 1
  id: string
  ts: string
  agent: string
  task_id: string | null
  plan_ref: string
  call_id: string
  tool: string
  checks: CheckOutcome[]
  authorized: boolean
  denial_reason: { check_type: string; detail: string | null } | null
}

export async function writePermRecord(brainDir: string, perm: PermRecord): Promise<string> {
  const path = recordPath(brainDir, 'perm', perm.task_id, perm.id)
  await ensureDir(path)
  const verdict = perm.authorized ? 'authorized' : 'denied'
  const body = `# Perm ${perm.id}

${verdict.toUpperCase()} for tool '${perm.tool}' (call ${perm.call_id}, plan ${perm.plan_ref}).
`
  await atomicWriteFile(path, frontmatter(perm) + body)
  return path
}

// ---------------------------------------------------------------------------
// Run records
// ---------------------------------------------------------------------------

export interface CostMetrics {
  tokens?: number
  network_bytes?: number
  fs_bytes?: number
  est_dollars?: number
}

export interface RunRecord {
  schema_version: 1
  id: string
  ts_start: string
  ts_end: string
  agent: string
  task_id: string | null
  plan_ref: string
  call_id: string
  tool: string
  inputs: unknown
  output: unknown
  output_ref: string | null
  error: { class: string; message: string; retryable: boolean } | null
  duration_ms: number
  cost_metrics: CostMetrics
}

export async function writeRunRecord(brainDir: string, run: RunRecord): Promise<string> {
  const path = recordPath(brainDir, 'run', run.task_id, run.id)
  await ensureDir(path)
  const status = run.error ? `ERROR (${run.error.class})` : 'OK'
  const body = `# Run ${run.id}

${status} for tool '${run.tool}' (call ${run.call_id}, plan ${run.plan_ref}).
Duration: ${String(run.duration_ms)}ms.
`
  await atomicWriteFile(path, frontmatter(run) + body)
  return path
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function frontmatter(value: unknown): string {
  return `---\n${YAML.stringify(value).trimEnd()}\n---\n\n`
}

async function ensureDir(filePath: string): Promise<void> {
  const dir = filePath.slice(0, filePath.lastIndexOf('/'))
  await mkdir(dir, { recursive: true })
}
