/**
 * Tool dispatcher: the plan/run/perm wrapping around every tool call.
 *
 * Called by the Agent loop. Takes a tool name + args + caller context;
 * runs the full wrapping (write plan, resolve paths, run perm checks,
 * write perm, conditionally execute, write run), returns the result or
 * throws on denial / failure.
 *
 * The wrapping is universal: there is no fast path that skips it. Per
 * [[2026-04-25-tool-baseline]], "the wrapping is what makes the system
 * inspectable, debuggable, and trustworthy. Performance can come later
 * if it actually matters."
 *
 * Records land at `<brain>/.records/{plan,run,perm}/<task>/<call>.md`.
 */
import { newCallId, newPermId, newPlanId, newRunId } from '../util/id.js'
import {
  PathResolutionError,
  resolveVirtualPath,
  type ResolvedScope,
} from '../storage/path-resolver.js'
import type { ToolContext, Idempotency } from '../mcp/tool.js'
import type { ToolRegistry } from '../mcp/registry.js'
import type { PermContext } from './perm/types.js'
import { evaluatePerm } from './perm/evaluator.js'
import {
  writePlanRecord,
  writePermRecord,
  writeRunRecord,
  type PlanRecord,
  type PermRecord,
  type RunRecord,
} from './records.js'
import { createLogger, type Logger } from '../util/logger.js'

export class ToolDeniedError extends Error {
  constructor(
    public readonly tool: string,
    public readonly checkType: string,
    public readonly checkDetail: string | null,
  ) {
    super(
      `tool '${tool}' denied at perm check '${checkType}'${checkDetail ? `: ${checkDetail}` : ''}`,
    )
    this.name = 'ToolDeniedError'
  }
}

export class ToolNotFoundError extends Error {
  constructor(public readonly tool: string) {
    super(`no tool registered with name '${tool}'`)
    this.name = 'ToolNotFoundError'
  }
}

export class ToolArgsError extends Error {
  constructor(
    public readonly tool: string,
    public readonly issues: unknown,
  ) {
    super(formatToolArgsError(tool, issues))
    this.name = 'ToolArgsError'
  }
}

/**
 * Render Zod issues (or our own hand-built issue objects) into a string
 * a model can actually act on: one short line per problem, naming the
 * field, what was wrong, and what to do. The prior version stringified
 * the full Zod issue tree; agents would see e.g.
 *   invalid args for tool 'spotify_api': [{"origin":"string","code":"invalid_format",...}]
 * which is structurally complete but not actionable. The new shape:
 *   invalid args for tool 'spotify_api':
 *     - path: required (got missing); provide a non-empty string
 *     - limit: must be 1..50 (got 100)
 */
function formatToolArgsError(tool: string, issues: unknown): string {
  if (!Array.isArray(issues) || issues.length === 0) {
    return `invalid args for tool '${tool}': ${JSON.stringify(issues)}`
  }
  const lines: string[] = [`invalid args for tool '${tool}':`]
  for (const raw of issues) {
    if (typeof raw !== 'object' || raw === null) continue
    const issue = raw as {
      path?: readonly (string | number)[]
      message?: string
      code?: string
      expected?: string
      received?: string
      minimum?: number
      maximum?: number
      type?: string
    }
    const pathStr =
      issue.path && issue.path.length > 0 ? issue.path.map((p) => String(p)).join('.') : '<args>'
    let detail = issue.message ?? 'invalid'
    // Common-case advice strings. The model gets actionable text instead
    // of having to interpret raw Zod codes.
    if (issue.code === 'invalid_type' && issue.expected) {
      const got = issue.received ?? 'missing'
      detail = `must be ${issue.expected} (got ${got})`
    } else if (issue.code === 'too_small' && issue.minimum !== undefined) {
      const what = issue.type === 'string' ? 'min length' : 'min'
      detail = `${what} ${String(issue.minimum)} (${issue.message ?? 'too small'})`
    } else if (issue.code === 'too_big' && issue.maximum !== undefined) {
      const what = issue.type === 'string' ? 'max length' : 'max'
      detail = `${what} ${String(issue.maximum)} (${issue.message ?? 'too large'})`
    } else if (issue.code === 'invalid_format') {
      detail = issue.message ?? 'format invalid'
    }
    lines.push(`  - ${pathStr}: ${detail}`)
  }
  return lines.join('\n')
}

