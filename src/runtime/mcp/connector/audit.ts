/**
 * Inbox audit for the MCP connector.
 *
 * Every inbound request to the connector listener — successful or
 * rejected — produces an Inbox event. Successful calls land at the
 * `passive` tier (background visibility, queryable, no operator
 * notification); failed-auth events land at the `normal` tier
 * (operator-visible in the feed), throttled per source IP so a
 * scanner pounding on the public endpoint cannot flood the Inbox.
 *
 * The emitter is the synthetic `__connector` agent — the connector
 * is a fleet-level surface with no per-Agent identity, and the
 * Inbox schema requires an `agent` field. Using `__connector` makes
 * it visually distinct from real Agents in the feed.
 */
import { emitNotification } from '../../notifications/writer.js'

/** Synthetic emitter name for fleet-level connector events. */
export const CONNECTOR_EMITTER = '__connector'

/** One throttle entry per source IP. State is per-process; reset on restart is acceptable. */
interface ThrottleEntry {
  lastEmittedAtMs: number
  suppressedSinceLast: number
}

export interface ConnectorAuditDeps {
  home: string
  /** Wall-clock source for throttle decisions; injectable for tests. */
  now?: () => number
}

export interface ConnectorCallContext {
  /** Source IP of the inbound request. */
  sourceIp: string
  /** MCP method (e.g. "tools/list", "tools/call", "initialize"). */
  method: string
  /** Tool name if known (only meaningful for tools/call). */
  toolName?: string
  /** Args summary; the caller is responsible for PII sanitization. */
  argsSummary?: string
}

export interface ConnectorCallErrorContext extends ConnectorCallContext {
  /** Error class / message; sanitized by the caller. */
  errorSummary: string
}

export interface ConnectorAuthRejectionContext {
  sourceIp: string
  /** Coarse reason class. Never include token bytes. */
  reason: 'missing_header' | 'bad_prefix' | 'length_mismatch' | 'value_mismatch'
}

export interface ConnectorListenerStateContext {
  state: 'started' | 'stopped'
  port?: number
  reason?: string
}

export interface ConnectorContributionContext {
  /** Source IP of the inbound call (best effort). */
  sourceIp: string
  /** Whether the contribution targeted a shared research thread or a single Agent. */
  targetKind: 'thread' | 'agent'
  /** Thread slug or Agent name. */
  targetName: string
  /** Slug of the Brain note that was written / appended. */
  contributionSlug: string
  /** Absolute path to the Brain note for one-click operator follow. */
  contributionPath: string
}

export interface ConnectorSynthesisLifecycleContext {
  /** Bare thread slug. */
  threadSlug: string
  /** Primary Agent assigned to synthesize this thread. */
  primaryAgent: string
}

export interface ConnectorSynthesisCompletedContext extends ConnectorSynthesisLifecycleContext {
  /** Number of contributions synthesized. */
  contributionCount: number
  /** Brief sibling note slug. */
  briefSlug: string
  /** Wall-clock duration of the synthesis task. */
  durationMs?: number
}

export interface ConnectorSynthesisFailedContext extends ConnectorSynthesisLifecycleContext {
  /** Coarse class. */
  errorClass: 'task_errored' | 'budget_exceeded' | 'tool_failure' | 'unknown'
  /** Error summary; caller sanitizes. */
  errorSummary: string
  /** Consecutive failure count after this failure. */
  failureCount: number
  /** True iff this failure escalates the thread to `synthesis_blocked`. */
  blocked: boolean
}

export interface ConnectorSynthesisPrimaryMissingContext {
  /** Bare thread slug. */
  threadSlug: string
  /** Name the anchor recorded (may be a stale name with no live record). */
  expectedAgent: string | null
}

const FAILED_AUTH_THROTTLE_WINDOW_MS = 10 * 60 * 1000

/**
 * Per-process throttle for `connector_auth_rejected` events.
 *
 * State is in-memory and dies with the listener restart. That's
 * intentional: a long-lived scanner would re-flood after a restart,
 * but the operator has visibility into the restart event itself, so
 * the trade-off favors simplicity (no on-disk throttle state to
 * corrupt or migrate). Per the design review, the throttle window is
 * 10 minutes per source IP.
 */
export class ConnectorAuditEmitter {
  private readonly home: string
  private readonly now: () => number
  private readonly failedAuthThrottle = new Map<string, ThrottleEntry>()

  constructor(deps: ConnectorAuditDeps) {
    this.home = deps.home
    this.now = deps.now ?? Date.now
  }

