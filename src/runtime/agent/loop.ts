/**
 * Agent loop: the model→tool→model cycle that executes a task.
 *
 * The loop is the seam between the LLM provider and the dispatcher. Each
 * iteration:
 *   1. Build messages (system prompt + task body + history).
 *   2. Call provider.complete().
 *   3. Parse the response for tool calls.
 *   4. If no tool calls → final answer; task done.
 *   5. Otherwise dispatch each tool call in order, feed results back into
 *      history, evaluate detectors after each.
 *   6. Repeat until done, detector trip, or hard ceiling.
 *
 * **Tool calling protocol (v1).** The provider abstraction returns plain
 * text. Tool calls are encoded as fenced code blocks tagged `tool` with a
 * JSON object inside:
 *
 *     ```tool
 *     { "tool": "fs.read", "args": { "path": "/commons/reference/notes.md" } }
 *     ```
 *
 * Multiple blocks in one response are dispatched sequentially. A response
 * with no tool blocks is the final answer; the loop terminates.
 *
 * Native tool-calling APIs (Anthropic's `tool_use`, OpenAI's `function_call`)
 * are richer than this convention. A future PR teaches the LLMProvider
 * abstraction those shapes; until then, the JSON-block convention is portable
 * across providers and fully observable in the plan/run records.
 *
 * **Detector substrate.** The loop maintains an in-memory ring buffer of
 * `LoopEvent`s and runs the detector evaluator after each tool result and
 * after each model call (for cost_burst). The first detector to fire pauses
 * the loop and returns a pause result; the AgentProcess is responsible for
 * waiting on a resume signal.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { LLMProvider } from '../llm/provider.js'
import { computeCostUsd, defaultPricingTable, type PricingTable } from '../llm/pricing.js'
import type { CompletionResponse, Message } from '../llm/types.js'
import type { IdentityRecord } from '../identity/types.js'
import type { TelemetryWriter } from '../telemetry/writer.js'
import type { BudgetTracker } from './budget-tracker.js'
import type { PulseEmitter } from './pulse/emitter.js'
import {
  ToolDeniedError,
  type DispatchInput,
  type DispatchResult,
  type ToolDispatcher,
} from '../tools/dispatcher.js'
import type { SkillProvider } from '../skills/provider.js'
import type { TaskRecord } from './task/types.js'
import type { TaskStore } from './task/store.js'
import { ACTIVE_DETECTORS, evaluateDetectors } from './detectors/evaluator.js'
import type {
  AgentStateSnapshot,
  DetectorThresholds,
  LoopEvent,
  TripVerdict,
} from './detectors/types.js'
import { DEFAULT_THRESHOLDS } from './detectors/types.js'
import {
  resetPulseToGreen,
  writeDetectorTrip,
  type TripRecordPersisted,
} from './detectors/trip-record.js'
import { createLogger, type Logger } from '../util/logger.js'

const TOOL_BLOCK_RE = /```tool\s*\n([\s\S]*?)\n```/g

// Fallback for models (notably Claude Code-trained Haiku) that revert to
// Anthropic's native function_calls XML shape despite the system prompt
// asking for fenced ```tool blocks. We capture the inner <invoke>...</invoke>
// then pull out <parameter name="...">...</parameter> children. Models
// sometimes put the actual tool name in a "tool" parameter (with
// <invoke name="tool_code">) and sometimes put it on the invoke itself
// (<invoke name="pub.read">), so both shapes are accepted.
const FUNCTION_CALLS_RE = /<function_calls>([\s\S]*?)<\/function_calls>/g
const INVOKE_RE = /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g
const PARAMETER_RE = /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/g

const ToolCallShape = z.object({
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  predicted_outcome: z.string().default(''),
  reason: z.string().default(''),
  precondition: z.string().nullable().optional(),
})

export interface ParsedToolCall {
  tool: string
  args: Record<string, unknown>
  predicted_outcome: string
  reason: string
  precondition: string | null
}

/**
 * Parse tool calls out of a model response. Tries the canonical fenced
 * ```tool block format first, then falls back to the <function_calls>
 * XML shape some models emit by reflex. Order is preserved within each
 * format; fenced blocks are reported before any XML calls in the same
 * response. Malformed blocks (in either format) are reported as errors so
 * the loop can surface them to the model in the next turn.
 */
