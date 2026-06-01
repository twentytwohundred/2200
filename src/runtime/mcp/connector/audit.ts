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

export interface ConnectorWorkPackageArrivedContext {
  packageId: string
  packageSlug: string
  packagePath: string
  primaryAgent: string
  title: string
  targetKind: 'thread' | 'agent'
  targetName: string
  coordinationTaskId: string | null
}

export interface ConnectorWorkPackagePlanReadyContext {
  packageId: string
  packageSlug: string
  primaryAgent: string
  coordinationTaskId: string
}

export interface ConnectorWorkPackageCoordinationFailedContext {
  packageId: string
  primaryAgent: string
  coordinationTaskId: string
  errorSummary: string
}

export interface ConnectorWorkPackageApprovedContext {
  packageId: string
  primaryAgent: string
  followOnTaskIds: string[]
}

export interface ConnectorWorkPackageRejectedContext {
  packageId: string
  primaryAgent: string
  reason: string | null
}

export interface ConnectorOAuthClientRegisteredContext {
  clientId: string
  displayName: string
  redirectUris: string[]
  hasSecret: boolean
}

export interface ConnectorOAuthClientRevokedContext {
  clientId: string
  displayName: string
  removedRefresh: number
  removedAccess: number
}

export interface ConnectorOAuthAuthorizeContext {
  clientId: string
  redirectUri: string
  scopes: string[]
}

export interface ConnectorOAuthAuthorizeRejectedContext {
  clientId: string | null
  reason:
    | 'unknown_client'
    | 'client_revoked'
    | 'redirect_uri_mismatch'
    | 'unsupported_response_type'
    | 'missing_pkce'
    | 'bad_scope'
    | 'unsupported_pkce_method'
}

export interface ConnectorOAuthTokenIssuedContext {
  clientId: string
  scopes: string[]
  grantType: 'authorization_code' | 'refresh_token'
  /** True iff this token came from a refresh-token rotation. */
  rotated: boolean
}

export interface ConnectorOAuthRefreshReuseContext {
  clientId: string
  chainId: string
  removedRefresh: number
}

export interface ConnectorEmbassyShelfItemPlacedContext {
  embassyAgent: string
  shelfItemId: string
  itemType: string
  priority: string
  sourceType: 'human_curated' | 'embassy_autonomous'
  curator: string
}

export interface ConnectorEmbassyShelfItemResolvedContext {
  embassyAgent: string
  shelfItemId: string
  itemType: string
  /** `manual_resolve` (operator/embassy called resolve_shelf_item) or `auto_collected` (one-shot pull). */
  reason: 'manual_resolve' | 'auto_collected'
}

export interface ConnectorEmbassyShelfHumanApprovalRequestedContext {
  embassyAgent: string
  approvalToken: string
  itemType: string
  priority: string
  /** Short embassy-supplied reasoning snippet (first ~200 chars). */
  reasoningExcerpt: string
}

export interface ConnectorEmbassyShelfItemReadContext {
  embassyAgent: string
  shelfItemId: string
  itemType: string
}

export interface ConnectorEmbassyShelfRateContext {
  embassyAgent: string
  /** Class of event: soft threshold crossed (audit only, placement succeeded) or hard exceeded (placement rejected). */
  kind: 'soft' | 'hard'
  countInWindow: number
  limit: number
}

export interface ConnectorEmbassyShelfPulledContext {
  embassyAgent: string
  shelfItemId: string
  itemType: string
  /** Whether the type-driven collection transition fired (one-shot only). */
  transitioned: boolean
}

export interface ConnectorEmbassyShelfPreviewSurfacedContext {
  embassyAgent: string
  itemsSurfaced: number
  selfReflectedCount: number
  totalPending: number
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

