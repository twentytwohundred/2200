/**
 * Integration tests for the nine embassy-internal shelf tools.
 * Exercise the dispatcher / Zod / lookupConduit / sensitivity gate
 * end-to-end against real on-disk state.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolRegistry } from '../../../../../../src/runtime/mcp/registry.js'
import { createInProcessServer } from '../../../../../../src/runtime/mcp/server.js'
import { ToolDispatcher } from '../../../../../../src/runtime/tools/dispatcher.js'
import { initHome, initAgentDirs } from '../../../../../../src/runtime/storage/init.js'
import { agentPaths } from '../../../../../../src/runtime/storage/layout.js'
import { shelfTools, SHELF_TOOL_NAMES } from '../../../../../../src/runtime/tools/baseline/shelf.js'
import {
  buildConduitRecord,
  initEmbassyBrainDirs,
} from '../../../../../../src/runtime/mcp/connector/embassy/registration.js'
import { writeConduit } from '../../../../../../src/runtime/mcp/connector/embassy/conduits.js'
import {
  listShelfItems,
  readShelfItem,
} from '../../../../../../src/runtime/mcp/connector/embassy/shelf/store.js'
import { listApprovals } from '../../../../../../src/runtime/mcp/connector/embassy/shelf/approval-store.js'

let home: string
const embassy = 'grok-embassy'
const clientId = 'grok-aaa'

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-shelf-tools-'))
  await initHome(home)
  // Stand up the embassy agent with a minimal identity (no embassy
  // block needed for these tests — the conduit record is the source
  // of truth for lookupConduit).
  const sourcePath = join(home, 'src.identity.md')
  await writeFile(
    sourcePath,
    [
      '---',
      'schema_version: 5',
      `agent_name: ${embassy}`,
      'agent_role: "test embassy"',
      'model:',
      '  tier: frontier',
      '  provider: anthropic',
      '  model_id: claude-opus-4-7',
      'tools: []',
      'project_dir: /unused',
      'brain_dir: /unused',
      'created: 2026-05-26',
      '---',
      '',
      '# Identity',
    ].join('\n'),
  )
  await initAgentDirs(home, embassy, sourcePath)
  await initEmbassyBrainDirs(home, embassy)
  // Register a conduit so lookupConduit returns a match.
  await writeConduit(
    home,
    buildConduitRecord({
      clientId,
      externalModel: 'grok',
      embassyAgent: embassy,
      mode: 'dedicated',
      displayName: 'Grok (test)',
      registeredAt: '2026-05-26T10:00:00.000Z',
      registeredBy: 'cli',
    }),
  )
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  // Reset the rate limiter (process-level singleton from shelf.ts)
  // by triggering a 60-second time skip ... but easier: tests below
  // are bounded and don't approach the cap, so no reset needed.
})

function buildShelfDispatcher(): ToolDispatcher {
  const registry = new ToolRegistry()
  registry.register(createInProcessServer('shelf', shelfTools))
  return new ToolDispatcher({
    registry,
    allowedToolNames: new Set(SHELF_TOOL_NAMES),
    home,
    callingAgent: embassy,
    brainDir: agentPaths(home, embassy).brain,
    projectDir: agentPaths(home, embassy).project,
  })
}

async function call<T = unknown>(
  dispatcher: ToolDispatcher,
  tool: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await dispatcher.dispatch({
    tool,
    args,
    taskId: 'task_test',
    taskIdempotency: 'destructive',
    model: 'anthropic/claude-opus-4-7',
    predictedOutcome: '',
    reason: '',
  })
  return result.output as T
}

describe('shelf_place', () => {
  it('writes an item to the embassy shelf and returns shelf_item_id', async () => {
    const dispatcher = buildShelfDispatcher()
    const out = await call<{ shelf_item_id: string; status: string }>(dispatcher, 'shelf_place', {
      type: 'question',
      body: 'What is the meaning of life?',
      source: {
        origin: 'direct',
        reference: null,
        curator: embassy,
        client_id: clientId,
        timestamp: '2026-05-26T10:00:00.000Z',
      },
      priority: 'normal',
    })
    expect(out.shelf_item_id).toMatch(/^shelf_/)
    expect(out.status).toBe('pending')
    const items = await listShelfItems(home, embassy)
    expect(items).toHaveLength(1)
    expect(items[0]?.body).toBe('What is the meaning of life?')
  })

  it('throws not_an_embassy when the calling agent is not a registered embassy', async () => {
    // Replace the conduit with one for a DIFFERENT embassy agent.
    await writeConduit(
      home,
      buildConduitRecord({
        clientId: 'grok-other',
        externalModel: 'grok',
        embassyAgent: 'some-other-agent',
        mode: 'dedicated',
        displayName: 'Other',
        registeredAt: '2026-05-26T10:00:00.000Z',
        registeredBy: 'cli',
      }),
    )
    // Retire our embassy's conduit so lookupConduit returns null.
    const { markRetired } =
      await import('../../../../../../src/runtime/mcp/connector/embassy/conduits.js')
    await markRetired(home, clientId, new Date())
    const dispatcher = buildShelfDispatcher()
    await expect(
      call(dispatcher, 'shelf_place', {
        type: 'question',
        body: 'x',
        source: {
          origin: 'direct',
          reference: null,
          curator: embassy,
          client_id: clientId,
          timestamp: '2026-05-26T10:00:00.000Z',
        },
      }),
    ).rejects.toThrow(/not_an_embassy/)
  })
})

describe('sensitivity gate', () => {
  it('shelf_place rejects sensitivity=private at the Zod boundary', async () => {
    const dispatcher = buildShelfDispatcher()
    await expect(
      call(dispatcher, 'shelf_place', {
        type: 'question',
        body: 'sensitive',
        source: {
          origin: 'direct',
          reference: null,
          curator: embassy,
          client_id: clientId,
          timestamp: '2026-05-26T10:00:00.000Z',
        },
        sensitivity: 'private',
      }),
    ).rejects.toThrow() // schema rejects; either zod error or ToolArgsError
  })

  it('shelf_request_human_placement writes a pending approval', async () => {
    const dispatcher = buildShelfDispatcher()
    const out = await call<{ approval_token: string; status: string }>(
      dispatcher,
      'shelf_request_human_placement',
      {
        type: 'context',
        body: 'sensitive context',
        source: {
          origin: 'direct',
          reference: null,
          curator: embassy,
          client_id: clientId,
          timestamp: '2026-05-26T10:00:00.000Z',
        },
        reasoning: 'This contains operator credentials; requires human review.',
      },
    )
    expect(out.approval_token).toMatch(/^appr_/)
    expect(out.status).toBe('awaiting_human_approval')
    const pending = await listApprovals(home)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.embassy_agent).toBe(embassy)
    expect(pending[0]?.proposed.body).toBe('sensitive context')
    // CRITICAL: the actual shelf is still empty.
    expect(await listShelfItems(home, embassy)).toHaveLength(0)
  })
})

describe('shelf_resolve / shelf_reopen / shelf_reprioritize', () => {
  it('resolve transitions pending → collected', async () => {
    const dispatcher = buildShelfDispatcher()
    const placed = await call<{ shelf_item_id: string }>(dispatcher, 'shelf_place', {
      type: 'question',
      body: 'x',
      source: {
        origin: 'direct',
        reference: null,
        curator: embassy,
        client_id: clientId,
        timestamp: '2026-05-26T10:00:00.000Z',
      },
    })
    const resolved = await call<{ changed: boolean; status: string }>(dispatcher, 'shelf_resolve', {
      shelf_item_id: placed.shelf_item_id,
    })
    expect(resolved.changed).toBe(true)
    expect(resolved.status).toBe('collected')
    const rec = await readShelfItem(home, embassy, placed.shelf_item_id)
    expect(rec?.frontmatter.collected_at).not.toBeNull()
  })

  it('reopen transitions collected → pending', async () => {
    const dispatcher = buildShelfDispatcher()
    const placed = await call<{ shelf_item_id: string }>(dispatcher, 'shelf_place', {
      type: 'question',
      body: 'x',
      source: {
        origin: 'direct',
        reference: null,
        curator: embassy,
        client_id: clientId,
        timestamp: '2026-05-26T10:00:00.000Z',
      },
    })
    await call(dispatcher, 'shelf_resolve', { shelf_item_id: placed.shelf_item_id })
    const reopened = await call<{ changed: boolean; status: string }>(dispatcher, 'shelf_reopen', {
      shelf_item_id: placed.shelf_item_id,
    })
    expect(reopened.changed).toBe(true)
    expect(reopened.status).toBe('pending')
    const rec = await readShelfItem(home, embassy, placed.shelf_item_id)
    expect(rec?.frontmatter.collected_at).toBeNull()
  })

  it('reprioritize changes priority', async () => {
    const dispatcher = buildShelfDispatcher()
    const placed = await call<{ shelf_item_id: string }>(dispatcher, 'shelf_place', {
      type: 'question',
      body: 'x',
      source: {
        origin: 'direct',
        reference: null,
        curator: embassy,
        client_id: clientId,
        timestamp: '2026-05-26T10:00:00.000Z',
      },
      priority: 'normal',
    })
    await call(dispatcher, 'shelf_reprioritize', {
      shelf_item_id: placed.shelf_item_id,
      priority: 'high',
    })
    const rec = await readShelfItem(home, embassy, placed.shelf_item_id)
    expect(rec?.frontmatter.priority).toBe('high')
  })
})

describe('shelf_remove + shelf_list_mine + shelf_read', () => {
  it('list returns all items; read returns one by id; remove deletes', async () => {
    const dispatcher = buildShelfDispatcher()
    const placed = await call<{ shelf_item_id: string }>(dispatcher, 'shelf_place', {
      type: 'question',
      body: 'find me',
      source: {
        origin: 'direct',
        reference: null,
        curator: embassy,
        client_id: clientId,
        timestamp: '2026-05-26T10:00:00.000Z',
      },
    })
    const list = await call<{ items: { shelf_item_id: string }[] }>(
      dispatcher,
      'shelf_list_mine',
      {},
    )
    expect(list.items).toHaveLength(1)
    const read = await call<{ body: string }>(dispatcher, 'shelf_read', {
      shelf_item_id: placed.shelf_item_id,
    })
    expect(read.body).toBe('find me')
    await call(dispatcher, 'shelf_remove', { shelf_item_id: placed.shelf_item_id })
    expect(await listShelfItems(home, embassy)).toHaveLength(0)
  })
})

describe('shelf_curate_from_inbox', () => {
  it('writes a shelf item with source_type=human_curated and the operator as curator', async () => {
    const dispatcher = buildShelfDispatcher()
    const out = await call<{ shelf_item_id: string }>(dispatcher, 'shelf_curate_from_inbox', {
      notification_id: 'notif_abc',
      type: 'context',
      body: 'curated context',
      curator: 'operator',
    })
    const rec = await readShelfItem(home, embassy, out.shelf_item_id)
    expect(rec?.frontmatter.source_type).toBe('human_curated')
    expect(rec?.frontmatter.source.curator).toBe('operator')
    expect(rec?.frontmatter.source.origin).toBe('inbox')
    expect(rec?.frontmatter.source.reference).toBe('notif_abc')
  })
})
