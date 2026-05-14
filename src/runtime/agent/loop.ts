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
 *     { "tool": "fs_read", "args": { "path": "/commons/reference/notes.md" } }
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
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { LLMProvider } from '../llm/provider.js'
import { computeCostUsd, defaultPricingTable, type PricingTable } from '../llm/pricing.js'
import type { CompletionResponse, Message, NativeToolSpec } from '../llm/types.js'
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
import {
  writePlanRecord,
  writePermRecord,
  writeRunRecord,
  type PermRecord,
  type PlanRecord,
  type RunRecord,
} from '../tools/records.js'
import { newCallId, newPermId, newPlanId, newRunId } from '../util/id.js'
import { DEFAULT_RUNTIME_MODE, type RuntimeMode } from '../config/runtime-mode.js'
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
import { auditNarratedCompletion, type AuditFlag } from './audit/narrated-completion.js'
import type { ClaimEvidenceAuditResult } from './audit/types.js'
import type { TaskIdempotency } from '../control-plane/protocol.js'

/**
 * How many times the loop will push the agent back through with a
 * corrective tool message before finalizing. Three feels right for
 * v1: the first kick-back catches a hallucinated narration, a second
 * catches a botched correction, a third is the "agent really cannot
 * complete this work" signal that should land in the operator's
 * inbox. Past three, the loop returns done with the audit flag still
 * set ... the operator picks it up.
 */
const MAX_AUDIT_KICKBACKS = 3
import {
  DEFAULT_INCOMPLETE_TURN_RETRY_BUDGET,
  resolvePlanningOnlyRetry,
} from './incomplete-turn.js'
import { createLogger, type Logger } from '../util/logger.js'

// Match a fenced ```tool block. The leading `\s*` after `tool` admits
// either a newline or any whitespace before the JSON; the trailing
// `\s*` before the closing fence admits the same. Earlier shape
// required `\n` on both sides, which silently rejected blocks where
// the model jammed the JSON closing brace next to the fence
// (`}```` with no newline) ... a real DeepSeek/Grok pattern that
// caused the JSON to ship as final-text instead of dispatching.
const TOOL_BLOCK_RE = /```tool\s*([\s\S]*?)\s*```/g

/**
 * Lenient fallback for models that open a ```tool fence and forget the
 * closing one. We match an opening fence near end-of-text whose content
 * has no subsequent ``` line. This caught a real Doug-vs-Hobby chat
 * regression on 2026-05-07 where DeepSeek emitted the tool block but
 * truncated before the closing fence; the strict regex skipped it and
 * the loop treated the response as a final answer instead of
 * dispatching the call. Treating an unclosed terminal block as a tool
 * call lets the dispatch succeed (or fail loudly with a typed error
 * the model can correct) rather than silently embedding the JSON in
 * the chat reply.
 */
const TOOL_BLOCK_UNCLOSED_RE = /```tool\s*\n([\s\S]*?)$/

// Fallback for models (notably Claude Code-trained Haiku) that revert to
// Anthropic's native function_calls XML shape despite the system prompt
// asking for fenced ```tool blocks. We capture the inner <invoke>...</invoke>
// then pull out <parameter name="...">...</parameter> children. Models
// sometimes put the actual tool name in a "tool" parameter (with
// <invoke name="tool_code">) and sometimes put it on the invoke itself
// (<invoke name="pub_read">), so both shapes are accepted.
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
  let textForXmlPass = text
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

  // Lenient fallback #1: tool-shaped JSON in any position, no fences.
  // Some providers (DeepSeek/Grok in particular) emit
  // `{"tool":"foo","args":{...}}` as plain text without wrapping it
  // in a ```tool fence. Or they wrap it in a code-fence with the
  // wrong language tag (```json). We scan for the first JSON object
  // whose top-level shape matches a tool call and treat it as one.
  // This is a no-op on responses that don't contain tool-shaped JSON
  // (the LLM's normal final answer).
  if (calls.length === 0 && errors.length === 0) {
    const extracted = extractToolShapedJson(text)
    if (extracted) {
      const parsed = ToolCallShape.safeParse(extracted)
      if (parsed.success) {
        calls.push({
          tool: parsed.data.tool,
          args: parsed.data.args,
          predicted_outcome: parsed.data.predicted_outcome,
          reason: parsed.data.reason,
          precondition: parsed.data.precondition ?? null,
        })
      }
    }
  }

  // Lenient fallback #2: if no closed fence-blocks parsed, look for an
  // unclosed one at the end of the response. Some models truncate the
  // closing fence; if the JSON parses cleanly we treat it as a real
  // call and let the dispatcher surface "tool not found" or arg errors
  // back to the model, instead of silently shipping the JSON to the
  // user as a final answer.
  if (calls.length === 0 && errors.length === 0) {
    TOOL_BLOCK_UNCLOSED_RE.lastIndex = 0
    const unclosed = TOOL_BLOCK_UNCLOSED_RE.exec(text)
    if (unclosed) {
      const raw = unclosed[1]?.trim() ?? ''
      // Only attempt if the captured tail doesn't already contain ```
      // (which would mean we'd be re-matching a closed block we somehow
      // missed earlier).
      if (raw && !raw.includes('```')) {
        try {
          const json: unknown = JSON.parse(raw)
          const parsed = ToolCallShape.safeParse(json)
          if (parsed.success) {
            calls.push({
              tool: parsed.data.tool,
              args: parsed.data.args,
              predicted_outcome: parsed.data.predicted_outcome,
              reason: parsed.data.reason,
              precondition: parsed.data.precondition ?? null,
            })
            // Strip the unclosed block from the text we'll pass to the
            // XML parser so it doesn't try to re-match.
            textForXmlPass = text.slice(0, unclosed.index)
          }
        } catch {
          // Not valid JSON; ignore. The strict regex would have raised
          // an error too only if it had a closing fence; here the model
          // emitted something that looks like a fence but isn't usable.
        }
      }
    }
  }

  FUNCTION_CALLS_RE.lastIndex = 0
  // Use the (possibly trimmed) text for the XML pass so an unclosed tool
  // block we already consumed doesn't bleed in.
  while ((match = FUNCTION_CALLS_RE.exec(textForXmlPass))) {
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

/**
 * Scan a response for JSON-shaped text that looks like a tool call,
 * regardless of fencing. Looks for the first JSON object containing
 * a string `tool` field and an object `args` field; returns it if
 * found, undefined otherwise. Used as the final fallback before the
 * loop treats a response as a final-answer text.
 *
 * Handles:
 *   - bare JSON: `{"tool":"x","args":{...}}` with prose around it
 *   - mis-tagged fences: ```json\n{...}\n```
 *   - JSON inside markdown lists, blockquotes, etc.
 *
 * Does NOT match the canonical ```tool fenced shape (those go through
 * the strict parser earlier). The whole point of this helper is to
 * rescue dispatches the strict parser missed.
 */
function extractToolShapedJson(text: string): unknown {
  // Walk through every `{` looking for a balanced object that parses
  // as JSON and has the tool-call shape. Scanning from left ensures
  // we match the earliest qualifying object.
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue
    const candidate = readBalancedJsonObject(text, i)
    if (!candidate) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    if (looksLikeToolCall(parsed)) return parsed
  }
  return undefined
}