export function parseToolCalls(text: string): {
  calls: ParsedToolCall[]
  errors: string[]
} {
  const calls: ParsedToolCall[] = []
  const errors: string[] = []
  let match: RegExpExecArray | null
  TOOL_BLOCK_RE.lastIndex = 0
  while ((match = TOOL_BLOCK_RE.exec(text))) {
    const raw = match[1]?.trim() ?? ''
    if (!raw) continue
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch (err) {
      errors.push(
        `tool block JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      continue
    }
    const parsed = ToolCallShape.safeParse(json)
    if (!parsed.success) {
      errors.push(`tool block schema invalid: ${JSON.stringify(parsed.error.issues)}`)
      continue
    }
    calls.push({
      tool: parsed.data.tool,
      args: parsed.data.args,
      predicted_outcome: parsed.data.predicted_outcome,
      reason: parsed.data.reason,
      precondition: parsed.data.precondition ?? null,
    })
  }

  FUNCTION_CALLS_RE.lastIndex = 0
  while ((match = FUNCTION_CALLS_RE.exec(text))) {
    const inner = match[1] ?? ''
    INVOKE_RE.lastIndex = 0
    let invokeMatch: RegExpExecArray | null
    while ((invokeMatch = INVOKE_RE.exec(inner))) {
      const invokeName = invokeMatch[1] ?? ''
      const invokeBody = invokeMatch[2] ?? ''
      const params: Record<string, string> = {}
      PARAMETER_RE.lastIndex = 0
      let paramMatch: RegExpExecArray | null
      while ((paramMatch = PARAMETER_RE.exec(invokeBody))) {
        const k = paramMatch[1]
        const v = paramMatch[2]
        if (k !== undefined && v !== undefined) params[k] = v.trim()
      }
      // Tool name may be the invoke@name (when the model used the tool
      // directly) or in a "tool" parameter (when it wrapped through
      // tool_code or similar). Prefer the parameter when present.
      const toolName = params['tool'] ?? invokeName
      if (!toolName || toolName === 'tool_code') {
        if (!params['tool']) {
          errors.push('xml tool block missing tool name')
          continue
        }
      }
      const argsRaw = params['args'] ?? '{}'
      let args: unknown
      try {
        args = JSON.parse(argsRaw)
      } catch (err) {
        errors.push(
          `xml tool block args JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
        )
        continue
      }
      const candidate = {
        tool: params['tool'] ?? invokeName,
        args,
        predicted_outcome: params['predicted_outcome'] ?? '',
        reason: params['reason'] ?? '',
        precondition: params['precondition'] ?? null,
      }
      const parsed = ToolCallShape.safeParse(candidate)
      if (!parsed.success) {
        errors.push(`xml tool block schema invalid: ${JSON.stringify(parsed.error.issues)}`)
        continue
      }
      calls.push({
        tool: parsed.data.tool,
        args: parsed.data.args,
        predicted_outcome: parsed.data.predicted_outcome,
        reason: parsed.data.reason,
        precondition: parsed.data.precondition ?? null,
      })
    }
  }

  return { calls, errors }
}

