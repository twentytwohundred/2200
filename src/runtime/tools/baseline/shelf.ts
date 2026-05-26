/**
 * Shelf internal tools (Phase 2 / PR-B2).
 *
 * Nine tools, all embassy-internal — never exposed to the remote
 * model. Dispatcher allowlist enforces this mechanically:
 * subsequent PRs put the embassy Agent's identity tool set on the
 * strict-allowlist mechanism added in PR 4. From B2 onward, an
 * Agent that is not the embassy for any conduit cannot reach these
 * tools at all (they're gated by `tools:` + the dispatcher's
 * identity-level check).
 *
 * Spec → runtime name mapping (the spec section 8 names don't fit
 * the runtime's `<namespace>_<verb>` convention; same identities,
 * renamed for the registry):
 *
 *   place_on_shelf                → shelf_place
 *   resolve_shelf_item            → shelf_resolve
 *   reopen_shelf_item             → shelf_reopen
 *   reprioritize_shelf_item       → shelf_reprioritize
 *   remove_from_shelf             → shelf_remove
 *   list_my_shelf                 → shelf_list_mine
 *   read_shelf_item               → shelf_read
 *   curate_from_inbox             → shelf_curate_from_inbox
 *   request_human_shelf_placement → shelf_request_human_placement
 *
 * Sensitivity gate (locked 2026-05-26): `place_on_shelf` REJECTS
 * `sensitivity: 'private'` at the Zod schema layer (the enum value
 * is restricted to `'none'` for that tool). Private items flow
 * through `request_human_shelf_placement`, which writes a pending-
 * approval record and emits an Inbox notification with the
 * approval_token.
 *
 * Rate limiting (locked 2026-05-26): in-memory per-embassy rolling
 * 60-second window. Soft threshold (default 20/min) fires an
 * audit event; hard threshold (default 100/min) rejects the call
 * with `ToolDeniedError`. Per-embassy overrides on the conduit
 * record's `rate_limits` field; system defaults apply when absent.
 */
import { z } from 'zod'
import { ToolDeniedError } from '../dispatcher.js'
import { defineTool, type ToolDefinition } from '../../mcp/tool.js'
import { ConnectorAuditEmitter } from '../../mcp/connector/audit.js'
import { listConduits, recordLastSeen } from '../../mcp/connector/embassy/conduits.js'
import {
  DEFAULT_SHELF_RATE_LIMITS,
  ShelfRateLimiter,
} from '../../mcp/connector/embassy/shelf/rate-limit.js'
import {
  deleteShelfItem,
  listShelfItems,
  readShelfItem,
  writeShelfItem,
} from '../../mcp/connector/embassy/shelf/store.js'
import {
  ShelfItemPrioritySchema,
  ShelfItemSourceSchema,
  ShelfItemTypeSchema,
  newShelfItemId,
  type ShelfItemFrontmatter,
} from '../../mcp/connector/embassy/shelf/types.js'
import {
  newApprovalToken,
  saveApproval,
  type PendingApproval,
} from '../../mcp/connector/embassy/shelf/approval-store.js'

// Process-wide rate limiter. Resets on Agent restart per the locked spec.
const RATE_LIMITER = new ShelfRateLimiter()

/**
 * Look up the active (non-retired) conduit for an embassy. Returns
 * null if the calling Agent isn't bound to any conduit — in that
 * case all shelf tools refuse via ToolDeniedError, since shelf
 * tools are embassy-only.
 */
async function lookupConduit(
  home: string,
  embassyAgent: string,
): Promise<{
  client_id: string
  external_model: string
  embassy_agent: string
  rate_limits: typeof DEFAULT_SHELF_RATE_LIMITS
} | null> {
  const items = await listConduits(home)
  const match = items.find((c) => c.embassy_agent === embassyAgent && c.retired_at === null)
  if (match === undefined) return null
  return {
    client_id: match.client_id,
    external_model: match.external_model,
    embassy_agent: match.embassy_agent,
    rate_limits: match.rate_limits ?? DEFAULT_SHELF_RATE_LIMITS,
  }
}

function rejectNotAnEmbassy(toolName: string): never {
  throw new ToolDeniedError(
    toolName,
    'not_an_embassy',
    `${toolName} is an embassy-internal tool; the calling agent is not bound to any active conduit. Register an embassy via '2200 connector mcp register' first.`,
  )
}