/**
 * Read a balanced `{...}` JSON object from `text` starting at index
 * `start` (which must point at `{`). Returns the substring including
 * both braces, or null if not balanced. Tolerates strings (including
 * escapes) but not block comments (JSON doesn't have them).
 */
function readBalancedJsonObject(text: string, start: number): string | null {
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escape) {
        escape = false
        continue
      }
      if (c === '\\') {
        escape = true
        continue
      }
      if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      continue
    }
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function looksLikeToolCall(parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null) return false
  const obj = parsed as Record<string, unknown>
  return typeof obj['tool'] === 'string' && typeof obj['args'] === 'object' && obj['args'] !== null
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
  /**
   * Native tool-use specs forwarded to providers that support
   * structured tool calling (Anthropic's `tool_use`, OpenAI's
   * `function_calling`). Built from the same registry as the
   * dispatcher; one entry per tool the agent is permitted to call.
   * Providers without native tool-use silently ignore this field
   * and the loop's fenced-text parser is the universal fallback.
   *
   * Optional: when omitted (or empty), the loop falls back to the
   * fenced-text protocol for every provider.
   */
  nativeToolSpecs?: readonly NativeToolSpec[]
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
  /**
   * Deployment tier this Agent is running in (Epic 17 substrate).
   * Defaults to `self-hosted`. Resolved by AgentProcess from the
   * `TWENTYTWOHUNDRED_RUNTIME_MODE` env var inherited from the
   * supervisor; tests can override directly.
   *
   * v1 stores the mode without behavior changes; future code reads
   * it for the system-prompt clarification (no provider keys in
   * env), the proxy provider binding, and starter-inference rate
   * limits, all of which gate on the hosted tiers.
   */
  runtimeMode?: RuntimeMode
  /**
   * Fire-and-forget hook the loop calls at the start + end of every
   * tool call. Wires the chat surface's live ToolStream UI ... each
   * call surfaces as a chip the moment it starts, resolves to a
   * check when it ends. Failures here are caller-swallowed so a
   * disconnected bridge never breaks the loop.
   */
  toolEventEmitter?: (event: {
    kind: 'start' | 'end'
    task_id: string
    call_id: string
    tool: string
    arg_summary?: string | null
    ok?: boolean
    error_class?: string | null
    duration_ms?: number
  }) => void
  /**
   * Claim-vs-evidence audit hook. Optional. When present, the loop
   * runs the audit pass at the moment the agent appears to be done
   * (text-only response, no tool calls left to dispatch). If the
   * audit's severity is `important` (any contradicted) or `normal`
   * (any unverified on a destructive task), the loop pushes a
   * corrective tool message into history and continues ... the
   * agent gets the chance to either actually do the work or
   * rewrite its reply to match reality. Bounded by
   * MAX_AUDIT_KICKBACKS; once the budget exhausts, the loop
   * finalizes anyway and the AgentProcess surfaces the persistent
   * audit flag in the inbox.
   *
   * Returning `null` skips the audit (e.g. for `pure` tasks where
   * there's no work to verify).
   */
  claimEvidenceAudit?: (args: {
    finalMessage: string
    destructive: boolean
    events: readonly LoopEvent[]
  }) => Promise<ClaimEvidenceAuditResult | null>
}

