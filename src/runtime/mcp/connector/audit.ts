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