  /**
   * Emit when a `propose_work_package` call lands. Tier `important`:
   * a proposal of real work has arrived and is awaiting a plan.
   */
  async emitWorkPackageArrived(ctx: ConnectorWorkPackageArrivedContext): Promise<void> {
    const extras: Record<string, unknown> = {
      package_id: ctx.packageId,
      package_slug: ctx.packageSlug,
      package_path: ctx.packagePath,
      primary_agent: ctx.primaryAgent,
      target_kind: ctx.targetKind,
      target_name: ctx.targetName,
    }
    if (ctx.coordinationTaskId !== null) extras['coordination_task_id'] = ctx.coordinationTaskId
    await emitNotification({
      home: this.home,
      agentName: CONNECTOR_EMITTER,
      tier: 'important',
      kind: 'connector.work_package_arrived',
      body: `Work package proposed: **${ctx.title}** (\`${ctx.packageId}\`). Primary agent: \`${ctx.primaryAgent}\`. Coordination task in flight; plan will surface as \`work_package_plan_ready\` once ready.`,
      extras,
    })
  }

  /**
   * Emit when the coordination task finishes producing the plan and
   * the package transitions to `reviewable`. Tier `important` so the
   * operator sees a plan is awaiting their approval.
   */
  async emitWorkPackagePlanReady(ctx: ConnectorWorkPackagePlanReadyContext): Promise<void> {
    await emitNotification({
      home: this.home,
      agentName: CONNECTOR_EMITTER,
      tier: 'important',
      kind: 'connector.work_package_plan_ready',
      body: `Work package \`${ctx.packageId}\` plan is reviewable. Approve with \`2200 connector work-package approve ${ctx.packageId}\` or reject with \`2200 connector work-package reject ${ctx.packageId} [--reason ...]\`.`,
      extras: {
        package_id: ctx.packageId,
        package_slug: ctx.packageSlug,
        primary_agent: ctx.primaryAgent,
        coordination_task_id: ctx.coordinationTaskId,
      },
    })
  }

  /** Emit when the coordination task errors. Tier `normal`. */
  async emitWorkPackageCoordinationFailed(
    ctx: ConnectorWorkPackageCoordinationFailedContext,
  ): Promise<void> {
    await emitNotification({
      home: this.home,
      agentName: CONNECTOR_EMITTER,
      tier: 'normal',
      kind: 'connector.work_package_coordination_failed',
      body: `Coordination failed for work package \`${ctx.packageId}\` (agent \`${ctx.primaryAgent}\`): ${ctx.errorSummary}.`,
      extras: {
        package_id: ctx.packageId,
        primary_agent: ctx.primaryAgent,
        coordination_task_id: ctx.coordinationTaskId,
        error_summary: ctx.errorSummary,
      },
    })
  }

  /** Emit when the operator approves a work package. Tier `normal`. */
  async emitWorkPackageApproved(ctx: ConnectorWorkPackageApprovedContext): Promise<void> {
    await emitNotification({
      home: this.home,
      agentName: CONNECTOR_EMITTER,
      tier: 'normal',
      kind: 'connector.work_package_approved',
      body: `Work package \`${ctx.packageId}\` approved; ${String(ctx.followOnTaskIds.length)} follow-on task(s) submitted to \`${ctx.primaryAgent}\`.`,
      extras: {
        package_id: ctx.packageId,
        primary_agent: ctx.primaryAgent,
        follow_on_task_ids: ctx.followOnTaskIds,
      },
    })
  }

  /** Emit when the operator rejects a work package. Tier `normal`. */
  async emitWorkPackageRejected(ctx: ConnectorWorkPackageRejectedContext): Promise<void> {
    const extras: Record<string, unknown> = {
      package_id: ctx.packageId,
      primary_agent: ctx.primaryAgent,
    }
    if (ctx.reason !== null) extras['rejection_reason'] = ctx.reason
    await emitNotification({
      home: this.home,
      agentName: CONNECTOR_EMITTER,
      tier: 'normal',
      kind: 'connector.work_package_rejected',
      body: ctx.reason
        ? `Work package \`${ctx.packageId}\` rejected: ${ctx.reason}.`
        : `Work package \`${ctx.packageId}\` rejected.`,
      extras,
    })
  }