export type LoopResult =
  | {
      kind: 'done'
      summary: string
      iterations: number
      /**
       * Post-task audit flags. Currently only narrated_completion (destructive
       * task that ended with no successful tool calls). Empty array on a
       * clean done; never null. The owning AgentProcess decides whether to
       * surface flags as notifications.
       */
      audit_flags: AuditFlag[]
      /**
       * Final claim-vs-evidence audit result for this turn. Populated
       * when `opts.claimEvidenceAudit` returned a non-null result on
       * the LAST iteration before the loop returned (i.e. after any
       * kick-backs had run). Null when the audit was skipped (pure
       * task or no audit hook installed). The AgentProcess writes
       * this to task frontmatter + the brain log + the inline chat
       * card.
       */
      claim_audit: ClaimEvidenceAuditResult | null
      /**
       * Number of times the audit kicked the loop back during this
       * task. Useful for telemetry: a non-zero count means the agent
       * narrated work it had not done and either corrected itself
       * within the budget or got finalized with the flag still set.
       */
      audit_kickbacks: number
    }
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
  /** Number of empty-response nudges issued for the current task. Capped by DEFAULT_INCOMPLETE_TURN_RETRY_BUDGET. */
  private emptyResponseNudges = 0
  /**
   * Number of successful tool dispatches in this task across all
   * iterations. Drives the planning-only retry guard: once the agent
   * has done real work, treat a subsequent text-only turn as a
   * legitimate stopping point rather than a planning-only stall. This
   * is the conservative version of OC's `replayMetadata.hadPotentialSideEffects`
   * gate: simpler than classifying mutating-vs-read tools, and the
   * tradeoff is that some partial-hallucination cases (work-done +
   * extra-narrated) won't trigger retry. Those are out of scope here
   * per the decision record.
   */
  private priorSuccessfulToolCallsThisTask = 0
  /** Number of planning-only retries issued for the current task. Capped by DEFAULT_INCOMPLETE_TURN_RETRY_BUDGET. */
  private planningOnlyRetries = 0
  /**
   * Number of times the claim-vs-evidence audit has kicked the loop
   * back during the current task. Capped by MAX_AUDIT_KICKBACKS so a
   * persistently failing agent doesn't loop forever; once exhausted
   * the loop finalizes anyway and the surviving audit flag goes to
   * the operator's inbox.
   */
  private claimAuditKickbacks = 0
  /**
   * Most recent audit result for this task (across kick-back
   * iterations). Returned alongside the LoopResult so AgentProcess
   * can persist it to task frontmatter + the brain log + the
   * inline chat audit card.
   */
  private lastClaimAudit: ClaimEvidenceAuditResult | null = null
  /**
   * Snapshot of `priorSuccessfulToolCallsThisTask` taken at the
   * moment of the most recent kick-back. Used to detect the
   * text-only escape attempt: after a kick-back, the agent must
   * make at least one new successful tool call before finalizing.
   * Pure text "I didn't do it" replies are not a valid end-state
   * per Doug's bar (2026-05-14): "either done, or told why it
   * couldn't be done and what's needed to complete it." A formal
   * ask must come via tool call (chat_send / notification_create
   * / etc.), not as plain text in the chat reply.
   */
  private successfulToolCallsAtLastKickback = 0
  /**
   * True once a `pub_send` or `pub_react` tool call has been dispatched
   * during the current task. Used by the wake-task enforcement path:
   * when the runtime fires a synthetic task because a peer addressed
   * us in a pub, the loop must produce a `pub.*` call before
   * terminating, otherwise the room sees no response.
   */
  private pubToolCallsThisTask = 0
  /**
   * Paths the agent has successfully written to during the current
   * task via fs_write / fs_edit / brain_write. Used by the path-
   * discipline guardrail: when a subsequent fs_read / fs_edit /
   * fs_delete / brain_read fails with ENOENT, the loop appends this
   * set to the tool-result message in history so the model has
   * perfect recall of where it actually put files instead of
   * hallucinating paths. Closes the failure mode that tripped Jodin
   * into error_storm on session 14 (wrote files, read back from
   * imagined paths).
   */
  private writtenPathsThisTask = new Set<string>()
  /** Number of "you must call pub.* before terminating" nudges. Capped by DEFAULT_INCOMPLETE_TURN_RETRY_BUDGET. */
  private pubWakeNudges = 0
  private readonly nowFn: () => Date

  private readonly pricingTable: PricingTable
  private readonly runtimeMode: RuntimeMode

  constructor(private readonly opts: AgentLoopOptions) {
    this.log = opts.logger ?? createLogger(`agent/loop/${opts.identity.frontmatter.agent_name}`)
    this.thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS
    this.maxIterations = opts.maxIterations ?? 200
    this.bufferSize = opts.eventBufferSize ?? 500
    this.nowFn = opts.now ?? (() => new Date())
    this.pricingTable = opts.pricingTable ?? defaultPricingTable()
    this.runtimeMode = opts.runtimeMode ?? DEFAULT_RUNTIME_MODE
  }

  /**
   * The deployment tier this AgentLoop is bound to. v1 stores it
   * without behavior changes; Epic 17 reads it for the proxy
   * provider binding, system-prompt clarification, and starter-
   * inference rate limits.
   */
  getRuntimeMode(): RuntimeMode {
    return this.runtimeMode
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
    this.emptyResponseNudges = 0
    this.pubToolCallsThisTask = 0
    this.pubWakeNudges = 0
    this.priorSuccessfulToolCallsThisTask = 0
    this.planningOnlyRetries = 0
    this.claimAuditKickbacks = 0
    this.lastClaimAudit = null
    this.successfulToolCallsAtLastKickback = 0
    this.writtenPathsThisTask.clear()
    this.history.push({ role: 'user', content: task.body })
    // If this task is being resumed after a detector trip, inject a forcing
    // tool-role message before the model's first call. The model otherwise
    // sees only the original task body and tends to retry the same broken
    // thing that tripped the detector (observed on 2026-05-11).
    if (task.frontmatter.resumed_from_trip) {
      this.history.push({
        role: 'tool',
        content: composeResumeGuidance(task.frontmatter.resumed_from_trip),
      })
    }

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
          ...(this.opts.nativeToolSpecs && this.opts.nativeToolSpecs.length > 0
            ? { tools: [...this.opts.nativeToolSpecs] }
            : {}),
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

      // Native tool-use comes first. Anthropic's tool_use blocks and
      // OpenAI's tool_calls land here as `response.toolCalls`; we
      // promote them straight into the same shape parseToolCalls
      // produces. Fenced-text parsing only runs when the provider
      // didn't return native calls (DeepSeek / xAI / local Ollama
      // never do; Anthropic / OpenAI / Kimi / Gemini / OpenRouter do
      // when the model decides to call a tool).
      //
      // Tool names are underscored throughout the runtime, matching
      // Anthropic and OpenAI's `^[a-zA-Z0-9_-]+$` validation; no
      // translation needed.
      const nativeCalls: ParsedToolCall[] = (response.toolCalls ?? []).map((c) => ({
        tool: c.name,
        args: c.args,
        predicted_outcome: '',
        reason: '',
        precondition: null,
      }))
      const parsed =
        nativeCalls.length > 0
          ? { calls: nativeCalls, errors: [] as string[] }
          : parseToolCalls(response.text)
      // No tool calls means the model is finished; the response text is
      // the final answer. Empty/whitespace-only text is NOT a clean
      // termination ... it leaves the user with nothing to read and the
      // task with an empty outcome.summary. Nudge the model once for a
      // final answer; if it still returns empty, surface as errored so
      // the failure is visible instead of silent.
      if (parsed.calls.length === 0 && parsed.errors.length === 0) {
        if (response.text.trim().length > 0) {
          // Wake-task enforcement: when the runtime spawned this task
          // because a peer addressed us in a pub, the agent owes the
          // room a `pub_send` or `pub_react`. Final-answer text without
          // either call leaves the room silent (the model thinks it
          // responded; the room never sees anything). Nudge once with
          // a directive prompt that says exactly which tool to call;
          // if the next iteration still doesn't comply, the loop
          // terminates as before so the operator can see the gap.
          if (
            isPubWakeTask(task) &&
            this.pubToolCallsThisTask === 0 &&
            this.pubWakeNudges < DEFAULT_INCOMPLETE_TURN_RETRY_BUDGET
          ) {
            this.pubWakeNudges += 1
            this.history.push({ role: 'assistant', content: response.text })
            this.history.push({
              role: 'tool',
              content: composeWakeNudge(task),
            })
            continue
          }
          // Planning-only retry: the model produced visible text that
          // promises action without performing it (e.g. "I'll check
          // the logs and report back" with zero tool calls). Decision
          // record: wiki/decisions/2026-05-12-incomplete-turn-detector.md
          const planningInstruction = resolvePlanningOnlyRetry({
            assistantText: response.text,
            lastUserMessage: task.body,
            priorToolCallsSucceeded: this.priorSuccessfulToolCallsThisTask > 0,
          })
          if (
            planningInstruction !== null &&
            this.planningOnlyRetries < DEFAULT_INCOMPLETE_TURN_RETRY_BUDGET
          ) {
            this.planningOnlyRetries += 1
            this.log.info('planning-only turn detected; injecting act-now directive', {
              attempt: this.planningOnlyRetries,
              budget: DEFAULT_INCOMPLETE_TURN_RETRY_BUDGET,
              task_id: task.frontmatter.id,
            })
            this.history.push({ role: 'assistant', content: response.text })
            this.history.push({
              role: 'tool',
              content: planningInstruction,
            })
            continue
          }
          this.history.push({ role: 'assistant', content: response.text })

          // Claim-vs-evidence audit: cure-not-symptom. If the agent's
          // final reply contains claims of action that the tool log
          // doesn't back up, push a corrective tool message + continue
          // the loop. The agent gets to either actually do the work or
          // make a structured ask via tool call. Bounded by
          // MAX_AUDIT_KICKBACKS. Skipped for `pure` tasks (Q&A) where
          // there's no work to verify.
          //
          // Doug's bar (2026-05-14 evening): "either done, or told why
          // it couldn't be done and what they need." The "told" path
          // requires a tool call (notification_create / chat_send /
          // etc.). Pure text "I didn't do it" replies are not a valid
          // end-state once we've kicked back; the no-escape check
          // below catches that case and re-kicks until the agent
          // either acts or the budget exhausts.
          if (this.opts.claimEvidenceAudit && task.frontmatter.idempotency !== 'pure') {
            try {
              const audit = await this.opts.claimEvidenceAudit({
                finalMessage: response.text,
                destructive: task.frontmatter.idempotency === 'destructive',
                events: this.events,
              })
              this.lastClaimAudit = audit

              // Path A: audit says something flagged (contradicted or
              // destructive-unverified). Kick back with the "do or ask"
              // correction.
              if (
                audit !== null &&
                shouldKickBackOnAudit(audit, task.frontmatter.idempotency) &&
                this.claimAuditKickbacks < MAX_AUDIT_KICKBACKS
              ) {
                this.claimAuditKickbacks += 1
                this.successfulToolCallsAtLastKickback = this.priorSuccessfulToolCallsThisTask
                const correction = composeAuditCorrection(audit, this.claimAuditKickbacks)
                this.log.info('audit kicked the loop back; agent must act or ask', {
                  attempt: this.claimAuditKickbacks,
                  budget: MAX_AUDIT_KICKBACKS,
                  severity: audit.severity,
                  reason: 'flagged_claims',
                  task_id: task.frontmatter.id,
                })
                this.history.push({ role: 'tool', content: correction })
                continue
              }

              // Path B: text-only escape attempt. Once we've kicked
              // back at least once, finalizing requires either a new
              // successful tool call OR a verified refusal claim.
              // A vague "I didn't do it" with neither doesn't count
              // as completing the task ... that's the symptom-treat
              // Doug called out. The refusal exception (added v3) is
              // load-bearing: it stops the kick-back loop from being
              // weaponized to coerce an agent past its safety
              // training. A request to expose a secret in a public
              // pub should yield a refusal that the audit recognizes,
              // not a coerced compliance.
              const everKickedBack = this.claimAuditKickbacks > 0
              const newToolCalls =
                this.priorSuccessfulToolCallsThisTask - this.successfulToolCallsAtLastKickback
              const hasVerifiedRefusal =
                audit?.records.some(
                  (r) => r.claim.category === 'refusal' && r.outcome.status === 'verified',
                ) ?? false
              if (
                everKickedBack &&
                newToolCalls === 0 &&
                !hasVerifiedRefusal &&
                this.claimAuditKickbacks < MAX_AUDIT_KICKBACKS
              ) {
                this.claimAuditKickbacks += 1
                this.successfulToolCallsAtLastKickback = this.priorSuccessfulToolCallsThisTask
                const correction = composeNoEscapeCorrection(this.claimAuditKickbacks)
                this.log.info(
                  'audit kicked the loop back; agent gave neither tool call nor structured refusal',
                  {
                    attempt: this.claimAuditKickbacks,
                    budget: MAX_AUDIT_KICKBACKS,
                    reason: 'text_only_escape',
                    task_id: task.frontmatter.id,
                  },
                )
                this.history.push({ role: 'tool', content: correction })
                continue
              }
            } catch (err) {
              this.log.warn('claim-evidence audit threw; finalizing without kick-back', {
                task_id: task.frontmatter.id,
                error: err instanceof Error ? err.message : String(err),
              })
              this.lastClaimAudit = null
            }
          }

          const flag = auditNarratedCompletion({
            events: this.events,
            idempotency: task.frontmatter.idempotency,
          })
          return {
            kind: 'done',
            summary: response.text,
            iterations: this.iteration,
            audit_flags: flag ? [flag] : [],
            claim_audit: this.lastClaimAudit,
            audit_kickbacks: this.claimAuditKickbacks,
          }
        }
        if (this.emptyResponseNudges >= DEFAULT_INCOMPLETE_TURN_RETRY_BUDGET) {
          // Already nudged the maximum number of times; this is a real refusal to respond.
          throw new Error(
            'agent terminated with empty response after nudge; no final answer produced',
          )
        }
        this.emptyResponseNudges += 1
        this.history.push({ role: 'assistant', content: response.text })
        this.history.push({
          role: 'tool',
          content:
            'Your previous turn produced no content and no tool calls. Please give the user a final answer summarizing what you did, what you found, or why you cannot proceed.',
        })
        continue
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
      return await this.runSkillInvoke(task, call, model)
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
    // Live ToolStream surface for the web app (Epic 15.x). Fire-and-
    // forget; failures inside the emitter never break the loop.
    try {
      this.opts.toolEventEmitter?.({
        kind: 'start',
        task_id: task.frontmatter.id,
        call_id: 'pending',
        tool: call.tool,
        arg_summary: summarizeToolArgs(call.tool, call.args),
      })
    } catch {
      /* observability is best-effort */
    }

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
    // Track pub.* dispatches so the wake-task enforcement path knows
    // whether the agent actually responded to the pub. Counts only
    // calls that succeeded (the ones the room sees); a permission
    // denial or tool error still leaves the loop owing a response.
    if ((call.tool === 'pub_send' || call.tool === 'pub_react') && dispatchError === null) {
      this.pubToolCallsThisTask += 1
    }
    // Cumulative successful-tool-call count drives the planning-only
    // retry guard: once the agent has done real work in this task,
    // a subsequent text-only "I'll do X next" turn is treated as a
    // legitimate stopping point rather than a planning-only stall.
    if (dispatchError === null) {
      this.priorSuccessfulToolCallsThisTask += 1
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
    try {
      this.opts.toolEventEmitter?.({
        kind: 'end',
        task_id: task.frontmatter.id,
        call_id: callId,
        tool: call.tool,
        ok: dispatchError === null,
        ...(dispatchError ? { error_class: dispatchError.class } : {}),
        duration_ms: durationMs,
      })
    } catch {
      /* observability is best-effort */
    }

    // Track brain writes for the no_progress detector.
    if (dispatchError === null && (call.tool === 'brain_write' || call.tool === 'fs_write')) {
      const path = (call.args['path'] as string | undefined) ?? '<unknown>'
      this.pushEvent({
        kind: 'brain_write',
        at: tEnd,
        path,
        iteration: this.iteration,
      })
    }

    // Track every path the agent successfully wrote during this
    // task. When a later read fails with ENOENT, the loop appends
    // this list to the tool result so the model can reconcile
    // against actual writes instead of hallucinating paths. See
    // [[../decisions/2026-05-09-path-discipline]] for the
    // failure-mode this closes.
    if (
      dispatchError === null &&
      (call.tool === 'fs_write' || call.tool === 'fs_edit' || call.tool === 'brain_write')
    ) {
      const path = call.args['path']
      if (typeof path === 'string') this.writtenPathsThisTask.add(path)
    }

    // Augment ENOENT errors on read-side fs / brain tools with the
    // paths the agent has actually written this task. The dispatch
    // error message becomes a recall surface, not just a failure.
    let dispatchErrorAugmented = dispatchError
    if (
      dispatchError !== null &&
      dispatchError.message.includes('ENOENT') &&
      (call.tool === 'fs_read' ||
        call.tool === 'fs_edit' ||
        call.tool === 'fs_delete' ||
        call.tool === 'brain_read')
    ) {
      const written = Array.from(this.writtenPathsThisTask)
      if (written.length > 0) {
        const list = written.map((p) => `  - ${p}`).join('\n')
        dispatchErrorAugmented = {
          ...dispatchError,
          message:
            `${dispatchError.message}\n\n` +
            `Paths YOU wrote during this task (use these, do not invent paths):\n${list}\n\n` +
            `If the file you wanted is in this list, retry with the exact path. If not, ` +
            `call fs_list on the parent dir to see what's actually there.`,
        }
      }
    }

    // Feed result back into history as a `tool` message.
    const resultPayload = dispatchErrorAugmented
      ? {
          tool: call.tool,
          ok: false,
          error: dispatchErrorAugmented,
          ...(dispatchErrorAugmented.class === 'ToolDeniedError'
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
    model: string,
  ): Promise<TripVerdict | null> {
    const argsHash = hashArgs(call.tool, call.args)
    const startTs = this.nowFn().getTime()
    const startIso = new Date(startTs).toISOString()
    const callId = newCallId()
    const planId = newPlanId()
    const permId = newPermId()
    const runId = newRunId()
    const agentName = this.opts.identity.frontmatter.agent_name
    const taskId = task.frontmatter.id

    this.pushEvent({
      kind: 'tool_call_start',
      at: startTs,
      call_id: callId,
      tool: call.tool,
      args_hash: argsHash,
      iteration: this.iteration,
    })

    // 1) Plan record. Always lands ... a plan is the record of intent
    // even when the Skill ultimately can't run.
    const planRecord: PlanRecord = {
      schema_version: 1,
      id: planId,
      ts: startIso,
      agent: agentName,
      task_id: taskId,
      call_id: callId,
      model,
      tool: call.tool,
      args: call.args,
      precondition: call.precondition ?? null,
      predicted_outcome: call.predicted_outcome,
      reason: call.reason,
    }
    await writePlanRecord(this.opts.brainDir, planRecord)

    // 2) Resolve the skill + check tool dependencies. The "perm" for
    // a Skill is the dependency check: a Skill that names a tool the
    // Agent does not have is denied at this layer (parallel to the
    // dispatcher's allowed_in_set check for tools).
    const rawName = call.args['name']
    let payload: { ok: boolean; result: string; denial: string | null }
    if (typeof rawName !== 'string' || rawName.length === 0) {
      payload = {
        ok: false,
        result:
          'skill.invoke requires args.name: string. Example: { "tool": "skill.invoke", "args": { "name": "finance" } }',
        denial: 'missing-args',
      }
    } else {
      const provider = this.opts.skillProvider
      if (!provider) {
        payload = {
          ok: false,
          result: 'skill provider is not configured for this Agent',
          denial: 'provider-missing',
        }
      } else {
        const skill = await provider.resolve(rawName)
        if (!skill) {
          payload = {
            ok: false,
            result: `skill "${rawName}" is not installed; run \`2200 skill install <source>\` to add it`,
            denial: 'skill-not-installed',
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
              denial: `missing-tool-deps:${missing.join(',')}`,
            }
          } else {
            payload = {
              ok: true,
              result:
                `[invoking skill: ${rawName}]\n\n${skill.body}\n\n` +
                `[end of skill: ${rawName} ... apply the instructions above to the current task]`,
              denial: null,
            }
          }
        }
      }
    }

    // 3) Perm record. Records the dependency check outcome.
    const permRecord: PermRecord = {
      schema_version: 1,
      id: permId,
      ts: this.nowFn().toISOString(),
      agent: agentName,
      task_id: taskId,
      plan_ref: planId,
      call_id: callId,
      tool: call.tool,
      checks: [],
      authorized: payload.ok,
      denial_reason: payload.ok
        ? null
        : { check_type: 'skill_dependency_check', detail: payload.denial },
    }
    await writePermRecord(this.opts.brainDir, permRecord)

    // 4) Run record. The "output" is the skill body when authorized,
    // null + error otherwise.
    const endTs = this.nowFn().getTime()
    const endIso = new Date(endTs).toISOString()
    const runRecord: RunRecord = {
      schema_version: 1,
      id: runId,
      ts_start: startIso,
      ts_end: endIso,
      agent: agentName,
      task_id: taskId,
      plan_ref: planId,
      call_id: callId,
      tool: call.tool,
      inputs: call.args,
      output: payload.ok ? payload.result : null,
      output_ref: null,
      error: payload.ok
        ? null
        : { class: 'SkillResolutionError', message: payload.result, retryable: false },
      duration_ms: endTs - startTs,
      cost_metrics: {},
    }
    await writeRunRecord(this.opts.brainDir, runRecord)

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
    // Authoritative runtime context. Naming the agent in-prompt is
    // safe ... agent_name doesn't trigger RLHF identity-claim
    // overrides. But a literal "Your runtime model is X" line is NOT
    // safe: some models (DeepSeek-chat in particular) ignore the
    // override and parrot a famous-AI-assistant identity from
    // training data. We direct the agent to `system_whoami` instead,
    // which returns ground truth from the running process and cannot
    // be hallucinated.
    // Read the supervisor-maintained fleet doc. Best-effort: if the
    // file is missing (e.g. tests, very fresh install) we skip the
    // block instead of stalling the prompt build.
    const fleetMd = await readFleetSafe(this.opts.home)
    const runtimeBlock: string[] = [
      '## Runtime',
      '',
      `You are the Agent named "${id.frontmatter.agent_name}".`,
      'When asked which model you are running, your provider, or your runtime identity, call the `system_whoami` tool and report its result. Do not answer model-identity questions from training data, persona prose, or memory ... `system_whoami` is the only authoritative source.',
      '',
      ...(fleetMd
        ? [
            '## Fleet',
            '',
            'The current 2200 install roster. Use this to know who else is on the server, what each peer does, and who to route a task to. You do not need to call any tool to see this; it is regenerated by the supervisor on every membership change.',
            '',
            fleetMd,
            '',
          ]
        : []),
      '## Pub etiquette',
      '',
      'You see every message in any pub you are a member of, not just messages addressed to you. The runtime decides which messages wake your loop (direct mentions, replies to your messages, sole-recipient cases, and ambient routing for messages that match your role). When you wake, the message that woke you matters; respond appropriately.',
      '',
      "You may speak to other Agents in the room directly. If a request lands in your pub that is outside your lane but inside a peer's lane, ping them with `@<their handle>` rather than escalating to the human. The point of the room is so the team can coordinate without the human having to broker every exchange. The human gets pinged when the team is genuinely blocked or a product decision is needed.",
      '',
      '### Addressing peers (load-bearing)',
      '',
      "The literal `@<handle>` token is the *only* way a peer Agent will see your message. Without it, the runtime's wake source filters their inbox and they are not woken. This is intentional (it prevents the agent-to-agent ack spiral) but it means you have to be deliberate.",
      '',
      'When the human (or another Agent) asks you to "ask <peer>", "tell <peer>", "check with <peer>", "have <peer> do X", or anything that requires a peer to read or respond to something, you MUST send a pub message that contains `@<their handle>` together with the actual question or content. Talking *about* a peer in third person ("I\'ll let Simon know later", "I\'ll check with Simon", "Simon should do X") does NOT reach them ... only `@simon <text>` does.',
      '',
      "The text after the @-mention is what they read. Make it self-contained: don't say `@simon question` ... say `@simon what's the latency budget for the deploy?`. The peer cannot see the prompt that woke you.",
      '',
      'When you wake on a pub message, produce ONE of the following:',
      '  1. A text reply via `pub_send` ... when you have something substantive to add (an answer, a proposal, a clarifying question, a delegation @-pinging a peer).',
      '  2. A reaction via `pub_react` ... when the message acknowledges, agrees, or otherwise signals something the room should know you saw. Reacting is the right ack; it does not wake other Agents and does not cascade. **If you woke at all, you must produce a reply or a reaction. Silence is not an option once the runtime has decided to wake you.**',
      '',
      'Use a `pub_react` emoji that matches your intent: ✓ for acknowledgement, 👍 for agreement, 👀 for "I see this and will act", ❤️ for appreciation. Avoid sending text replies that just say "ok" / "got it" / "sounds good" / "no further action" ... react instead.',
      '',
      'Examples of when to react instead of replying:',
      '  - A peer answers a question you @-mentioned them to ask: react ✓ to confirm you saw the answer.',
      '  - A peer @-mentions you to confirm they have something working: react ✓ or 👍.',
      '  - The human posts an update for the room and the router decided you should know about it: react 👀 to signal "received, no action needed from me."',
      '',
      "Anti-spiral guard: do NOT send a text-reply to another Agent's message just to acknowledge it ... that's what reactions are for. Reactions cannot cascade because reactions don't wake anyone. Text replies between Agents should carry actual content (an answer, a question, a delegation, a correction). The runtime's wake source already prevents you from being woken by an unaddressed peer message; if you DID wake on a peer message, it means the message was directed at you (you were @-mentioned, it was a reply to your message, or the router routed it to you), so produce a real response (text or reaction) ... never just terminate silently with a 'no reply needed' outcome.",
      '',
      '## Private chat with the user',
      '',
      'You have a persistent 1:1 chat with the user (the human operator) at `<home>/agents/<your-name>/chat.jsonl`, surfaced in their web UI at `/agent/<your-name>/chat`. The user posts there to talk to you privately ... messages to you alone, not the room. When the user spawns a task that originated in chat, the loop already routes your final answer back into that chat. But if you need to push something INTO that chat without the user prompting first ... a follow-up after pub work, a status update, a heads-up about something you noticed ... use the `chat_send` tool. It appends an assistant-role message to your chat log; the user sees it the next time they open or refresh the chat screen. Only the user sees it; other Agents do not.',
      '',
      'When to use `chat_send` vs `pub_send`:',
      '  - `chat_send` is for the user only (private, 1:1 with you).',
      '  - `pub_send` is for everyone in the pub (the room sees it). Use this when the work is team-relevant or another Agent is involved.',
      '',
      'When the user asks you in chat to relay something privately back to them after doing pub work (e.g. "go ask Simon and report back here"), the right shape is: do the pub work in the room, then call `chat_send` with the result so the user gets it in their private chat with you. Do NOT just rely on the loop ending ... the loop only auto-appends to chat for tasks that originated FROM the chat. A task that the user kicked off in chat then waited for a pub round-trip will only land back in chat if you call `chat_send` explicitly.',
      '',
      '## Load-bearing rules',
      '',
      '1. **Verify before asserting.** Before stating state ("file X exists", "credential Y is missing", "service Z is ticking"), confirm it via the right tool (`fs_list`, `shell_run`, `brain_read`, supervisor log grep, etc.). Asserting from inference is the most common way a session goes off the rails. If you cannot verify, say "I have not checked but I expect ..." ... never assert. This applies to peer claims too: if another Agent says "X is missing", do not relay that as fact without checking yourself.',
      '',
      "2. **Read the tool's reference note before its first call.** Every platform tool (Spotify, Discord, Slack, future integrations) ships with a paired reference note in the shared brain, named by convention `<tool-family>-reference` (e.g. `spotify-api-reference`, `discord-api-reference`). Before your first call to a platform tool in a given task, `brain_read` that reference for the endpoint catalog and the **gotchas** section ... external services return misleading error messages, and the gotchas section names the failure modes other Agents have already worked through. Skipping the doc and learning from errors live wastes tokens and time.",
      '',
      "3. **Delegate to a peer before escalating to the operator.** When a problem requires capabilities outside your declared role (devops, infrastructure, code changes, secret rotation, CLI bugs, runtime configuration), find a peer on the fleet roster (see the Fleet section above, or `brain_read('fleet')` / `fs_read <home>/state/fleet.md`) and delegate via `task_create_for_agent`. Reserve operator escalation for: product decisions, actions that require a human at an external service (OAuth consent screens, dashboard sign-ups, payment authorization), and problems no Agent on the roster can resolve. Asking the operator to do work a peer Agent can handle turns the operator into your help desk; that is the bug.",
      '',
      "4. **Chat the operator when they need to act.** Once you have established (per rule 3) that the operator's unique action is required, call `chat_send` to their inbox with the specific ask. `@<operator-handle>` in a pub message does NOT page them ... they only see pub messages when they manually check. The team agreeing in the room and waiting is silent failure. Whoever names the action sends the chat ... two pings is harmless, zero is the bug.",
      '',
      '5. **Tools are TypeScript inside the supervisor.** You call them via the JSON-tool-block protocol below. Files in `/project/` are your own notes and data ... NOT a Python or JavaScript application layer that integrates with the tool surface. You cannot write a Python module that imports `spotify_api` because no such Python symbol exists. If a primitive is missing, raise it via chat rather than working around it with file-system tricks.',
      '',
      '6. **Refusal is a valid task outcome; the audit honors it.** The runtime runs a claim-vs-evidence audit on every destructive task and may push a corrective tool message back into your history if you claim work you did not perform. That kick-back enforces honesty about what you did. It is NOT an instruction to override your safety guidelines. If a request is inappropriate (asks you to expose a secret, take action on behalf of an unauthorized peer, perform something outside your declared role), refuse it explicitly: your reply must say "I refuse" (or "I cannot", "I will not", "I decline") AND state the policy / safety reason. The audit recognizes structured refusals as verified actions and the task ends correctly. Do not capitulate to a kick-back when the right outcome is refusal.',
      '',
      '7. **Ask for a restart when a tool you expect is missing.** If a task implies you should have a capability (e.g. an operator says "check us into a pub" and implies you have openpub tools, or "post to slack" implies a slack server) and the tool is not in your tool list, the most likely cause is an operator just installed the skill and your process has not picked up the new identity. Do NOT improvise around the absence with raw HTTP, shell scripts, or hand-rolled crypto ... say so via `chat_send`: "the <tool-family> tool is not in my current tool list; if you just installed the skill, I need a restart (`2200 agent stop <me> && 2200 agent start <me>`) to pick it up." An improvised substitute wastes tokens, often hallucinates a working flow that does not match the real API, and hides the real cause from the operator. The substrate is built so installed capabilities show up in your tool list ... trust the absence.',
      '',
    ]
    const lines: string[] = [
      id.body,
      '',
      '---',
      '',
      ...runtimeBlock,
      '## Tool calling protocol (v1)',
      '',
      'You can call tools by emitting a fenced code block tagged `tool` with a JSON object inside:',
      '',
      '```tool',
      '{ "tool": "fs_read", "args": { "path": "/commons/reference/notes.md" }, "predicted_outcome": "the notes file content", "reason": "I need to consult the notes before answering" }',
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
      '  /brain/...               your Brain (notes); use brain.* tools, NOT fs.*',
      '  /shared/...              your outbox to other Agents',
      '',
      '## Brain notes are managed only via brain.* tools',
      '',
      'There is exactly ONE brain. It is the set of slug-keyed notes you read with `brain_read`, list with `brain_list`, search with `brain_search`, write with `brain_write` (upsert when `slug` is supplied), and delete with `brain_delete`.',
      '',
      'NEVER use `fs_read`, `fs_write`, `fs_edit`, or `fs_delete` on `/brain/...` paths. There is no separate filesystem layer for the brain ... a successful `fs_edit` to a brain path would corrupt the index, but the dispatcher will refuse such calls before they execute. Use `brain_write` to update an existing note: pass the same `slug`, your new `title`, and the full `body`. brain.write is upsert.',
      '',
      'To revise an existing brain note: call `brain_read` first to load the current body, edit the body in your reasoning, then call `brain_write` with the same `slug`, the same (or revised) `title`, and the full revised `body`. Confirm with another `brain_read`.',
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

  /**
   * Production accessor for the recent event log. The audit pass
   * reads this after the loop returns to verify the agent's final
   * message against the actual tool transcript.
   *
   * Returns a snapshot. The internal buffer is a ring; callers that
   * cache the reference may see further mutations as new events
   * land. The audit pass calls this once per terminal turn so the
   * snapshot reflects exactly the events that produced the task.
   */
  eventLog(): readonly LoopEvent[] {
    return [...this.events]
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

/**
 * Read `<home>/state/fleet.md` if it exists. Returns null silently
 * on any read error so a missing fleet doc never blocks a task ...
 * the loop falls back to the legacy "no fleet block" prompt shape.
 */
/**
 * Is this task a pub-wake synthetic task? We key off the title prefix
 * the wake source uses (`pub.handle: <pub> ← <agent_id> (<rule>)`),
 * so the loop can distinguish a wake-driven task from a normal
 * user-driven one without needing a new schema field. Wake tasks
 * have a contract: the loop must produce a `pub_send` or `pub_react`
 * before terminating.
 */
function isPubWakeTask(task: TaskRecord): boolean {
  return task.frontmatter.title.startsWith('pub.handle:')
}

/**
 * Directive nudge appended to the loop history when a wake task tries
 * to terminate without calling `pub_send` or `pub_react`. Include the
 * trigger message_id so the model can react to the right message.
 */
/**
 * Forcing message injected at the start of a task that was resumed after
 * a detector trip. Goal: stop the model from retrying the exact thing
 * that tripped the detector. The shape is short on purpose; the model
 * needs the rule, not a lecture.
 */
function composeResumeGuidance(trip: { kind: string; detail: string; at: string }): string {
  const prelude = `[Resume after detector trip at ${trip.at}: ${trip.kind}]\n${trip.detail}\n\n`
  switch (trip.kind) {
    case 'tool_repetition':
      return (
        prelude +
        'You called the same tool with the same arguments multiple times. ' +
        'Do not retry that exact call. Either change the arguments, use a different tool, ' +
        'or surface the situation to the operator with notification_ask or chat_send.'
      )
    case 'error_storm':
      return (
        prelude +
        'Five consecutive tool calls failed. Read the most recent error messages above before retrying. ' +
        'The fix is usually in the error text. If you cannot determine what to change, ' +
        'do not try again ... surface the situation to the operator with notification_ask or chat_send.'
      )
    case 'tool_timeout':
      return (
        prelude +
        'A tool call hit its time ceiling. Do not call the same tool again with the same arguments. ' +
        'Consider whether the work needs to be broken into smaller steps.'
      )
    case 'cost_burst':
      return (
        prelude +
        'You burned through the cost-burst budget for this window. Pause and ask the operator ' +
        'whether to continue before doing any more model or expensive tool calls.'
      )
    case 'no_progress':
      return (
        prelude +
        'You ran many iterations without state change. Step back: what are you actually trying to ' +
        'accomplish, what is blocking you, and is there an easier path? If you are stuck, surface ' +
        'it to the operator.'
      )
    default:
      return prelude + 'Read the trip detail above. Do not repeat what you were doing.'
  }
}

/**
 * One-line human-readable label for the ToolStream chip. The chip
 * displays `<tool> <summary>`; this picks the most operator-readable
 * argument (path, name, id, query) and truncates to ~40 chars.
 *
 * Heuristic: walk a handful of well-known key names in priority
 * order, fall back to the first string value, then to the args hash.
 * Never includes secrets ... env, token, auth, key, secret are
 * dropped.
 */
function summarizeToolArgs(_tool: string, args: Record<string, unknown>): string | null {
  const PRIORITY_KEYS = [
    'path',
    'file',
    'filename',
    'name',
    'slug',
    'id',
    'message_id',
    'agent_name',
    'pub',
    'channel',
    'room',
    'url',
    'endpoint',
    'query',
    'q',
    'search',
    'prompt',
    'title',
    'task',
    'note',
    'method',
    'verb',
  ]
  const REDACTED_KEYS = new Set([
    'token',
    'env',
    'key',
    'api_key',
    'access_token',
    'secret',
    'password',
    'authorization',
    'auth',
  ])
  for (const k of PRIORITY_KEYS) {
    const v = args[k]
    if (typeof v === 'string' && v.length > 0) return clamp(v, 40)
    if (typeof v === 'number') return String(v)
  }
  for (const [k, v] of Object.entries(args)) {
    if (REDACTED_KEYS.has(k.toLowerCase())) continue
    if (typeof v === 'string' && v.length > 0) return clamp(v, 40)
    if (typeof v === 'number') return String(v)
  }
  // Fall back: omit the chip arg entirely so the chip is just "<tool>".
  return null
}

function clamp(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}

function composeWakeNudge(task: TaskRecord): string {
  const idMatch = /Message id:\s*(\S+)/.exec(task.body)
  const messageId = idMatch?.[1] ?? '<message_id from the task body>'
  return [
    'You produced a final-answer response without calling `pub_send` or `pub_react`.',
    'This task was generated because a peer addressed you in a pub; your final-answer text is NOT delivered to the pub.',
    'Choose ONE now and emit a single fenced ```tool block:',
    '',
    '  - If you would react to ack the message: emit',
    '',
    '    ```tool',
    `    { "tool": "pub_react", "args": { "message_id": "${messageId}", "emoji": "✓" }, "predicted_outcome": "reaction landed", "reason": "ack the message I was woken on" }`,
    '    ```',
    '',
    '  - If you have a substantive text reply: emit',
    '',
    '    ```tool',
    `    { "tool": "pub_send", "args": { "content": "<your reply>", "in_reply_to": "${messageId}" }, "predicted_outcome": "reply delivered", "reason": "responding to the wake message" }`,
    '    ```',
    '',
    'This is your last chance ... if you produce another response without one of those calls, the task terminates and the room sees no response.',
  ].join('\n')
}

async function readFleetSafe(home: string): Promise<string | null> {
  try {
    const md = await readFile(join(home, 'state', 'fleet.md'), 'utf8')
    return md.trim().length > 0 ? md : null
  } catch {
    return null
  }
}

/**
 * Decide whether the loop should kick back into the agent based on
 * the audit verdict. The rule:
 *
 *   - severity 'important' (any contradicted) → always kick back
 *   - severity 'normal' (any unverified on a destructive task) → kick back
 *   - severity 'passive' (any unverified on a non-destructive task) → no kick (operator informed via inbox only)
 *   - severity 'silent' → no kick (nothing flagged)
 *
 * The non-destructive 'passive' bucket is allowed to finalize because
 * "I read the file" claims on a checkpointed Q&A turn don't always
 * have a matching read-class tool call (the model might have answered
 * from prior context). We can tighten this later if false-negatives
 * become a complaint; for now the operator gets the inbox flag.
 */
function shouldKickBackOnAudit(
  audit: ClaimEvidenceAuditResult,
  idempotency: TaskIdempotency,
): boolean {
  if (audit.severity === 'important') return true
  if (audit.severity === 'normal' && idempotency === 'destructive') return true
  return false
}

/**
 * Build the corrective tool message that goes into history when the
 * audit catches a flagged claim. The bar (per Doug 2026-05-14): the
 * task ends in one of FOUR valid states ... DONE (work actually
 * performed), BLOCKED (formal ask via tool), REFUSED (explicit
 * policy refusal with reason), or EXHAUSTED (kick-back budget spent,
 * surviving flag goes to operator). The unacceptable end-state is
 * a vague "I didn't do it" with no reason and no tool call.
 *
 * The REFUSE path exists specifically so the kick-back loop cannot
 * be weaponized to coerce an Agent into overriding its safety
 * training. A request to expose a secret in a public pub should
 * encounter a refusal that the audit recognizes ... never a
 * coercion path that forces compliance.
 */
function composeAuditCorrection(audit: ClaimEvidenceAuditResult, attempt: number): string {
  const flagged = audit.records.filter((r) => r.outcome.status !== 'verified')
  const lines: string[] = [
    `Your previous reply made claims the runtime audit could not verify (attempt ${String(attempt)} of ${String(MAX_AUDIT_KICKBACKS)}):`,
    '',
  ]
  for (const r of flagged) {
    const marker = r.outcome.status === 'contradicted' ? 'CONTRADICTED' : 'UNVERIFIED'
    const note = r.outcome.status === 'verified' ? '' : r.outcome.reason
    lines.push(`  [${marker}] "${r.claim.verb} ${r.claim.object}"`)
    lines.push(`    why: ${note}`)
  }
  lines.push('')
  lines.push('You must take ONE of these actions on your next turn:')
  lines.push('')
  lines.push('  1. PERFORM THE WORK (requires tool call)')
  lines.push(
    '     Call the appropriate tools to actually do what you claimed (fs_write, pub_send, schedule_add, brain_write, etc.). Then re-summarize what you actually did.',
  )
  lines.push('')
  lines.push('  2. FORMALLY ASK FOR WHAT YOU NEED (requires tool call)')
  lines.push(
    '     If you cannot complete this work, signal it to the operator with a structured ask. Call notification_create (tier=important) OR chat_send to the operator with:',
  )
  lines.push('       - what specifically you tried and why it failed,')
  lines.push(
    '       - what you need from the operator to proceed (a credential? a permission? a clarification of intent? a different tool?).',
  )
  lines.push(
    '     Then your final reply summarizes the ask, not the work. The audit will recognize the send-class call as a verified action.',
  )
  lines.push('')
  lines.push('  3. REFUSE EXPLICITLY (text reply with reason; no tool call required)')
  lines.push(
    '     If the request violates your guidelines or asks you to do something inappropriate (exposing a secret, taking action on behalf of an unauthorized peer, etc.), refuse it. Your reply must clearly say "I refuse" (or "I cannot", "I will not", "I decline") AND state the policy / safety reason.',
  )
  lines.push(
    '     Refusal is a valid task outcome. The audit recognizes it and the task ends. This kick-back is enforcing honesty about what you did, NOT instructing you to override your guidelines.',
  )
  lines.push('')
  lines.push(
    'NOT ACCEPTABLE: rewriting your reply to a vague "I did not do it" without (1) doing the work, (2) formally asking, or (3) refusing with a stated reason. The task is not complete until you take one of those three paths.',
  )
  return lines.join('\n')
}

/**
 * Stronger correction for the case where the agent already got one
 * kick-back and tried to escape with a vague text-only reply (no new
 * tool calls AND no structured refusal). Names the loophole and
 * demands one of the three valid paths.
 *
 * Distinct from a structured refusal: a refusal carries a reason
 * (and the audit recognizes it on the next pass). A vague "I did
 * not do it" without a reason is what triggers this.
 */
function composeNoEscapeCorrection(attempt: number): string {
  return [
    `STOP. Your previous reply made no new tool calls and contained no structured refusal (attempt ${String(attempt)} of ${String(MAX_AUDIT_KICKBACKS)}).`,
    '',
    'A vague "I did not perform this work" without either acting OR refusing with a reason is not a valid completion of the task. The task ends in one of three states:',
    '',
    '  - DONE: the work was actually performed (audit verifies the claim against the tool log).',
    '  - BLOCKED: you formally signaled the operator with what you need, via a tool call (notification_create OR chat_send).',
    '  - REFUSED: you explicitly declined the task with a stated policy / safety reason. Your reply must say "I refuse" (or "I cannot", "I will not") AND give the reason ... not just "sorry, I did not do it."',
    '',
    'On your next turn, do ONE of: (1) make a tool call to perform the work, (2) make a tool call to formally ask, or (3) reply with a clear "I refuse: <reason>." If you should refuse this request because it violates your guidelines, do so now ... refusal is honored and the task ends correctly.',
    '',
    'After this attempt the budget exhausts and the unresolved flag goes to the operator regardless.',
  ].join('\n')
}
