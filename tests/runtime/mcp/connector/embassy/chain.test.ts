/**
 * Full embassy chain integration test (Phase 2 / PR-B6).
 *
 * Exercises the locked end-to-end shape:
 *
 *   1. Operator registers an embassy (atomic mint+provision).
 *   2. Grok calls `contribute_to_thread` → note lands in the
 *      embassy's brain (NOT shared).
 *   3. Embassy curates a shelf item via `shelf_place` (autonomous,
 *      sensitivity=none).
 *   4. Embassy requests human approval for a sensitive item via
 *      `shelf_request_human_placement`; operator approves; the
 *      item lands with `source_type: human_curated` and the
 *      operator as curator.
 *   5. Grok's next `get_fleet_context` call surfaces both items in
 *      `shelf_preview`. `self_reflected` detection works.
 *   6. Grok calls `shelf_pull` on a one-shot item → body returned,
 *      type-driven collection transition fires.
 *   7. Grok calls `shelf_pull` on a standing item → body returned,
 *      stays pending (re-surfaces on next preview).
 *
 * Validates BOTH the data flow (right notes in right places) AND
 * the audit-event flow (the full `connector.embassy_*` family
 * fires at the right moments).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Supervisor } from '../../../../../src/runtime/supervisor/supervisor.js'
import { ConnectorAuditEmitter } from '../../../../../src/runtime/mcp/connector/audit.js'
import { ToolRegistry } from '../../../../../src/runtime/mcp/registry.js'
import { createInProcessServer } from '../../../../../src/runtime/mcp/server.js'
import { ToolDispatcher } from '../../../../../src/runtime/tools/dispatcher.js'
import { agentPaths } from '../../../../../src/runtime/storage/layout.js'
import { shelfTools, SHELF_TOOL_NAMES } from '../../../../../src/runtime/tools/baseline/shelf.js'
import { writeAgentContribution } from '../../../../../src/runtime/mcp/connector/contributions.js'
import { listShelfItems } from '../../../../../src/runtime/mcp/connector/embassy/shelf/store.js'
import { buildShelfPreview } from '../../../../../src/runtime/mcp/connector/embassy/surfacing.js'
import { listNotifications } from '../../../../../src/runtime/notifications/reader.js'
import type { Listener } from '../../../../../src/runtime/control-plane/transport.js'

let home: string
let sup: Supervisor
const EMBASSY = 'grok-embassy'
const CLIENT_ID_HOLDER: { id: string } = { id: '' }

class NullListener implements Listener {
  connections(): AsyncIterable<never> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<never> {
        return {
          next: () => new Promise<IteratorResult<never>>(() => undefined),
        }
      },
    }
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-embassy-chain-'))
  sup = await Supervisor.create({ home })
  await sup.start({ home, listener: new NullListener() })
  // Wire the connector audit emitter so embassy lifecycle events
  // are captured (they're conditional on `this.connectorAudit`).
  ;(sup as unknown as { connectorAudit: ConnectorAuditEmitter }).connectorAudit =
    new ConnectorAuditEmitter({ home })
})

afterEach(async () => {
  await sup.shutdown()
  await rm(home, { recursive: true, force: true })
})

async function findEvent(kind: string): Promise<unknown> {
  const notifs = await listNotifications(home, {})
  for (const n of notifs) if (n.frontmatter.kind === kind) return n
  return null
}

async function findAllEvents(kind: string): Promise<unknown[]> {
  const notifs = await listNotifications(home, {})
  return notifs.filter((n) => n.frontmatter.kind === kind)
}

describe('full embassy chain (PR-B6)', () => {
  it('drives the contribute → curate → preview → pull → collect chain end-to-end', async () => {
    // ---- Step 1: register an embassy via the atomic primitive.
    const registered = await sup.registerEmbassyAndOAuthClient({
      displayName: 'Grok (chain test)',
      externalModel: 'grok',
      embassyAgent: EMBASSY,
      mode: 'dedicated',
      registeredBy: 'test',
      model: { tier: 'frontier', provider: 'xai', model_id: 'grok-4' },
    })
    CLIENT_ID_HOLDER.id = registered.clientId
    expect(registered.conduit.embassy_agent).toBe(EMBASSY)
    expect(registered.agentCreated).toBe(true)

    // Lifecycle audit fired.
    expect(await findEvent('connector.embassy_registered')).not.toBeNull()
    expect(await findEvent('connector.oauth_client_registered')).not.toBeNull()

    // ---- Step 2: Grok contributes (simulated by calling the
    // contribution writer directly; the MCP-tool path is the same
    // function with embassy routing).
    const contribution = await writeAgentContribution({
      home,
      agentName: EMBASSY,
      embassyAgent: EMBASSY,
      payload: {
        research_findings: 'I found something interesting about distributed consensus.',
        reasoning: 'Looking at recent papers, there are three key insights worth sharing.',
        sources: [],
        open_questions: [],
      },
    })
    // Contribution landed in embassy brain (NOT shared), tagged.
    expect(contribution.path).toContain(`/agents/${EMBASSY}/brain/`)

    // ---- Step 3: embassy curates a shelf item autonomously.
    const dispatcher = (() => {
      const reg = new ToolRegistry()
      reg.register(createInProcessServer('shelf', shelfTools))
      return new ToolDispatcher({
        registry: reg,
        allowedToolNames: new Set(SHELF_TOOL_NAMES),
        home,
        callingAgent: EMBASSY,
        brainDir: agentPaths(home, EMBASSY).brain,
        projectDir: agentPaths(home, EMBASSY).project,
      })
    })()
    async function dispatch<T = unknown>(tool: string, args: Record<string, unknown>): Promise<T> {
      const result = await dispatcher.dispatch({
        tool,
        args,
        taskId: 'task_chain',
        taskIdempotency: 'destructive',
        model: 'anthropic/claude-opus-4-7',
        predictedOutcome: '',
        reason: '',
      })
      return result.output as T
    }
    const placed = await dispatch<{ shelf_item_id: string }>('shelf_place', {
      type: 'question',
      body: 'What was the user trying to do with the distributed-consensus research?',
      source: {
        origin: 'contribution',
        reference: contribution.slug,
        curator: EMBASSY,
        client_id: registered.clientId,
        timestamp: new Date().toISOString(),
      },
      priority: 'high',
    })
    expect(placed.shelf_item_id).toMatch(/^shelf_/)
    // _item_placed event fired (passive).
    expect(await findEvent('connector.embassy_shelf_item_placed')).not.toBeNull()

    // Place a STANDING item too so we can verify it stays pending after pull.
    const standing = await dispatch<{ shelf_item_id: string }>('shelf_place', {
      type: 'context',
      body: 'Doug prefers concise summaries over comprehensive analyses.',
      source: {
        origin: 'embassy_note',
        reference: null,
        curator: EMBASSY,
        client_id: registered.clientId,
        timestamp: new Date().toISOString(),
      },
      priority: 'normal',
    })

    // ---- Step 4: embassy requests human approval for a sensitive item.
    const requested = await dispatch<{ approval_token: string }>('shelf_request_human_placement', {
      type: 'context',
      body: 'Operator credential pattern observed in last contribution; sensitive.',
      source: {
        origin: 'direct',
        reference: null,
        curator: EMBASSY,
        client_id: registered.clientId,
        timestamp: new Date().toISOString(),
      },
      priority: 'high',
      reasoning: 'Contains a value that looks like a credential; needs operator review.',
    })
    expect(requested.approval_token).toMatch(/^appr_/)
    expect(await findEvent('connector.embassy_shelf_human_approval_requested')).not.toBeNull()
    // Shelf still has only the two autonomously placed items.
    expect((await listShelfItems(home, EMBASSY)).length).toBe(2)

    // Operator approves.
    const approved = await sup.approveShelfPlacement({
      approvalToken: requested.approval_token,
      operatorName: 'doug',
    })
    expect(approved.embassyAgent).toBe(EMBASSY)
    // Approval-resolved lifecycle event.
    const approvalEvent = await findEvent('connector.embassy_shelf_approval_resolved')
    expect(approvalEvent).not.toBeNull()
    // Three items on the shelf now.
    const items = await listShelfItems(home, EMBASSY)
    expect(items.length).toBe(3)
    const humanCurated = items.find((i) => i.frontmatter.source_type === 'human_curated')
    expect(humanCurated?.frontmatter.source.curator).toBe('doug')

    // ---- Step 5: build the shelf_preview as Grok would see it.
    const preview = await buildShelfPreview(home, EMBASSY, registered.clientId)
    expect(preview.items.length).toBeGreaterThanOrEqual(3)
    expect(preview.total_pending).toBe(3)
    // Self-reflected detection: the two autonomously placed items
    // carry client_id === registered.clientId; the human-curated
    // item carries the original source.client_id (the embassy set
    // it from its conduit context, same client_id).
    const allSelfReflected = preview.items.every((i) => i.self_reflected)
    expect(allSelfReflected).toBe(true)
    // First-prefix variation: at least one item has the
    // embassy_autonomous prefix and at least one has the
    // human_curated prefix.
    const prefixes = preview.items.map((i) => i.excerpt)
    expect(prefixes.some((p) => p.includes('the fleet flagged it'))).toBe(true)
    expect(prefixes.some((p) => p.includes('an operator curated it'))).toBe(true)

    // ---- Step 6: pull the one-shot question → transitions to collected.
    const oneShotId = placed.shelf_item_id
    const { applyCollectionTransition } =
      await import('../../../../../src/runtime/mcp/connector/embassy/shelf/store.js')
    const oneShotResult = await applyCollectionTransition(home, EMBASSY, oneShotId, new Date())
    expect(oneShotResult.transitioned).toBe(true)
    expect(oneShotResult.record.frontmatter.status).toBe('collected')

    // ---- Step 7: "pull" the standing context item → stays pending.
    const standingResult = await applyCollectionTransition(
      home,
      EMBASSY,
      standing.shelf_item_id,
      new Date(),
    )
    expect(standingResult.transitioned).toBe(false)
    expect(standingResult.record.frontmatter.status).toBe('pending')

    // ---- Final invariant: total_pending now reflects the one-shot
    // transition. After step 6 the one-shot is collected, so total
    // pending should be 2 (the original standing + the human-
    // curated context, which is also standing).
    const previewAfter = await buildShelfPreview(home, EMBASSY, registered.clientId)
    expect(previewAfter.total_pending).toBe(2)
    expect(previewAfter.standing_pending).toBe(2)
    expect(previewAfter.one_shot_pending).toBe(0)
  })

  it('retire fires the embassy_retired audit event', async () => {
    const registered = await sup.registerEmbassyAndOAuthClient({
      displayName: 'Grok (retire test)',
      externalModel: 'grok',
      embassyAgent: EMBASSY,
      mode: 'dedicated',
      registeredBy: 'test',
      model: { tier: 'frontier', provider: 'xai', model_id: 'grok-4' },
    })
    await sup.retireConduit(registered.clientId)
    expect(await findEvent('connector.embassy_retired')).not.toBeNull()
  })

  it('rejectShelfPlacement fires the rejected audit event without writing the shelf', async () => {
    const registered = await sup.registerEmbassyAndOAuthClient({
      displayName: 'Grok (reject test)',
      externalModel: 'grok',
      embassyAgent: EMBASSY,
      mode: 'dedicated',
      registeredBy: 'test',
      model: { tier: 'frontier', provider: 'xai', model_id: 'grok-4' },
    })
    const reg2 = new ToolRegistry()
    reg2.register(createInProcessServer('shelf', shelfTools))
    const dispatcher = new ToolDispatcher({
      registry: reg2,
      allowedToolNames: new Set(SHELF_TOOL_NAMES),
      home,
      callingAgent: EMBASSY,
      brainDir: agentPaths(home, EMBASSY).brain,
      projectDir: agentPaths(home, EMBASSY).project,
    })
    const requested = await dispatcher.dispatch({
      tool: 'shelf_request_human_placement',
      args: {
        type: 'context',
        body: 'sensitive context',
        source: {
          origin: 'direct',
          reference: null,
          curator: EMBASSY,
          client_id: registered.clientId,
          timestamp: new Date().toISOString(),
        },
        priority: 'normal',
        reasoning: 'reject me',
      },
      taskId: 'task_chain',
      taskIdempotency: 'destructive',
      model: 'anthropic/claude-opus-4-7',
      predictedOutcome: '',
      reason: '',
    })
    const token = (requested.output as { approval_token: string }).approval_token

    await sup.rejectShelfPlacement({ approvalToken: token })

    // Shelf still empty for the rejected item.
    expect(await listShelfItems(home, EMBASSY)).toHaveLength(0)
    // Rejected audit event fired.
    const events = await findAllEvents('connector.embassy_shelf_approval_resolved')
    expect(events.length).toBeGreaterThanOrEqual(1)
  })
})