// ---------------------------------------------------------------------------
// place_on_shelf
// ---------------------------------------------------------------------------

const PlaceOnShelfArgsSchema = z.object({
  type: ShelfItemTypeSchema,
  body: z.string().min(1),
  source: ShelfItemSourceSchema,
  priority: ShelfItemPrioritySchema.default('normal'),
  /**
   * MUST be omitted or `'none'`. Private items flow through
   * `request_human_shelf_placement`; the Zod schema rejects
   * anything else at the dispatcher boundary.
   */
  sensitivity: z.literal('none').default('none'),
})

export const placeOnShelf = defineTool({
  name: 'shelf_place',
  description:
    "Place an informational item on this embassy's shelf for the next inbound call. Embassy-internal only. Rejects 'private' sensitivity outright — use request_human_shelf_placement for items that require operator approval.",
  idempotency: 'destructive',
  argsSchema: PlaceOnShelfArgsSchema,
  execute: async (args, ctx) => {
    const conduit = await lookupConduit(ctx.home, ctx.callingAgent)
    if (conduit === null) rejectNotAnEmbassy('shelf_place')
    const rate = RATE_LIMITER.classifyAndRecord(ctx.callingAgent, conduit.rate_limits)
    const audit = new ConnectorAuditEmitter({ home: ctx.home })
    if (rate === 'hard_threshold_exceeded') {
      const limit = conduit.rate_limits.hard_per_minute
      const count = RATE_LIMITER.size(ctx.callingAgent)
      await audit
        .emitEmbassyShelfRate({
          embassyAgent: ctx.callingAgent,
          kind: 'hard',
          countInWindow: count,
          limit,
        })
        .catch(() => undefined)
      throw new ToolDeniedError(
        'shelf_place',
        'placement_rate_exceeded',
        `embassy ${ctx.callingAgent} has exceeded ${String(limit)} placements/minute (hard cap); rejected.`,
      )
    }
    if (rate === 'soft_threshold_crossed') {
      await audit
        .emitEmbassyShelfRate({
          embassyAgent: ctx.callingAgent,
          kind: 'soft',
          countInWindow: RATE_LIMITER.size(ctx.callingAgent),
          limit: conduit.rate_limits.soft_per_minute,
        })
        .catch(() => undefined)
    }
    const now = new Date()
    const shelfItemId = newShelfItemId()
    const frontmatter: ShelfItemFrontmatter = {
      schema_version: 1,
      shelf_item_id: shelfItemId,
      type: args.type,
      source_type: 'embassy_autonomous',
      source: args.source,
      target_model: conduit.external_model,
      provenance: {
        ingested_at: now.toISOString(),
        ingested_by: ctx.callingAgent,
        original_contribution_slug:
          args.source.origin === 'contribution' ? args.source.reference : null,
        chain: [],
      },
      priority: args.priority,
      status: 'pending',
      collected_at: null,
      sensitivity: 'none',
    }
    await writeShelfItem(ctx.home, ctx.callingAgent, frontmatter, args.body)
    await recordLastSeen(ctx.home, conduit.client_id, now).catch(() => undefined)
    await audit
      .emitEmbassyShelfItemPlaced({
        embassyAgent: ctx.callingAgent,
        shelfItemId,
        itemType: args.type,
        priority: args.priority,
        sourceType: 'embassy_autonomous',
        curator: args.source.curator,
      })
      .catch(() => undefined)
    return { shelf_item_id: shelfItemId, status: 'pending' as const }
  },
})

// ---------------------------------------------------------------------------
// resolve_shelf_item / reopen_shelf_item
// ---------------------------------------------------------------------------

const ShelfIdOnlyArgs = z.object({ shelf_item_id: z.string().min(1) })