/**
 * Task-scoped tool policy snapshot, looked up by the dispatcher from
 * the calling task's frontmatter. The dispatcher caches one snapshot
 * per task id for the dispatcher instance's lifetime.
 *
 * When `policy === 'strict_allowlist'`, the dispatcher rejects tool
 * calls whose name is not in `allowed` BEFORE the identity-level
 * `allowedToolNames` check. The invariant is enforced mechanically
 * here, not advisorily in the task body. See
 * wiki/inbox/grok/2026-05-23-pr4-propose-work-package-design.md.
 */
export interface TaskPolicySnapshot {
  policy: 'inherit_agent' | 'strict_allowlist'
  /** Exact tool names (e.g., 'brain_read_shared'). Empty when policy is inherit_agent. */
  allowed: ReadonlySet<string>
}

export interface DispatcherOptions {
  registry: ToolRegistry
  /** Tools allowed for this Agent (baseline + Identity additions). */
  allowedToolNames: ReadonlySet<string>
  /** 2200_HOME root for path resolution. */
  home: string
  /** Calling Agent's name. */
  callingAgent: string
  /** Where to write plan/run/perm records (typically the Agent's brain dir). */
  brainDir: string
  /** Calling Agent's project dir. */
  projectDir: string
  /**
   * Read the task-scoped tool policy from disk. Required for the
   * strict-allowlist guard to fire; if omitted, every task is
   * treated as `inherit_agent` (back-compat with callers that
   * haven't been updated yet). The dispatcher caches the result
   * per task id, so this is called at most once per task.
   */
  loadTaskPolicy?: (taskId: string) => Promise<TaskPolicySnapshot | null>
  /** Logger. */
  logger?: Logger
}

export interface DispatchInput {
  /** Tool name, e.g., 'fs_read'. */
  tool: string
  /** Args object passed to the tool. Validated by the tool's argsSchema. */
  args: unknown
  /** Task ID this call belongs to, or null for ad-hoc. */
  taskId: string | null
  /** Task idempotency category, or null when no task. */
  taskIdempotency: Idempotency | null
  /**
   * Source of the originating task. Threaded through to
   * ToolContext.taskSource so surface-aware tools (request_credential)
   * can enforce origin restrictions. Null when unknown / ad-hoc.
   */
  taskSource?: ToolContext['taskSource']
  /** Model that produced this call: `<provider>/<model_id>`. */
  model: string
  /** Free-form: what the Agent expects to happen. */
  predictedOutcome: string
  /** Free-form: why the Agent is making this call. */
  reason: string
  /** Optional precondition the Agent believes is true going in. */
  precondition?: string | null
}

export interface DispatchResult {
  output: unknown
  callId: string
  planId: string
  permId: string
  runId: string
  durationMs: number
}

export class ToolDispatcher {
  private readonly log: Logger
  /**
   * Per-task tool-policy cache. Populated on first dispatch for a
   * given task id; survives for the dispatcher instance's lifetime.
   * Tasks do not mutate `tool_policy` mid-run, so a single snapshot
   * is correct for the task's full execution. Sentinel `null` means
   * "task does not exist or has no policy lookup hook" so we don't
   * keep retrying the disk read for a non-existent task.
   */
  private readonly taskPolicyCache = new Map<string, TaskPolicySnapshot | null>()

  constructor(private readonly options: DispatcherOptions) {
    this.log = options.logger ?? createLogger(`tools/dispatcher/${options.callingAgent}`)
  }

  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    // Tool names are underscored throughout the runtime, but a model
    // that was trained on the prior dotted convention may still emit
    // `fs.read` instead of `fs_read` in its fenced-text output. We
    // accept either: if the requested name doesn't resolve, try
    // replacing the first dot with an underscore. Tolerant parser
    // pattern; cheap defensive fallback.
    const tool =
      this.options.registry.find(input.tool) ??
      this.options.registry.find(input.tool.replace('.', '_'))
    if (!tool) {
      throw new ToolNotFoundError(input.tool)
    }