  /**
   * Emit a "call received" audit event at the START of inbound request
   * handling — before the MCP transport is given control. Passive tier.
   *
   * Why pre-handoff and not post: the SDK's streamable-HTTP transport
   * holds the response open for the lifetime of any SSE stream, which
   * for a tools/call can extend well past the JSON-RPC result. Emitting
   * "call received" at request-receipt time gives the operator the
   * right semantic ("Grok called in") without depending on stream
   * lifecycle. If we later need latency or completion telemetry, a
   * paired finish event with proper transport hooks is the follow-up.
   */
  async emitCallReceived(ctx: ConnectorCallContext): Promise<void> {
    const extras: Record<string, unknown> = {
      source_ip: ctx.sourceIp,
      method: ctx.method,
    }
    if (ctx.toolName !== undefined) extras['tool_name'] = ctx.toolName
    if (ctx.argsSummary !== undefined) extras['args_summary'] = ctx.argsSummary

    const body =
      ctx.toolName !== undefined
        ? `MCP connector call: \`${ctx.method}\` → \`${ctx.toolName}\` from ${ctx.sourceIp}`
        : `MCP connector call: \`${ctx.method}\` from ${ctx.sourceIp}`

    await emitNotification({
      home: this.home,
      agentName: CONNECTOR_EMITTER,
      tier: 'passive',
      kind: 'connector.call_received',
      body,
      extras,
    })
  }

  /**
   * Emit a "call errored" audit event when the MCP transport throws
   * before/while writing its response. Tier `normal` so the operator
   * sees it in the Inbox feed — error-on-error is the kind of thing
   * worth surfacing.
   */
  async emitCallErrored(ctx: ConnectorCallErrorContext): Promise<void> {
    const extras: Record<string, unknown> = {
      source_ip: ctx.sourceIp,
      method: ctx.method,
      error_summary: ctx.errorSummary,
    }
    if (ctx.toolName !== undefined) extras['tool_name'] = ctx.toolName
    if (ctx.argsSummary !== undefined) extras['args_summary'] = ctx.argsSummary

    const body =
      ctx.toolName !== undefined
        ? `MCP connector call errored: \`${ctx.method}\` → \`${ctx.toolName}\` from ${ctx.sourceIp}: ${ctx.errorSummary}`
        : `MCP connector call errored: \`${ctx.method}\` from ${ctx.sourceIp}: ${ctx.errorSummary}`

    await emitNotification({
      home: this.home,
      agentName: CONNECTOR_EMITTER,
      tier: 'normal',
      kind: 'connector.call_errored',
      body,
      extras,
    })
  }

  /**
   * Emit a failed-auth event, throttled to one per source IP per
   * 10-minute window. The caller's metric counters still tick on every
   * rejection (handled at the listener layer); only the user-visible
   * notification is suppressed.
   *
   * Returns true if an Inbox event was emitted, false if it was
   * throttled. Useful for tests and for the listener's metric counter.
   */
  async emitAuthRejected(ctx: ConnectorAuthRejectionContext): Promise<boolean> {
    const now = this.now()
    const entry = this.failedAuthThrottle.get(ctx.sourceIp)
    if (entry !== undefined && now - entry.lastEmittedAtMs < FAILED_AUTH_THROTTLE_WINDOW_MS) {
      entry.suppressedSinceLast += 1
      return false
    }
    const suppressed = entry?.suppressedSinceLast ?? 0
    this.failedAuthThrottle.set(ctx.sourceIp, {
      lastEmittedAtMs: now,
      suppressedSinceLast: 0,
    })
    const windowMinutes = String(FAILED_AUTH_THROTTLE_WINDOW_MS / 60_000)
    const body =
      suppressed > 0
        ? `MCP connector auth rejected from ${ctx.sourceIp} (reason: ${ctx.reason}; ${String(suppressed)} similar attempts suppressed in last ${windowMinutes}m).`
        : `MCP connector auth rejected from ${ctx.sourceIp} (reason: ${ctx.reason}).`
    await emitNotification({
      home: this.home,
      agentName: CONNECTOR_EMITTER,
      tier: 'normal',
      kind: 'connector.auth_rejected',
      body,
      extras: {
        source_ip: ctx.sourceIp,
        reason: ctx.reason,
        suppressed_since_last: suppressed,
      },
    })
    return true
  }

  /**
   * Emit a contribution-received audit event when `contribute_to_thread`
   * persists a Brain note. Passive tier — the audit lives alongside the
   * generic `call_received` so an operator can locate the produced note
   * from the Inbox without scanning the brain directly. The `target_kind`
   * + `target_name` + `contribution_slug` + `contribution_path` extras
   * are what make the Inbox row useful at a glance per Grok's review.
   */
  async emitContributionReceived(ctx: ConnectorContributionContext): Promise<void> {
    const body =
      ctx.targetKind === 'thread'
        ? `MCP contribution received → thread \`${ctx.targetName}\` (\`${ctx.contributionSlug}\`)`
        : `MCP contribution received → agent \`${ctx.targetName}\` (\`${ctx.contributionSlug}\`)`
    await emitNotification({
      home: this.home,
      agentName: CONNECTOR_EMITTER,
      tier: 'passive',
      kind: 'connector.contribution_received',
      body,
      extras: {
        source_ip: ctx.sourceIp,
        target_kind: ctx.targetKind,
        target_name: ctx.targetName,
        contribution_slug: ctx.contributionSlug,
        contribution_path: ctx.contributionPath,
      },
    })
  }