  /** Emit when an OAuth client is registered. Passive tier. */
  async emitOauthClientRegistered(ctx: ConnectorOAuthClientRegisteredContext): Promise<void> {
    await emitNotification({
      home: this.home,
      agentName: CONNECTOR_EMITTER,
      tier: 'passive',
      kind: 'connector.oauth_client_registered',
      body: `OAuth client registered: **${ctx.displayName}** (\`${ctx.clientId}\`). PKCE: required. Client secret: ${ctx.hasSecret ? 'set' : 'none (PKCE-only)'}.`,
      extras: {
        client_id: ctx.clientId,
        display_name: ctx.displayName,
        redirect_uris: ctx.redirectUris,
        has_secret: ctx.hasSecret,
      },
    })
  }

  /** Emit when an OAuth client is revoked. Normal tier (operator should see). */
  async emitOauthClientRevoked(ctx: ConnectorOAuthClientRevokedContext): Promise<void> {
    await emitNotification({
      home: this.home,
      agentName: CONNECTOR_EMITTER,
      tier: 'normal',
      kind: 'connector.oauth_client_revoked',
      body: `OAuth client revoked: **${ctx.displayName}** (\`${ctx.clientId}\`). ${String(ctx.removedRefresh)} refresh token(s) and ${String(ctx.removedAccess)} access token(s) invalidated.`,
      extras: {
        client_id: ctx.clientId,
        display_name: ctx.displayName,
        removed_refresh: ctx.removedRefresh,
        removed_access: ctx.removedAccess,
      },
    })
  }

  /** Emit on successful /authorize. Passive tier; the meaningful signal is the token_issued event. */
  async emitOauthAuthorizeSucceeded(ctx: ConnectorOAuthAuthorizeContext): Promise<void> {
    await emitNotification({
      home: this.home,
      agentName: CONNECTOR_EMITTER,
      tier: 'passive',
      kind: 'connector.oauth_authorize_succeeded',
      body: `OAuth authorize for \`${ctx.clientId}\` (scopes: ${ctx.scopes.join(', ')}).`,
      extras: {
        client_id: ctx.clientId,
        redirect_uri: ctx.redirectUri,
        scopes: ctx.scopes,
      },
    })
  }