    // 0) Task-scoped strict allowlist enforcement.
    //
    // Before any other check, if the calling task has a
    // `tool_policy: strict_allowlist` declared, the dispatcher
    // refuses any tool not on the task's `allowed_tools` list.
    // This is the load-bearing invariant for the connector's
    // `propose_work_package` flow (and the standing-brief
    // synthesis task that PR 4 retrofits): internal-coordination
    // tasks can only ever produce text, never invoke execution
    // tools, regardless of what the Agent's identity grants.
    //
    // See wiki/inbox/grok/2026-05-23-pr4-propose-work-package-design.md
    // (locked: dispatcher-level enforcement, exact tool names,
    // per-task caching).
    if (input.taskId !== null) {
      const policy = await this.resolveTaskPolicy(input.taskId)
      if (policy !== null && policy.policy === 'strict_allowlist') {
        if (!policy.allowed.has(tool.name)) {
          throw new ToolDeniedError(
            tool.name,
            'task_allowlist_violation',
            `task ${input.taskId} has tool_policy='strict_allowlist'; tool '${tool.name}' is not on the task's allowed_tools list`,
          )
        }
      }
    }

    // 1) Validate args against the tool's schema. Surfaces malformed
    // calls before we touch perm checks or records (the dispatcher
    // itself is the validator boundary; tools never see invalid args).
    const argsParse = tool.argsSchema.safeParse(input.args)
    if (!argsParse.success) {
      throw new ToolArgsError(input.tool, argsParse.error.issues)
    }
    const validatedArgs = argsParse.data as Record<string, unknown>

    // 2) Resolve path args via the virtual-prefix resolver. Records the
    // resolved scopes for the perm checks. PathResolutionError raised
    // here surfaces back to the caller as a tool-args-style failure.
    const resolvedPaths = new Map<string, ResolvedScope>()
    if (tool.pathArgs) {
      for (const desc of tool.pathArgs) {
        const raw = validatedArgs[desc.argName]
        if (typeof raw !== 'string') {
          throw new ToolArgsError(input.tool, [
            { path: [desc.argName], message: 'path arg must be a string' },
          ])
        }
        try {
          const scope = resolveVirtualPath(raw, {
            home: this.options.home,
            callingAgent: this.options.callingAgent,
          })
          resolvedPaths.set(desc.argName, scope)
        } catch (err) {
          if (err instanceof PathResolutionError) {
            throw new ToolArgsError(input.tool, [{ path: [desc.argName], message: err.message }])
          }
          throw err
        }
      }
    }

    // 3) Allocate per-call IDs and write the plan record up front. The
    // perm record references plan_ref; the run record references it
    // too. Plans always land regardless of the perm decision (the
    // record of "what the Agent intended to do" matters even when
    // denied).
    const callId = newCallId()
    const planId = newPlanId()
    const planRecord: PlanRecord = {
      schema_version: 1,
      id: planId,
      ts: nowIso(),
      agent: this.options.callingAgent,
      task_id: input.taskId,
      call_id: callId,
      model: input.model,
      tool: input.tool,
      args: validatedArgs,
      precondition: input.precondition ?? null,
      predicted_outcome: input.predictedOutcome,
      reason: input.reason,
    }
    await writePlanRecord(this.options.brainDir, planRecord)

    // 4) Run the perm checks. The shell.run command (if applicable) is
    // pulled from validated args for the `command_pattern` check.
    const permCtx: PermContext = {
      callingAgent: this.options.callingAgent,
      tool,
      allowedToolNames: this.options.allowedToolNames,
      taskIdempotency: input.taskIdempotency,
      resolvedPaths,
      shellCommand: input.tool === 'shell_run' ? (validatedArgs['command'] as string | null) : null,
    }
    const permResult = evaluatePerm(permCtx)
    const permId = newPermId()
    const permRecord: PermRecord = {
      schema_version: 1,
      id: permId,
      ts: nowIso(),
      agent: this.options.callingAgent,
      task_id: input.taskId,
      plan_ref: planId,
      call_id: callId,
      tool: input.tool,
      checks: permResult.checks,
      authorized: permResult.authorized,
      denial_reason: permResult.denial
        ? { check_type: permResult.denial.type, detail: permResult.denial.detail }
        : null,
    }
    await writePermRecord(this.options.brainDir, permRecord)