  /** Emit when the reconciler hands a synthesis task to the primary Agent. Passive. */
  async emitSynthesisStarted(ctx: ConnectorSynthesisLifecycleContext): Promise<void> {
    await emitNotification({
      home: this.home,
      agentName: CONNECTOR_EMITTER,
      tier: 'passive',
      kind: 'connector.synthesis_started',
      body: `Synthesis started for thread \`${ctx.threadSlug}\` (primary agent: \`${ctx.primaryAgent}\`).`,
      extras: { thread_slug: ctx.threadSlug, primary_agent: ctx.primaryAgent },
    })
  }

  /** Emit when synthesis completes and a fresh brief is written. Passive. */
  async emitSynthesisCompleted(ctx: ConnectorSynthesisCompletedContext): Promise<void> {
    const extras: Record<string, unknown> = {
      thread_slug: ctx.threadSlug,
      primary_agent: ctx.primaryAgent,
      contribution_count: ctx.contributionCount,
      brief_slug: ctx.briefSlug,
    }
    if (ctx.durationMs !== undefined) extras['duration_ms'] = ctx.durationMs
    await emitNotification({
      home: this.home,
      agentName: CONNECTOR_EMITTER,
      tier: 'passive',
      kind: 'connector.synthesis_completed',
      body: `Synthesis completed for thread \`${ctx.threadSlug}\` (${String(ctx.contributionCount)} contributions).`,
      extras,
    })
  }

  /**
   * Emit when synthesis fails. Tier escalates to `important` once the
   * thread is `synthesis_blocked` so the operator sees that
   * future contributions to this thread will not auto-synthesize until
   * they unblock.
   */
  async emitSynthesisFailed(ctx: ConnectorSynthesisFailedContext): Promise<void> {
    await emitNotification({
      home: this.home,
      agentName: CONNECTOR_EMITTER,
      tier: ctx.blocked ? 'important' : 'normal',
      kind: 'connector.synthesis_failed',
      body: ctx.blocked
        ? `Synthesis BLOCKED for thread \`${ctx.threadSlug}\` after ${String(ctx.failureCount)} consecutive failures: ${ctx.errorClass}. Unblock with \`2200 connector synthesis unblock ${ctx.threadSlug}\`.`
        : `Synthesis failed for thread \`${ctx.threadSlug}\` (failure ${String(ctx.failureCount)}): ${ctx.errorClass}.`,
      extras: {
        thread_slug: ctx.threadSlug,
        primary_agent: ctx.primaryAgent,
        error_class: ctx.errorClass,
        error_summary: ctx.errorSummary,
        failure_count: ctx.failureCount,
        blocked: ctx.blocked,
      },
    })
  }

  /** Emit when the primary Agent assigned to a thread is missing / not running. */
  async emitSynthesisPrimaryMissing(ctx: ConnectorSynthesisPrimaryMissingContext): Promise<void> {
    const extras: Record<string, unknown> = { thread_slug: ctx.threadSlug }
    if (ctx.expectedAgent !== null) extras['expected_agent'] = ctx.expectedAgent
    await emitNotification({
      home: this.home,
      agentName: CONNECTOR_EMITTER,
      tier: 'normal',
      kind: 'connector.synthesis_primary_missing',
      body:
        ctx.expectedAgent === null
          ? `Thread \`${ctx.threadSlug}\` has no primary agent assigned; synthesis is paused until one is set.`
          : `Thread \`${ctx.threadSlug}\` primary agent \`${ctx.expectedAgent}\` is not running; synthesis is paused.`,
      extras,
    })
  }

  /** Emit a listener lifecycle event. Passive tier. */
  async emitListenerStateChanged(ctx: ConnectorListenerStateContext): Promise<void> {
    // `listener_state` (not `state`) because `state` is a canonical
    // notification-frontmatter field (lifecycle: pending|answered|dismissed)
    // and writer.emitNotification drops extras that collide with canonical
    // keys.
    const extras: Record<string, unknown> = { listener_state: ctx.state }
    if (ctx.port !== undefined) extras['port'] = ctx.port
    if (ctx.reason !== undefined) extras['reason'] = ctx.reason
    const portFragment = ctx.port !== undefined ? ` on port ${String(ctx.port)}` : ''
    const reasonFragment = ctx.reason !== undefined ? ` (${ctx.reason})` : ''
    await emitNotification({
      home: this.home,
      agentName: CONNECTOR_EMITTER,
      tier: 'passive',
      kind: 'connector.listener_state_changed',
      body: `MCP connector listener ${ctx.state}${portFragment}${reasonFragment}.`,
      extras,
    })
  }
}