export const resolveShelfItem = defineTool({
  name: 'shelf_resolve',
  description:
    'Mark a shelf item as collected (force a transition). Use this to take a standing item off the surfacing rotation manually, or to clean up an item the embassy has handled out-of-band.',
  idempotency: 'destructive',
  argsSchema: ShelfIdOnlyArgs,
  execute: async (args, ctx) => {
    const conduit = await lookupConduit(ctx.home, ctx.callingAgent)
    if (conduit === null) rejectNotAnEmbassy('shelf_resolve')
    const rec = await readShelfItem(ctx.home, ctx.callingAgent, args.shelf_item_id)
    if (rec === null) {
      throw new ToolDeniedError(
        'shelf_resolve',
        'unknown_shelf_item',
        `no shelf item ${args.shelf_item_id} for embassy ${ctx.callingAgent}`,
      )
    }
    if (rec.frontmatter.status === 'collected') {
      return { shelf_item_id: args.shelf_item_id, status: 'collected' as const, changed: false }
    }
    const updated: ShelfItemFrontmatter = {
      ...rec.frontmatter,
      status: 'collected',
      collected_at: new Date().toISOString(),
    }
    await writeShelfItem(ctx.home, ctx.callingAgent, updated, rec.body)
    await new ConnectorAuditEmitter({ home: ctx.home })
      .emitEmbassyShelfItemResolved({
        embassyAgent: ctx.callingAgent,
        shelfItemId: args.shelf_item_id,
        itemType: rec.frontmatter.type,
        reason: 'manual_resolve',
      })
      .catch(() => undefined)
    return { shelf_item_id: args.shelf_item_id, status: 'collected' as const, changed: true }
  },
})

export const reopenShelfItem = defineTool({
  name: 'shelf_reopen',
  description: 'Re-open a collected shelf item: status → pending, collected_at cleared.',
  idempotency: 'destructive',
  argsSchema: ShelfIdOnlyArgs,
  execute: async (args, ctx) => {
    const conduit = await lookupConduit(ctx.home, ctx.callingAgent)
    if (conduit === null) rejectNotAnEmbassy('shelf_reopen')
    const rec = await readShelfItem(ctx.home, ctx.callingAgent, args.shelf_item_id)
    if (rec === null) {
      throw new ToolDeniedError(
        'shelf_reopen',
        'unknown_shelf_item',
        `no shelf item ${args.shelf_item_id} for embassy ${ctx.callingAgent}`,
      )
    }
    if (rec.frontmatter.status === 'pending') {
      return { shelf_item_id: args.shelf_item_id, status: 'pending' as const, changed: false }
    }
    const updated: ShelfItemFrontmatter = {
      ...rec.frontmatter,
      status: 'pending',
      collected_at: null,
    }
    await writeShelfItem(ctx.home, ctx.callingAgent, updated, rec.body)
    return { shelf_item_id: args.shelf_item_id, status: 'pending' as const, changed: true }
  },
})

// ---------------------------------------------------------------------------
// reprioritize_shelf_item
// ---------------------------------------------------------------------------

const ReprioritizeArgsSchema = z.object({
  shelf_item_id: z.string().min(1),
  priority: ShelfItemPrioritySchema,
})

export const reprioritizeShelfItem = defineTool({
  name: 'shelf_reprioritize',
  description: "Change a shelf item's priority.",
  idempotency: 'destructive',
  argsSchema: ReprioritizeArgsSchema,
  execute: async (args, ctx) => {
    const conduit = await lookupConduit(ctx.home, ctx.callingAgent)
    if (conduit === null) rejectNotAnEmbassy('shelf_reprioritize')
    const rec = await readShelfItem(ctx.home, ctx.callingAgent, args.shelf_item_id)
    if (rec === null) {
      throw new ToolDeniedError(
        'shelf_reprioritize',
        'unknown_shelf_item',
        `no shelf item ${args.shelf_item_id} for embassy ${ctx.callingAgent}`,
      )
    }
    if (rec.frontmatter.priority === args.priority) {
      return { shelf_item_id: args.shelf_item_id, priority: args.priority, changed: false }
    }
    const updated: ShelfItemFrontmatter = { ...rec.frontmatter, priority: args.priority }
    await writeShelfItem(ctx.home, ctx.callingAgent, updated, rec.body)
    return { shelf_item_id: args.shelf_item_id, priority: args.priority, changed: true }
  },
})

// ---------------------------------------------------------------------------
// remove_from_shelf
// ---------------------------------------------------------------------------

