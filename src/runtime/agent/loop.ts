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
import type { CompletionResponse, Message } from '../llm/types.js'
import type { IdentityRecord } from '../identity/types.js'
import { composeModelId } from '../identity/types.js'
import {
  ToolDeniedError,
  type DispatchInput,
  type DispatchResult,
  type ToolDispatcher,
} from '../tools/dispatcher.js'
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

  constructor(private readonly opts: AgentLoopOptions) {
    this.log = opts.logger ?? createLogger(`agent/loop/${opts.identity.frontmatter.agent_name}`)
    this.thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS
    this.maxIterations = opts.maxIterations ?? 200
    this.bufferSize = opts.eventBufferSize ?? 500
    this.nowFn = opts.now ?? (() => new Date())
  }

  /** Run a task to completion or to a detector trip. Pure; does not block. */
  async run(task: TaskRecord): Promise<LoopResult> {
    const modelLabel = composeModelId(this.opts.identity.frontmatter.model)
    const systemPrompt = this.buildSystemPrompt()
    this.history.length = 0
    this.history.push({ role: 'user', content: task.body })

    while (this.iteration < this.maxIterations) {
      this.iteration += 1

      let response: CompletionResponse
      try {
        const callStart: LoopEvent = {
          kind: 'model_call_start',
          at: this.nowFn().getTime(),
          model: modelLabel,
          iteration: this.iteration,
        }
        this.pushEvent(callStart)
        response = await this.opts.provider.complete({
          modelId: this.opts.identity.frontmatter.model.model_id,
          systemPrompt,
          messages: this.history,
        })
        const callEnd: LoopEvent = {
          kind: 'model_call_end',
          at: this.nowFn().getTime(),
          model: modelLabel,
          iteration: this.iteration,
          cost_usd: response.costMetrics.estDollars ?? 0,
          finish_reason: response.finishReason,
        }
        this.pushEvent(callEnd)
      } catch (err) {
        return this.errored(err)
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

  private buildSystemPrompt(): string {
    const id = this.opts.identity
    const tools = this.opts.availableToolNames.join(', ')
    return [
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
    ].join('\n')
  }

  private pushEvent(event: LoopEvent): void {
    this.events.push(event)
    while (this.events.length > this.bufferSize) {
      this.events.shift()
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
