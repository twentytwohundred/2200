/**
 * Per-Agent JSONL telemetry writer (Epic 4.5).
 *
 * Persists one record per model call to
 *
 *   <home>/state/telemetry/<agent_name>/YYYY-MM-DD.jsonl
 *
 * One line per record, append-only. JSONL is the format because:
 *
 *   - Append-only is recoverable from partial writes (a torn line on
 *     crash is invalid JSON and gets dropped on parse; the rest of
 *     the file is intact).
 *   - Trivial to query with `jq`, `grep`, or a small Node parser.
 *   - Per [[2026-04-24-brain-is-files-not-database]] discipline,
 *     telemetry is files first; SQLite indexing comes later if read
 *     latency becomes a problem.
 *
 * The day filename is UTC (the per-Agent `cost_caps.reset_at` may
 * specify a different timezone for the cap reset, but the on-disk
 * file boundary is UTC so the filename is unambiguous regardless of
 * machine timezone).
 *
 * Records carry `schema_version: 1`; subsequent shape changes go
 * through a migrator chain matching the discipline established for
 * Identity and Notification artifacts.
 */
import { mkdir, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentTelemetryDir } from '../storage/layout.js'

export const TELEMETRY_RECORD_SCHEMA_VERSION = 1

export type TelemetryStatus = 'ok' | 'error'

export interface TelemetryRecord {
  /** Lock at 1; bumps go through a migrator chain. */
  schema_version: 1
  /** ISO 8601 UTC timestamp when the model call finished (or errored). */
  ts: string
  /** Optional task lifecycle id; null if the call did not run inside a task. */
  task_id: string | null
  /** Agent name. Will become a SCUT URI when Epic 4 Phase A lands. */
  agent_id: string
  provider: string
  model_id: string
  /** Tokens charged at the standard input rate (cache misses + new content). */
  input_tokens: number
  output_tokens: number
  /** Tokens served from prompt cache, when the provider broke them out. */
  cached_tokens: number | null
  /** Computed via pricing.computeCostUsd; null when the model is not in the table. */
  cost_usd: number | null
  status: TelemetryStatus
  duration_ms: number
}

/**
 * Inputs for a single record. Trimmed to what callers naturally have
 * at the call site... the writer fills in `schema_version` and `ts`.
 */
export interface RecordModelCallInput {
  taskId: string | null
  provider: string
  modelId: string
  inputTokens: number
  outputTokens: number
  cachedTokens?: number
  costUsd: number | null
  status: TelemetryStatus
  durationMs: number
  /** Optional override for `ts`; tests inject a fixed clock. */
  ts?: string
}

/**
 * The TelemetryWriter is bound to a single Agent (its name + home).
 * Instantiated once per Agent process and shared across loops.
 *
 * Thread-safe assumption: the runtime runs one `complete()` call per
 * Agent at a time within a single Node process, so an in-process
 * lock is unnecessary. Concurrent writes from a future multi-call
 * Agent would need either a per-Agent serialization queue or
 * O_APPEND atomic-append guarantees from the OS (POSIX guarantees
 * appendFile under PIPE_BUF, which is plenty for one JSONL line).
 */
export class TelemetryWriter {
  private readonly dir: string
  private dirEnsured = false

  constructor(
    private readonly home: string,
    private readonly agentName: string,
  ) {
    this.dir = agentTelemetryDir(this.home, this.agentName)
  }

  /**
   * Append one record to today's JSONL. Creates the per-Agent
   * directory on first call. The file itself is created lazily
   * (appendFile auto-creates).
   */
  async recordModelCall(input: RecordModelCallInput): Promise<void> {
    if (!this.dirEnsured) {
      await mkdir(this.dir, { recursive: true })
      this.dirEnsured = true
    }
    const ts = input.ts ?? new Date().toISOString()
    const record: TelemetryRecord = {
      schema_version: TELEMETRY_RECORD_SCHEMA_VERSION,
      ts,
      task_id: input.taskId,
      agent_id: this.agentName,
      provider: input.provider,
      model_id: input.modelId,
      input_tokens: input.inputTokens,
      output_tokens: input.outputTokens,
      cached_tokens: input.cachedTokens ?? null,
      cost_usd: input.costUsd,
      status: input.status,
      duration_ms: input.durationMs,
    }
    const path = this.pathForTs(ts)
    const line = `${JSON.stringify(record)}\n`
    await appendFile(path, line, 'utf8')
  }

  /**
   * Resolve the JSONL path for a given ISO timestamp. The day
   * partition is UTC (first ten characters of the ISO string).
   */
  pathForTs(ts: string): string {
    const day = ts.slice(0, 10) // "YYYY-MM-DD"
    return join(this.dir, `${day}.jsonl`)
  }

  /** Directory the writer is appending into. */
  get directory(): string {
    return this.dir
  }
}