export const removeFromShelf = defineTool({
  name: 'shelf_remove',
  description:
    'Delete a shelf item entirely. Use when the item was placed in error or is no longer useful. Prefer resolve_shelf_item to preserve audit history.',
  idempotency: 'destructive',
  argsSchema: ShelfIdOnlyArgs,
  execute: async (args, ctx) => {
    const conduit = await lookupConduit(ctx.home, ctx.callingAgent)
    if (conduit === null) rejectNotAnEmbassy('shelf_remove')
    const removed = await deleteShelfItem(ctx.home, ctx.callingAgent, args.shelf_item_id)
    return { shelf_item_id: args.shelf_item_id, removed }
  },
})

// ---------------------------------------------------------------------------
// list_my_shelf
// ---------------------------------------------------------------------------

const ListMyShelfArgsSchema = z.object({
  status: z.enum(['pending', 'collected']).optional(),
  type: ShelfItemTypeSchema.optional(),
  priority: ShelfItemPrioritySchema.optional(),
  limit: z.number().int().min(1).max(500).default(200),
})

export const listMyShelf = defineTool({
  name: 'shelf_list_mine',
  description:
    "List items on this embassy's shelf, oldest first. Returns full bodies — for the model-facing bounded preview, see get_fleet_context (B4).",
  idempotency: 'pure',
  argsSchema: ListMyShelfArgsSchema,
  execute: async (args, ctx) => {
    const conduit = await lookupConduit(ctx.home, ctx.callingAgent)
    if (conduit === null) rejectNotAnEmbassy('shelf_list_mine')
    const items = await listShelfItems(ctx.home, ctx.callingAgent, {
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.type !== undefined ? { type: args.type } : {}),
      ...(args.priority !== undefined ? { priority: args.priority } : {}),
      limit: args.limit,
    })
    return {
      items: items.map((r) => ({
        shelf_item_id: r.frontmatter.shelf_item_id,
        type: r.frontmatter.type,
        priority: r.frontmatter.priority,
        status: r.frontmatter.status,
        source_type: r.frontmatter.source_type,
        ingested_at: r.frontmatter.provenance.ingested_at,
        collected_at: r.frontmatter.collected_at,
        body: r.body,
      })),
    }
  },
})

// ---------------------------------------------------------------------------
// read_shelf_item
// ---------------------------------------------------------------------------

export const readShelfItemTool = defineTool({
  name: 'shelf_read',
  description:
    'Read a single shelf item by id. Returns full body + frontmatter. Embassy-internal — for the model-facing pull path, see B4.',
  idempotency: 'pure',
  argsSchema: ShelfIdOnlyArgs,
  execute: async (args, ctx) => {
    const conduit = await lookupConduit(ctx.home, ctx.callingAgent)
    if (conduit === null) rejectNotAnEmbassy('shelf_read')
    const rec = await readShelfItem(ctx.home, ctx.callingAgent, args.shelf_item_id)
    if (rec === null) {
      throw new ToolDeniedError(
        'shelf_read',
        'unknown_shelf_item',
        `no shelf item ${args.shelf_item_id} for embassy ${ctx.callingAgent}`,
      )
    }
    await new ConnectorAuditEmitter({ home: ctx.home })
      .emitEmbassyShelfItemRead({
        embassyAgent: ctx.callingAgent,
        shelfItemId: args.shelf_item_id,
        itemType: rec.frontmatter.type,
      })
      .catch(() => undefined)
    return {
      shelf_item_id: rec.frontmatter.shelf_item_id,
      frontmatter: rec.frontmatter,
      body: rec.body,
    }
  },
})

// ---------------------------------------------------------------------------
// curate_from_inbox
// ---------------------------------------------------------------------------

const CurateFromInboxArgsSchema = z.object({
  /** Inbox notification id the curation derives from. */
  notification_id: z.string().min(1),
  type: ShelfItemTypeSchema,
  /** Override body; when null, the inbox notification body is used verbatim. */
  body: z.string().min(1),
  priority: ShelfItemPrioritySchema.default('normal'),
  /** Operator name being recorded as curator. The embassy supplies this from context. */
  curator: z.string().min(1),
})