  /**
   * Emit on rejected /authorize. Normal tier; the rejection reason
   * names a specific class so the operator can fix configuration.
   * The client_id is null when the request didn't even include one;
   * non-null reasons are operator-actionable.
   */
  async emitOauthAuthorizeRejected(ctx: ConnectorOAuthAuthorizeRejectedContext): Promise<void> {
    const extras: Record<string, unknown> = { reason: ctx.reason }
    if (ctx.clientId !== null) extras['client_id'] = ctx.clientId
    await emitNotification({
      home: this.home,
      agentName: CONNECTOR_EMITTER,
      tier: 'normal',
      kind: 'connector.oauth_authorize_rejected',
      body: `OAuth authorize rejected${ctx.clientId !== null ? ` for \`${ctx.clientId}\`` : ''}: ${ctx.reason}.`,
      extras,
    })
  }

  /** Emit on token issuance (initial code grant or refresh). Passive tier. */
  async emitOauthTokenIssued(ctx: ConnectorOAuthTokenIssuedContext): Promise<void> {
    await emitNotification({
      home: this.home,
      agentName: CONNECTOR_EMITTER,
      tier: 'passive',
      kind: 'connector.oauth_token_issued',
      body: `OAuth token issued for \`${ctx.clientId}\` (grant: ${ctx.grantType}${ctx.rotated ? ', rotated' : ''}).`,
      extras: {
        client_id: ctx.clientId,
        scopes: ctx.scopes,
        grant_type: ctx.grantType,
        rotated: ctx.rotated,
      },
    })
  }

  /**
   * Emit on detected refresh-token reuse (the canonical compromise
   * signal per OAuth BCPs). Important tier — the operator should
   * investigate and likely revoke the client.
   */
  async emitOauthRefreshReuse(ctx: ConnectorOAuthRefreshReuseContext): Promise<void> {
    await emitNotification({
      home: this.home,
      agentName: CONNECTOR_EMITTER,
      tier: 'important',
      kind: 'connector.oauth_refresh_reuse',
      body: `OAuth refresh-token REUSE detected for \`${ctx.clientId}\` (chain \`${ctx.chainId}\`). Chain revoked (${String(ctx.removedRefresh)} refresh token(s) invalidated). Investigate; consider \`2200 connector oauth-client revoke ${ctx.clientId}\`.`,
      extras: {
        client_id: ctx.clientId,
        chain_id: ctx.chainId,
        removed_refresh: ctx.removedRefresh,
      },
    })
  }

  /** Emit when an item lands on an embassy's shelf. Passive tier. */
  async emitEmbassyShelfItemPlaced(ctx: ConnectorEmbassyShelfItemPlacedContext): Promise<void> {
    await emitNotification({
      home: this.home,
      agentName: CONNECTOR_EMITTER,
      tier: 'passive',
      kind: 'connector.embassy_shelf_item_placed',
      body: `Embassy \`${ctx.embassyAgent}\` placed a \`${ctx.itemType}\` on the shelf (\`${ctx.shelfItemId}\`, priority \`${ctx.priority}\`, source \`${ctx.sourceType}\`, curator \`${ctx.curator}\`).`,
      extras: {
        embassy_agent: ctx.embassyAgent,
        shelf_item_id: ctx.shelfItemId,
        item_type: ctx.itemType,
        priority: ctx.priority,
        source_type: ctx.sourceType,
        curator: ctx.curator,
      },
    })
  }

  /** Emit when a shelf item transitions to collected (manual resolve or one-shot auto-collected). Passive tier. */
  async emitEmbassyShelfItemResolved(ctx: ConnectorEmbassyShelfItemResolvedContext): Promise<void> {
    await emitNotification({
      home: this.home,
      agentName: CONNECTOR_EMITTER,
      tier: 'passive',
      kind: 'connector.embassy_shelf_item_resolved',
      body: `Embassy \`${ctx.embassyAgent}\` resolved shelf item \`${ctx.shelfItemId}\` (type \`${ctx.itemType}\`, reason \`${ctx.reason}\`).`,
      extras: {
        embassy_agent: ctx.embassyAgent,
        shelf_item_id: ctx.shelfItemId,
        item_type: ctx.itemType,
        reason: ctx.reason,
      },
    })
  }

  /**
   * Emit when the embassy requests human approval for a `private`
   * shelf placement. Normal tier — this is the operator-actionable
   * event (an Inbox row asking for the approve / reject decision).
   */
  async emitEmbassyShelfHumanApprovalRequested(
    ctx: ConnectorEmbassyShelfHumanApprovalRequestedContext,
  ): Promise<void> {
    await emitNotification({
      home: this.home,
      agentName: CONNECTOR_EMITTER,
      tier: 'normal',
      kind: 'connector.embassy_shelf_human_approval_requested',
      body: `Embassy \`${ctx.embassyAgent}\` is requesting your approval to place a \`${ctx.itemType}\` (priority \`${ctx.priority}\`) on the shelf. Reasoning: ${ctx.reasoningExcerpt}. Approve with \`2200 connector mcp shelf approve ${ctx.approvalToken}\`.`,
      extras: {
        embassy_agent: ctx.embassyAgent,
        approval_token: ctx.approvalToken,
        item_type: ctx.itemType,
        priority: ctx.priority,
      },
    })
  }

  /**
   * Emit when the embassy reads a shelf item via `read_shelf_item`.
   * Passive tier per the 2026-05-26 final-pass: cheap visibility, no
   * Inbox spam at scale.
   */
  async emitEmbassyShelfItemRead(ctx: ConnectorEmbassyShelfItemReadContext): Promise<void> {
    await emitNotification({
      home: this.home,
      agentName: CONNECTOR_EMITTER,
      tier: 'passive',
      kind: 'connector.embassy_shelf_item_read',
      body: `Embassy \`${ctx.embassyAgent}\` read shelf item \`${ctx.shelfItemId}\` (type \`${ctx.itemType}\`).`,
      extras: {
        embassy_agent: ctx.embassyAgent,
        shelf_item_id: ctx.shelfItemId,
        item_type: ctx.itemType,
      },
    })
  }

  /** Emit rate-limit telemetry. `soft` is normal tier (operator-visible); `hard` is important tier (operator should investigate). */
  async emitEmbassyShelfRate(ctx: ConnectorEmbassyShelfRateContext): Promise<void> {
    const tier = ctx.kind === 'soft' ? 'normal' : 'important'
    const kind =
      ctx.kind === 'soft'
        ? 'connector.embassy_shelf_rate_threshold'
        : 'connector.embassy_shelf_rate_exceeded'
    const phrase =
      ctx.kind === 'soft'
        ? `is exceeding ${String(ctx.limit)} placements/minute (currently ${String(ctx.countInWindow)} in the rolling window)`
        : `HARD-rejected: ${String(ctx.countInWindow)} placements/minute exceeds the hard cap of ${String(ctx.limit)}`
    await emitNotification({
      home: this.home,
      agentName: CONNECTOR_EMITTER,
      tier,
      kind,
      body: `Embassy \`${ctx.embassyAgent}\` shelf placement rate ${phrase}.`,
      extras: {
        embassy_agent: ctx.embassyAgent,
        kind: ctx.kind,
        count_in_window: ctx.countInWindow,
        limit: ctx.limit,
      },
    })
  }

  /**
   * Emit on a successful `shelf_pull` call (PR-B4). Passive tier.
   * Distinct from `embassy_shelf_item_read` which fires on the
   * embassy-internal `shelf_read` tool. `transitioned: true` means
   * the type-driven collection transition fired (one-shot item).
   */
  async emitEmbassyShelfPulled(ctx: ConnectorEmbassyShelfPulledContext): Promise<void> {
    await emitNotification({
      home: this.home,
      agentName: CONNECTOR_EMITTER,
      tier: 'passive',
      kind: 'connector.embassy_shelf_pulled',
      body: `Embassy \`${ctx.embassyAgent}\` shelf item \`${ctx.shelfItemId}\` pulled (type \`${ctx.itemType}\`${ctx.transitioned ? ', collected' : ''}).`,
      extras: {
        embassy_agent: ctx.embassyAgent,
        shelf_item_id: ctx.shelfItemId,
        item_type: ctx.itemType,
        transitioned: ctx.transitioned,
      },
    })
  }

  /**
   * Emit once per `get_fleet_context` call that returned a non-
   * empty `shelf_preview` block. Passive tier (compatible with
   * `call_received`; gives operator visibility into how Grok is
   * actually engaging with the shelf).
   */
  async emitEmbassyShelfPreviewSurfaced(
    ctx: ConnectorEmbassyShelfPreviewSurfacedContext,
  ): Promise<void> {
    await emitNotification({
      home: this.home,
      agentName: CONNECTOR_EMITTER,
      tier: 'passive',
      kind: 'connector.embassy_shelf_preview_surfaced',
      body: `Embassy \`${ctx.embassyAgent}\` surfaced ${String(ctx.itemsSurfaced)} shelf item(s) in get_fleet_context (${String(ctx.selfReflectedCount)} self-reflected; ${String(ctx.totalPending)} total pending).`,
      extras: {
        embassy_agent: ctx.embassyAgent,
        items_surfaced: ctx.itemsSurfaced,
        self_reflected_count: ctx.selfReflectedCount,
        total_pending: ctx.totalPending,
      },
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