/** Stable args hash for the tool_repetition detector. */
export function hashArgs(tool: string, args: Record<string, unknown>): string {
  const canonical = canonicalize(args)
  return createHash('sha1').update(`${tool}:${canonical}`).digest('hex')
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v)).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`
}

export interface AgentLoopOptions {
  identity: IdentityRecord
  provider: LLMProvider
  dispatcher: ToolDispatcher
  taskStore: TaskStore
  home: string
  brainDir: string
  /** Names of all tools the dispatcher will accept (baseline + Identity additions). */
  availableToolNames: readonly string[]
  /** Per-Agent thresholds. Defaults to spec defaults. */
  thresholds?: DetectorThresholds
  /** Hard ceiling on iterations per task; safety belt above the no_progress detector. */
  maxIterations?: number
  /** Bounded ring buffer for detector substrate. */
  eventBufferSize?: number
  logger?: Logger
  /** Injected for tests. */
  now?: () => Date
  /**
   * Per-Agent telemetry writer (Epic 4.5). Optional: when present the
   * loop appends one JSONL record per model call (success or error)
   * to today's per-Agent file. When absent the loop runs the same
   * model→tool cycle without persisting telemetry... matches Epic 2
   * behavior.
   */
  telemetryWriter?: TelemetryWriter
  /**
   * Pricing table used to populate `cost_usd` on telemetry records and
   * on the in-memory `model_call_end` event. Defaults to the bundled
   * pricing.json. Tests inject a focused table to assert exact dollar
   * values without depending on real pricing data.
   */
  pricingTable?: PricingTable
  /**
   * Per-Agent BudgetTracker (Epic 4.5). Optional. When present:
   *   - The loop checks `isBlocked()` at the top of `run(task)` and
   *     refuses to start the task with an `errored` result whose
   *     error class is `BudgetBlockedError` if the cap has been hit.
   *   - The loop calls `record(costUsd)` after each model call so the
   *     tracker stays current and fires threshold notifications.
   * When absent (Epic 2 behavior), the loop runs without budget
   * enforcement.
   */
  budgetTracker?: BudgetTracker
  /**
   * Per-Agent Pulse emitter (Epic 9 follow-on). Optional. When present:
   *   - The loop forwards every LoopEvent to the emitter so it can
   *     compute intensity and write `<agent>/pulse.json` on its own
   *     tick.
   *   - On a detector trip, the loop calls `setTrip(kind, trip_id)`
   *     so the dot pins to redlined synchronously with the trip
   *     record being persisted.
   * When absent, the loop runs without Pulse output ... pulse.json
   * is only written by the trip handler, same as Epic 2.
   */
  pulseEmitter?: PulseEmitter
  /**
   * Skill provider (Epic 11 Phase B-2). Optional. When present:
   *   - The system prompt lists installed skills (name + description)
   *     so the model knows it can `skill.invoke <name>` alongside
   *     regular tool calls.
   *   - `skill.invoke` tool calls are intercepted by the loop before
   *     dispatch. The provider resolves the skill, the loop validates
   *     declared tool dependencies against `availableToolNames`, and
   *     the SKILL.md body is returned to the model as the "tool"
   *     result for that call. Missing skills + missing tool
   *     dependencies surface as explicit error messages so the model
   *     can adapt.
   * When absent, `skill.invoke` falls through to the dispatcher and
   * fails with ToolNotFoundError ... the same surface for "skills are
   * not configured for this Agent."
   */
  skillProvider?: SkillProvider
}

export type LoopResult =
  | { kind: 'done'; summary: string; iterations: number }
  | {
      kind: 'tripped'
      verdict: TripVerdict
      trip: TripRecordPersisted
      iterations: number
    }
  | { kind: 'errored'; error: { class: string; message: string }; iterations: number }

export class AgentLoop {
  private readonly log: Logger
  private readonly thresholds: DetectorThresholds
  private readonly maxIterations: number
  private readonly bufferSize: number
  private readonly events: LoopEvent[] = []
  private readonly history: Message[] = []
  private iteration = 0
  private readonly nowFn: () => Date

  private readonly pricingTable: PricingTable

  constructor(private readonly opts: AgentLoopOptions) {
    this.log = opts.logger ?? createLogger(`agent/loop/${opts.identity.frontmatter.agent_name}`)
    this.thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS
    this.maxIterations = opts.maxIterations ?? 200
    this.bufferSize = opts.eventBufferSize ?? 500
    this.nowFn = opts.now ?? (() => new Date())
    this.pricingTable = opts.pricingTable ?? defaultPricingTable()
  }

  /**
   * Synthetic tool name the model emits to invoke a Skill. Intercepted
   * by the loop before the dispatcher; never resolved through the
   * tool registry. The shape mirrors a normal tool call:
   *
   *     ```tool
   *     { "tool": "skill.invoke", "args": { "name": "finance" } }
   *     ```
   */
  static readonly SKILL_INVOKE_TOOL = 'skill.invoke'

  /** Run a task to completion or to a detector trip. Pure; does not block. */
  async run(task: TaskRecord): Promise<LoopResult> {
    // Budget gate: if the agent has crossed today's cap, refuse the
    // task before doing any work. The currently-running task that
    // crossed the cap will have completed (no mid-call interruption);
    // this block fires on the NEXT task. PR E adds the override path
    // that lifts the block.
    if (this.opts.budgetTracker?.isBlocked() === true) {
      const tracker = this.opts.budgetTracker
      const message = `daily cost cap reached: $${tracker.getCumulative().toFixed(2)} of $${tracker.getCap().toFixed(2)} (resets at 00:00 UTC; override with \`2200 agent budget override ${this.opts.identity.frontmatter.agent_name}\`)`
      this.log.warn('refusing task: budget blocked', {
        cumulative: tracker.getCumulative(),
        cap: tracker.getCap(),
        task_id: task.frontmatter.id,
      })
      return {
        kind: 'errored',
        error: { class: 'BudgetBlockedError', message },
        iterations: 0,
      }
    }

    const systemPrompt = await this.buildSystemPrompt()
    this.history.length = 0
    this.history.push({ role: 'user', content: task.body })

    while (this.iteration < this.maxIterations) {
      this.iteration += 1

      // Iteration 1 uses the primary model_id (cheap initial pass).
      // Iterations 2+ use followup_model_id when the Identity declared
      // one... lets operators pair a chat-class initial model with a
      // reasoner-class followup (e.g. deepseek-chat → deepseek-reasoner).
      // Without followup_model_id, all iterations use model_id.
      const modelBinding = this.opts.identity.frontmatter.model
      const activeModelId =
        this.iteration > 1 && modelBinding.followup_model_id
          ? modelBinding.followup_model_id
          : modelBinding.model_id
      const modelLabel = `${modelBinding.provider}/${activeModelId}`

      let response: CompletionResponse
      const startedAt = this.nowFn().getTime()
      const callStart: LoopEvent = {
        kind: 'model_call_start',
        at: startedAt,
        model: modelLabel,
        iteration: this.iteration,
      }
      this.pushEvent(callStart)
      try {
        response = await this.opts.provider.complete({
          modelId: activeModelId,
          systemPrompt,
          messages: this.history,
        })
      } catch (err) {
        const finishedAt = this.nowFn().getTime()
        await this.recordTelemetry(
          task,
          modelBinding.provider,
          activeModelId,
          finishedAt - startedAt,
          'error',
          null,
        )
        return this.errored(err)
      }
      const finishedAt = this.nowFn().getTime()
      const computedCost = computeCostUsd(
        {
          provider: modelBinding.provider,
          modelId: activeModelId,
          inputTokens: response.costMetrics.inputTokens,
          outputTokens: response.costMetrics.outputTokens,
          ...(response.costMetrics.cachedTokens !== undefined
            ? { cachedTokens: response.costMetrics.cachedTokens }
            : {}),
        },
        this.pricingTable,
      )
      const callEnd: LoopEvent = {
        kind: 'model_call_end',
        at: finishedAt,
        model: modelLabel,
        iteration: this.iteration,
        cost_usd: computedCost ?? response.costMetrics.estDollars ?? 0,
        finish_reason: response.finishReason,
      }
      this.pushEvent(callEnd)
      await this.recordTelemetry(
        task,
        modelBinding.provider,
        activeModelId,
        finishedAt - startedAt,
        'ok',
        { cost: computedCost, metrics: response.costMetrics },
      )
      // Budget tracker: record the charge (no-op when computedCost is
      // null... the unknown-pricing case can't contribute to a cap that
      // the user sees in dollar terms). Threshold notifications fire
      // inline from the tracker. The currently-running task continues
      // even if the cap is crossed; the next task gets refused at the
      // top of `run()`.
      if (this.opts.budgetTracker !== undefined) {
        try {
          await this.opts.budgetTracker.record(computedCost)
        } catch (budgetErr) {
          this.log.warn('budget-tracker record failed', {
            error: budgetErr instanceof Error ? budgetErr.message : String(budgetErr),
          })
        }
      }

      const trip = this.evaluate(task)
      if (trip) return await this.tripped(task, trip)

      const parsed = parseToolCalls(response.text)
      // No tool calls means the model is finished; the response text is
      // the final answer.
      if (parsed.calls.length === 0 && parsed.errors.length === 0) {
        this.history.push({ role: 'assistant', content: response.text })
        return {
          kind: 'done',
          summary: response.text,
          iterations: this.iteration,
        }
      }

      // Echo the assistant turn into history so subsequent calls have full
      // conversational context (otherwise the next model call sees only the
      // task plus tool results and loses the model's reasoning).
      this.history.push({ role: 'assistant', content: response.text })

      // If parsing failed on any block, report the errors back to the model
      // so it can correct them on the next turn.
      if (parsed.errors.length > 0) {
        this.history.push({
          role: 'tool',
          content: `tool-block errors: ${parsed.errors.join('; ')}`,
        })
      }

      for (const call of parsed.calls) {
        const dispatchTrip = await this.runOneCall(task, call, modelLabel)
        if (dispatchTrip) return await this.tripped(task, dispatchTrip)
      }
    }

    // Hit the safety ceiling. Treat as a no_progress trip even if the
    // detector hasn't fired (defense in depth).
    const verdict: TripVerdict = {
      kind: 'no_progress',
      detail: `max iterations (${String(this.maxIterations)}) reached`,
      triggers: [],
      threshold_used: { no_progress_iterations: this.maxIterations },
    }
    return await this.tripped(task, verdict)
  }

  private async runOneCall(
    task: TaskRecord,
    call: ParsedToolCall,
    model: string,
  ): Promise<TripVerdict | null> {
    if (call.tool === AgentLoop.SKILL_INVOKE_TOOL && this.opts.skillProvider) {
      return await this.runSkillInvoke(task, call)
    }

    const argsHash = hashArgs(call.tool, call.args)

    const startEvent: LoopEvent = {
      kind: 'tool_call_start',
      at: this.nowFn().getTime(),
      // call_id is allocated by the dispatcher; the start event uses a
      // synthetic placeholder until the dispatcher assigns one. We update
      // events when the end fires.
      call_id: 'pending',
      tool: call.tool,
      args_hash: argsHash,
      iteration: this.iteration,
    }
    this.pushEvent(startEvent)

    const dispatchInput: DispatchInput = {
      tool: call.tool,
      args: call.args,
      taskId: task.frontmatter.id,
      taskIdempotency: task.frontmatter.idempotency,
      model,
      predictedOutcome: call.predicted_outcome,
      reason: call.reason,
      precondition: call.precondition,
    }

    let result: DispatchResult | null = null
    let dispatchError: { class: string; message: string } | null = null
    const tStart = this.nowFn().getTime()
    try {
      result = await this.opts.dispatcher.dispatch(dispatchInput)
    } catch (err) {
      dispatchError = {
        class: err instanceof Error ? err.name : 'UnknownError',
        message: err instanceof Error ? err.message : String(err),
      }
    }
    const tEnd = this.nowFn().getTime()
    const durationMs = result?.durationMs ?? tEnd - tStart
    const callId = result?.callId ?? 'denied'
    startEvent.call_id = callId

    const endEvent: LoopEvent = {
      kind: 'tool_call_end',
      at: tEnd,
      call_id: callId,
      tool: call.tool,
      args_hash: argsHash,
      iteration: this.iteration,
      ok: dispatchError === null,
      duration_ms: durationMs,
      ...(dispatchError ? { error_class: dispatchError.class } : {}),
    }
    this.pushEvent(endEvent)

    // Track brain writes for the no_progress detector.
    if (dispatchError === null && (call.tool === 'brain.write' || call.tool === 'fs.write')) {
      const path = (call.args['path'] as string | undefined) ?? '<unknown>'
      this.pushEvent({
        kind: 'brain_write',
        at: tEnd,
        path,
        iteration: this.iteration,
      })
    }

    // Feed result back into history as a `tool` message.
    const resultPayload = dispatchError
      ? {
          tool: call.tool,
          ok: false,
          error: dispatchError,
          ...(dispatchError.class === 'ToolDeniedError'
            ? { hint: 'this call was denied at perm; check the perm record for which check failed' }
            : {}),
        }
      : { tool: call.tool, ok: true, output: result?.output ?? null }
    this.history.push({
      role: 'tool',
      content: JSON.stringify(resultPayload),
    })
    if (dispatchError) {
      this.log.info('tool call failed', {
        tool: call.tool,
        class: dispatchError.class,
        message: dispatchError.message,
      })
      // Surface a known-class denial vs. a real error in the log; both still
      // proceed (model gets the result and decides what to do).
      if (dispatchError.class === 'ToolDeniedError') {
        // ToolDeniedError surfaces to model via history and is not re-thrown.
        // The model can adapt its plan or surface the denial to the user.
        // Suppress eslint unused-expression by referencing the type guard.
        void ToolDeniedError
      }
    }

    return this.evaluate(task)
  }

  /**
   * Handle a `skill.invoke` tool call: resolve the skill, validate
   * declared tool dependencies against the Agent's available tools,
   * and feed the skill body back into history as the tool result.
   *
   * Bypasses the ToolDispatcher (no plan/run/perm records yet ... a
   * future PR adds Skill-aware records). Still emits the loop's
   * tool_call_{start,end} events so detectors and Pulse stay coherent
   * with what the model just did.
   */
  private async runSkillInvoke(
    task: TaskRecord,
    call: ParsedToolCall,
  ): Promise<TripVerdict | null> {
    const argsHash = hashArgs(call.tool, call.args)
    const startTs = this.nowFn().getTime()
    const callId = `skill-${String(this.iteration)}-${argsHash.slice(0, 8)}`
    this.pushEvent({
      kind: 'tool_call_start',
      at: startTs,
      call_id: callId,
      tool: call.tool,
      args_hash: argsHash,
      iteration: this.iteration,
    })

    const rawName = call.args['name']
    let payload: { ok: boolean; result: string }
    if (typeof rawName !== 'string' || rawName.length === 0) {
      payload = {
        ok: false,
        result:
          'skill.invoke requires args.name: string. Example: { "tool": "skill.invoke", "args": { "name": "finance" } }',
      }
    } else {
      const provider = this.opts.skillProvider
      if (!provider) {
        // Defensive: caller already checked, but a defensive branch
        // keeps the type narrowing clean.
        payload = { ok: false, result: 'skill provider is not configured for this Agent' }
      } else {
        const skill = await provider.resolve(rawName)
        if (!skill) {
          payload = {
            ok: false,
            result: `skill "${rawName}" is not installed; run \`2200 skill install <source>\` to add it`,
          }
        } else {
          const missing = skill.toolDependencies.filter(
            (t) => !this.opts.availableToolNames.includes(t),
          )
          if (missing.length > 0) {
            payload = {
              ok: false,
              result:
                `skill "${rawName}" requires tool(s) the Agent does not have: ${missing.join(', ')}. ` +
                `Connect them via \`2200 oauth login\` (for tool integrations) or update the Identity's tools list, then retry.`,
            }
          } else {
            payload = {
              ok: true,
              result:
                `[invoking skill: ${rawName}]\n\n${skill.body}\n\n` +
                `[end of skill: ${rawName} ... apply the instructions above to the current task]`,
            }
          }
        }
      }
    }

    const endTs = this.nowFn().getTime()
    this.pushEvent({
      kind: 'tool_call_end',
      at: endTs,
      call_id: callId,
      tool: call.tool,
      args_hash: argsHash,
      iteration: this.iteration,
      ok: payload.ok,
      duration_ms: endTs - startTs,
      ...(payload.ok ? {} : { error_class: 'SkillResolutionError' }),
    })
    this.history.push({
      role: 'tool',
      content: JSON.stringify({
        tool: call.tool,
        ok: payload.ok,
        ...(payload.ok ? { output: payload.result } : { error: payload.result }),
      }),
    })

    return this.evaluate(task)
  }

  private async buildSystemPrompt(): Promise<string> {
    const id = this.opts.identity
    const tools = this.opts.availableToolNames.join(', ')
    const lines: string[] = [
      id.body,
      '',
      '---',
      '',
      '## Tool calling protocol (v1)',
      '',
      'You can call tools by emitting a fenced code block tagged `tool` with a JSON object inside:',
      '',
      '```tool',
      '{ "tool": "fs.read", "args": { "path": "/commons/reference/notes.md" }, "predicted_outcome": "the notes file content", "reason": "I need to consult the notes before answering" }',
      '```',
      '',
      'Multiple tool blocks in one response are dispatched sequentially. A response with no tool blocks is treated as your final answer and the task is marked done.',
      '',
      'IMPORTANT: this runtime parses fenced ```tool blocks. Do NOT use `<function_calls>` / `<invoke>` / `<parameter>` XML tags... they are recognized as a fallback but the fenced shape above is the canonical format and what you should emit.',
      '',
      `Available tools: ${tools}`,
      '',
      'Path arguments use virtual prefixes:',
      '  /commons/reference/...   read-only shared reference (humans write)',
      '  /commons/scratch/...     ephemeral shared scratch (you and other Agents read+write)',
      '  /project/...             your private project workspace',
      '  /brain/...               your Brain (notes, indexes); use brain.* tools for normal access',
      '  /shared/...              your outbox to other Agents',
    ]
    if (this.opts.skillProvider) {
      const [skills, conflicts] = await Promise.all([
        this.opts.skillProvider.list(),
        this.opts.skillProvider.conflicts(),
      ])
      if (skills.length > 0) {
        lines.push('', '## Available skills', '')
        lines.push(
          'Skills are reusable instructions you can invoke when their description matches the task at hand. Invoke one with:',
          '',
          '```tool',
          '{ "tool": "skill.invoke", "args": { "name": "<skill-name>" }, "reason": "<why this skill matches>" }',
          '```',
          '',
          'The skill body is returned as the tool result; follow its instructions for the rest of the task.',
          '',
        )
        for (const s of skills) {
          lines.push(`- **${s.name}**: ${s.description}`)
        }
        if (conflicts.length > 0) {
          lines.push(
            '',
            `**Name conflicts** (also installed as Extensions; prefer the Extension if you need its capabilities, otherwise the Skill body): ${conflicts.join(', ')}`,
          )
        }
      }
    }
    return lines.join('\n')
  }

  private pushEvent(event: LoopEvent): void {
    this.events.push(event)
    while (this.events.length > this.bufferSize) {
      this.events.shift()
    }
    this.opts.pulseEmitter?.record(event)
  }

  /**
   * Append one telemetry record per model call when a TelemetryWriter
   * is configured. No-op when not. Catches and logs writer errors so
   * a transient I/O failure on the telemetry path never aborts a
   * running task... telemetry is observability, not a load-bearing
   * dependency.
   */
  private async recordTelemetry(
    task: TaskRecord,
    provider: string,
    modelId: string,
    durationMs: number,
    status: 'ok' | 'error',
    success: { cost: number | null; metrics: CompletionResponse['costMetrics'] } | null,
  ): Promise<void> {
    const writer = this.opts.telemetryWriter
    if (!writer) return
    try {
      await writer.recordModelCall({
        taskId: task.frontmatter.id,
        provider,
        modelId,
        inputTokens: success?.metrics.inputTokens ?? 0,
        outputTokens: success?.metrics.outputTokens ?? 0,
        ...(success?.metrics.cachedTokens !== undefined
          ? { cachedTokens: success.metrics.cachedTokens }
          : {}),
        costUsd: success?.cost ?? null,
        status,
        durationMs,
        ts: new Date(this.nowFn().getTime()).toISOString(),
      })
    } catch (writeErr) {
      this.log.warn('telemetry write failed', {
        error: writeErr instanceof Error ? writeErr.message : String(writeErr),
      })
    }
  }

  private evaluate(task: TaskRecord): TripVerdict | null {
    const snapshot: AgentStateSnapshot = {
      agent_name: this.opts.identity.frontmatter.agent_name,
      current_task_id: task.frontmatter.id,
      task_idempotency: task.frontmatter.idempotency,
      iteration: this.iteration,
      recent_state: 'running',
    }
    return evaluateDetectors({
      events: this.events,
      agent: snapshot,
      thresholds: this.thresholds,
      now: () => this.nowFn().getTime(),
    })
  }

  private async tripped(task: TaskRecord, verdict: TripVerdict): Promise<LoopResult> {
    const trip = await writeDetectorTrip({
      home: this.opts.home,
      agentName: this.opts.identity.frontmatter.agent_name,
      brainDir: this.opts.brainDir,
      verdict,
      agentSnapshot: {
        agent_name: this.opts.identity.frontmatter.agent_name,
        current_task_id: task.frontmatter.id,
        task_idempotency: task.frontmatter.idempotency,
        iteration: this.iteration,
        recent_state: 'running',
      },
      thresholds: this.thresholds,
      now: this.nowFn,
    })
    this.opts.pulseEmitter?.setTrip(verdict.kind, trip.trip_id)
    await this.opts.taskStore.update(task.frontmatter.id, (fm) => ({
      ...fm,
      state: 'blocked_on_detector',
      detector_block: {
        trip_id: trip.trip_id,
        kind: verdict.kind,
        detail: verdict.detail,
        at: this.nowFn().toISOString(),
      },
    }))
    this.log.info('detector tripped', { kind: verdict.kind, detail: verdict.detail })
    return { kind: 'tripped', verdict, trip, iterations: this.iteration }
  }

  private errored(err: unknown): LoopResult {
    const e = {
      class: err instanceof Error ? err.name : 'UnknownError',
      message: err instanceof Error ? err.message : String(err),
    }
    this.log.error('agent loop errored', e)
    return { kind: 'errored', error: e, iterations: this.iteration }
  }

  /** Test-only accessor: the in-memory event buffer. */
  get _events(): readonly LoopEvent[] {
    return this.events
  }

  /** Test-only accessor: the iteration counter. */
  get _iterations(): number {
    return this.iteration
  }

  /** Reset pulse to green; called when the user resumes a paused agent. */
  async clearPulse(): Promise<void> {
    await resetPulseToGreen({
      home: this.opts.home,
      agentName: this.opts.identity.frontmatter.agent_name,
      now: this.nowFn,
    })
  }

  /** Re-export for downstream use. */
  static get DETECTORS() {
    return ACTIVE_DETECTORS
  }
}