export const curateFromInbox = defineTool({
  name: 'shelf_curate_from_inbox',
  description:
    "Move a curated item from the operator's Inbox onto this embassy's shelf. Provenance records the originating notification id; source_type is 'human_curated'.",
  idempotency: 'destructive',
  argsSchema: CurateFromInboxArgsSchema,
  execute: async (args, ctx) => {
    const conduit = await lookupConduit(ctx.home, ctx.callingAgent)
    if (conduit === null) rejectNotAnEmbassy('shelf_curate_from_inbox')
    const now = new Date()
    const shelfItemId = newShelfItemId()
    const fm: ShelfItemFrontmatter = {
      schema_version: 1,
      shelf_item_id: shelfItemId,
      type: args.type,
      source_type: 'human_curated',
      source: {
        origin: 'inbox',
        reference: args.notification_id,
        curator: args.curator,
        client_id: null,
        timestamp: now.toISOString(),
      },
      target_model: conduit.external_model,
      provenance: {
        ingested_at: now.toISOString(),
        ingested_by: ctx.callingAgent,
        original_contribution_slug: null,
        chain: [],
      },
      priority: args.priority,
      status: 'pending',
      collected_at: null,
      sensitivity: 'none',
    }
    await writeShelfItem(ctx.home, ctx.callingAgent, fm, args.body)
    await new ConnectorAuditEmitter({ home: ctx.home })
      .emitEmbassyShelfItemPlaced({
        embassyAgent: ctx.callingAgent,
        shelfItemId,
        itemType: args.type,
        priority: args.priority,
        sourceType: 'human_curated',
        curator: args.curator,
      })
      .catch(() => undefined)
    return { shelf_item_id: shelfItemId, status: 'pending' as const }
  },
})

// ---------------------------------------------------------------------------
// request_human_shelf_placement
// ---------------------------------------------------------------------------

const RequestHumanPlacementArgsSchema = z.object({
  type: ShelfItemTypeSchema,
  body: z.string().min(1),
  source: ShelfItemSourceSchema,
  priority: ShelfItemPrioritySchema.default('normal'),
  /** Embassy's reasoning for needing this placement, surfaced in the Inbox card. */
  reasoning: z.string().min(1).max(2000),
})

export const requestHumanShelfPlacement = defineTool({
  name: 'shelf_request_human_placement',
  description:
    "Request operator approval to place a sensitive item on the shelf. Writes a pending-approval record + emits an Inbox notification with an approval_token. Only path for items the embassy would otherwise mark sensitivity: 'private'.",
  idempotency: 'destructive',
  argsSchema: RequestHumanPlacementArgsSchema,
  execute: async (args, ctx) => {
    const conduit = await lookupConduit(ctx.home, ctx.callingAgent)
    if (conduit === null) rejectNotAnEmbassy('shelf_request_human_placement')
    const token = newApprovalToken()
    const now = new Date()
    // Emit FIRST so the notification_id is captured into the approval record.
    const audit = new ConnectorAuditEmitter({ home: ctx.home })
    const reasoningExcerpt = args.reasoning.slice(0, 200)
    // The audit emit returns void; the notification's id is generated
    // inside emitNotification. We synthesize a fresh notification_id
    // for the approval record so we can correlate without parsing the
    // emit return. The notification body carries the token itself, so
    // the operator never needs to navigate by notification_id.
    const notificationId = `notif_${token.slice('appr_'.length)}`
    const approval: PendingApproval = {
      schema_version: 1,
      approval_token: token,
      embassy_agent: ctx.callingAgent,
      client_id: conduit.client_id,
      proposed: {
        type: args.type,
        source: args.source,
        target_model: conduit.external_model,
        priority: args.priority,
        body: args.body,
        reasoning: args.reasoning,
      },
      notification_id: notificationId,
      created_at: now.toISOString(),
    }
    await saveApproval(ctx.home, approval)
    await audit
      .emitEmbassyShelfHumanApprovalRequested({
        embassyAgent: ctx.callingAgent,
        approvalToken: token,
        itemType: args.type,
        priority: args.priority,
        reasoningExcerpt,
      })
      .catch(() => undefined)
    return {
      approval_token: token,
      status: 'awaiting_human_approval' as const,
    }
  },
})

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const shelfTools: ToolDefinition[] = [
  placeOnShelf,
  resolveShelfItem,
  reopenShelfItem,
  reprioritizeShelfItem,
  removeFromShelf,
  listMyShelf,
  readShelfItemTool,
  curateFromInbox,
  requestHumanShelfPlacement,
]

export const SHELF_TOOL_NAMES = shelfTools.map((t) => t.name) as readonly string[]