    if (!permResult.authorized) {
      const denial = permResult.denial
      if (!denial) {
        // Type-narrowing impossibility: authorized=false implies denial!=null
        // by construction in evaluatePerm. Throw a structured error so this
        // never silently swallows.
        throw new Error('perm evaluator marked unauthorized but produced no denial')
      }
      this.log.info('tool call denied at perm', {
        tool: input.tool,
        denial: denial.type,
        detail: denial.detail,
      })
      throw new ToolDeniedError(input.tool, denial.type, denial.detail)
    }

    // 5) Run the tool. Replace path args with their resolved absolute
    // paths so tools never deal with virtual paths. Capture timing,
    // outputs, errors. Always write a run record.
    const runArgs = { ...validatedArgs }
    for (const [argName, scope] of resolvedPaths) {
      runArgs[argName] = scope.absolute
    }

    const ctx: ToolContext = {
      callingAgent: this.options.callingAgent,
      home: this.options.home,
      brainDir: this.options.brainDir,
      projectDir: this.options.projectDir,
      taskId: input.taskId,
      callId,
      taskSource: input.taskSource ?? null,
    }

    const tsStart = Date.now()
    const tsStartIso = new Date(tsStart).toISOString()
    let output: unknown = null
    let runError: { class: string; message: string; retryable: boolean } | null = null
    try {
      // Tool args were validated by argsSchema above; the execute fn is
      // typed against z.infer<S>. We pass runArgs (post path-resolution)
      // straight through.
      output = await tool.execute(runArgs, ctx)
    } catch (err) {
      runError = {
        class: err instanceof Error ? err.name : 'UnknownError',
        message: err instanceof Error ? err.message : String(err),
        retryable: false,
      }
    }
    const tsEnd = Date.now()
    const durationMs = tsEnd - tsStart
    const runId = newRunId()
    const runRecord: RunRecord = {
      schema_version: 1,
      id: runId,
      ts_start: tsStartIso,
      ts_end: new Date(tsEnd).toISOString(),
      agent: this.options.callingAgent,
      task_id: input.taskId,
      plan_ref: planId,
      call_id: callId,
      tool: input.tool,
      inputs: runArgs,
      output: runError ? null : output,
      output_ref: null,
      error: runError,
      duration_ms: durationMs,
      cost_metrics: {},
    }
    await writeRunRecord(this.options.brainDir, runRecord)

    if (runError) {
      const e = new Error(runError.message)
      e.name = runError.class
      throw e
    }

    return { output, callId, planId, permId, runId, durationMs }
  }

  /**
   * Cached lookup of the calling task's `tool_policy` + `allowed_tools`.
   * Returns null when no policy hook is provided, or when the task
   * record cannot be found (the dispatcher then treats the call as
   * `inherit_agent` — preserves existing behavior for ad-hoc / legacy
   * tasks). Memoized for the dispatcher's lifetime.
   */
  private async resolveTaskPolicy(taskId: string): Promise<TaskPolicySnapshot | null> {
    if (this.taskPolicyCache.has(taskId)) {
      return this.taskPolicyCache.get(taskId) ?? null
    }
    if (this.options.loadTaskPolicy === undefined) {
      this.taskPolicyCache.set(taskId, null)
      return null
    }
    try {
      const snap = await this.options.loadTaskPolicy(taskId)
      this.taskPolicyCache.set(taskId, snap)
      return snap
    } catch (err) {
      // A disk-read failure on the task should not silently widen the
      // permission surface. Log and treat as "no recognized policy"
      // (i.e., behave as `inherit_agent` for the call, matching the
      // ad-hoc / no-task baseline). Strict-allowlist tasks rely on the
      // task record existing; if it does not, the policy is undefined
      // and the call falls through to the existing identity check.
      this.log.warn('tool-policy lookup failed; treating as inherit_agent', {
        task_id: taskId,
        error: err instanceof Error ? err.message : String(err),
      })
      this.taskPolicyCache.set(taskId, null)
      return null
    }
  }
}

function nowIso(): string {
  return new Date().toISOString()
}
