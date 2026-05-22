/**
 * End-to-end tests for the MCP connector listener.
 *
 * The listener binds an actual port (0 → OS-assigned), so the tests
 * speak real HTTP/JSON-RPC. We use the MCP SDK client + StreamableHTTP
 * client transport to verify the listener behaves correctly through
 * the whole stack: bearer accept/reject, MCP initialize handshake,
 * liveness probe response, and Inbox audit emission for both success
 * and failure paths.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ConnectorAuditEmitter } from '../../../../src/runtime/mcp/connector/audit.js'
import { mintBearerToken, saveBearer } from '../../../../src/runtime/mcp/connector/bearer-store.js'
import {
  startConnectorListener,
  type ConnectorListenerHandle,
} from '../../../../src/runtime/mcp/connector/listener.js'
import { homePaths } from '../../../../src/runtime/storage/layout.js'

let home: string
let handle: ConnectorListenerHandle | null = null
let token: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-connector-listener-'))
  token = mintBearerToken()
  await saveBearer(home, { token, createdAt: new Date().toISOString() })
})

afterEach(async () => {
  if (handle !== null) {
    await handle.close('test cleanup').catch(() => undefined)
    handle = null
  }
  // Audit emits are fire-and-forget on the request path
  // (`emitCallReceived(...).catch(...)` without await). Brief settle
  // before rm so an in-flight notification write doesn't lose the race.
  await new Promise((r) => setTimeout(r, 20))
  await rm(home, { recursive: true, force: true })
})

async function readEmittedNotifications(): Promise<string[]> {
  const dir = homePaths(home).stateNotifications
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  return Promise.all(entries.map((name) => readFile(join(dir, name), 'utf-8')))
}

function stubServerDeps(
  opts: {
    knownAgents?: string[]
    resolveThreadPrimaryAgent?: (slug: string) => Promise<string | null>
    proposeWorkPackage?: (args: {
      proposal: unknown
      primaryAgent: string
    }) => Promise<{ packageId: string; packageSlug: string; coordinationTaskId: string }>
  } = {},
): {
  snapshot: () => {
    schema_version: 1
    home: string
    state_dir: string
    agents: Record<string, never>
    pubs: Record<string, never>
  }
  knownAgents: () => Promise<Set<string>>
  resolveThreadPrimaryAgent: (slug: string) => Promise<string | null>
  proposeWorkPackage: (args: {
    proposal: unknown
    primaryAgent: string
  }) => Promise<{ packageId: string; packageSlug: string; coordinationTaskId: string }>
} {
  return {
    snapshot: () => ({
      schema_version: 1 as const,
      home,
      state_dir: home + '/state',
      agents: {},
      pubs: {},
    }),
    knownAgents: () => Promise.resolve(new Set(opts.knownAgents ?? [])),
    resolveThreadPrimaryAgent: opts.resolveThreadPrimaryAgent ?? (() => Promise.resolve(null)),
    proposeWorkPackage:
      opts.proposeWorkPackage ??
      (() =>
        Promise.resolve({
          packageId: 'pkg_stubbedstubbedstubbed',
          packageSlug: 'work-package-pkg_stubbedstubbedstubbed',
          coordinationTaskId: 'task_stub',
        })),
  }
}

async function newClient(authToken: string, port: number): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${String(port)}/mcp`),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${authToken}` },
      },
    },
  )
  const client = new Client({ name: '2200-test-client', version: '0.0.0' })
  // Cast required for exactOptionalPropertyTypes-strict tsconfig.
  await client.connect(transport as unknown as Parameters<Client['connect']>[0])
  return client
}

describe('MCP connector listener', () => {
  it('refuses to start when the vault has no bearer', async () => {
    const home2 = await mkdtemp(join(tmpdir(), '2200-connector-listener-empty-'))
    try {
      const audit = new ConnectorAuditEmitter({ home: home2 })
      await expect(
        startConnectorListener({ home: home2, port: 0, audit, serverDeps: stubServerDeps() }),
      ).rejects.toThrow(/no bearer token in vault/)
    } finally {
      await rm(home2, { recursive: true, force: true })
    }
  })

  it('lists the liveness tool over the MCP transport with the valid bearer', async () => {
    const audit = new ConnectorAuditEmitter({ home })
    handle = await startConnectorListener({
      home,
      port: 0,
      host: '127.0.0.1',
      audit,
      serverDeps: stubServerDeps(),
    })

    const client = await newClient(token, handle.port)
    const tools = await client.listTools()
    expect(tools.tools.map((t) => t.name)).toContain('liveness')
    await client.close()
  })

  it('liveness probe returns ok + a server timestamp', async () => {
    const audit = new ConnectorAuditEmitter({ home })
    handle = await startConnectorListener({
      home,
      port: 0,
      host: '127.0.0.1',
      audit,
      serverDeps: stubServerDeps(),
    })

    const client = await newClient(token, handle.port)
    const result = await client.callTool({ name: 'liveness', arguments: {} })
    const text = textFromContent(result.content)
    expect(text).not.toBeNull()
    const parsed = JSON.parse(text ?? '{}') as { status: string; server_time: string }
    expect(parsed.status).toBe('ok')
    expect(parsed.server_time).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    await client.close()
  })

  it('rejects a request with no Authorization header (401) and emits an auth_rejected audit event', async () => {
    const audit = new ConnectorAuditEmitter({ home })
    handle = await startConnectorListener({
      home,
      port: 0,
      host: '127.0.0.1',
      audit,
      serverDeps: stubServerDeps(),
    })

    const resp = await fetch(`http://127.0.0.1:${String(handle.port)}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(resp.status).toBe(401)

    // Allow the audit emit to flush.
    await new Promise((r) => setTimeout(r, 50))
    const notes = await readEmittedNotifications()
    const rejectionNotes = notes.filter((n) => n.includes('kind: connector.auth_rejected'))
    expect(rejectionNotes).toHaveLength(1)
  })

  it('rejects a request with a wrong bearer (401) without distinguishing the failure reason in the response', async () => {
    const audit = new ConnectorAuditEmitter({ home })
    handle = await startConnectorListener({
      home,
      port: 0,
      host: '127.0.0.1',
      audit,
      serverDeps: stubServerDeps(),
    })

    const resp = await fetch(`http://127.0.0.1:${String(handle.port)}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mintBearerToken()}`, // wrong but well-formed
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(resp.status).toBe(401)
    const body = (await resp.json()) as { error?: string }
    // Uniform "unauthorized" — body must not hint at length vs prefix vs value.
    expect(body.error).toBe('unauthorized')
  })

  it('emits a call_received audit event with method and tool_name BEFORE the transport handoff', async () => {
    // Pre-emit timing: the audit fires at request receipt, not after
    // SSE close. The Grok review (2026-05-22) called out the old
    // post-handleRequest timing as deferred-by-SSE; this asserts the
    // new semantics.
    const audit = new ConnectorAuditEmitter({ home })
    handle = await startConnectorListener({
      home,
      port: 0,
      host: '127.0.0.1',
      audit,
      serverDeps: stubServerDeps(),
    })

    const client = await newClient(token, handle.port)
    await client.callTool({ name: 'liveness', arguments: {} })
    await client.close()

    // Pre-emit means the notification lands during the call. A small
    // grace flush for file-write completion.
    await new Promise((r) => setTimeout(r, 50))
    const notes = await readEmittedNotifications()
    const callNotes = notes.filter((n) => n.includes('kind: connector.call_received'))
    const toolsCall = callNotes.find((n) => n.includes('method: tools/call'))
    expect(toolsCall).toBeDefined()
    expect(toolsCall).toContain('tool_name: liveness')
  })

  it('close() returns promptly even with an active client connection (regenerate-bounce semantics)', async () => {
    const audit = new ConnectorAuditEmitter({ home })
    handle = await startConnectorListener({
      home,
      port: 0,
      host: '127.0.0.1',
      audit,
      serverDeps: stubServerDeps(),
    })

    const client = await newClient(token, handle.port)
    await client.listTools() // keeps an SSE stream warm

    const startMs = Date.now()
    await handle.close('test_bounce')
    const elapsedMs = Date.now() - startMs
    handle = null
    // Without the (mcp.close → fastify.close) order + forceCloseConnections
    // option, an active SSE stream from listTools would hold close() open
    // until the client side dropped. 2 seconds is plenty of headroom; in
    // practice the close completes in single-digit ms.
    expect(elapsedMs).toBeLessThan(2_000)
    await client.close().catch(() => undefined)
  })

  it('emits started + stopped lifecycle events around its lifetime', async () => {
    const audit = new ConnectorAuditEmitter({ home })
    handle = await startConnectorListener({
      home,
      port: 0,
      host: '127.0.0.1',
      audit,
      serverDeps: stubServerDeps(),
    })
    await handle.close('test')
    handle = null
    const notes = await readEmittedNotifications()
    const stateNotes = notes.filter((n) => n.includes('kind: connector.listener_state_changed'))
    expect(stateNotes.some((n) => n.includes('listener_state: started'))).toBe(true)
    expect(stateNotes.some((n) => n.includes('listener_state: stopped'))).toBe(true)
  })

  it('lists the locked Phase 1 tool surface (liveness + contribute_to_thread + get_fleet_context + get_research_brief)', async () => {
    const audit = new ConnectorAuditEmitter({ home })
    handle = await startConnectorListener({
      home,
      port: 0,
      host: '127.0.0.1',
      audit,
      serverDeps: stubServerDeps(),
    })
    const client = await newClient(token, handle.port)
    const tools = await client.listTools()
    const names = tools.tools.map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'liveness',
        'contribute_to_thread',
        'get_fleet_context',
        'get_research_brief',
      ]),
    )
    await client.close()
  })

  it('get_research_brief returns null brief when no brief has been synthesized', async () => {
    const audit = new ConnectorAuditEmitter({ home })
    handle = await startConnectorListener({
      home,
      port: 0,
      host: '127.0.0.1',
      audit,
      serverDeps: stubServerDeps(),
    })
    const client = await newClient(token, handle.port)
    const result = await client.callTool({
      name: 'get_research_brief',
      arguments: { thread_slug: 'no-such-thread' },
    })
    const text = textFromContent(result.content)
    expect(text).not.toBeNull()
    const parsed = JSON.parse(text ?? '{}') as { thread_slug: string; brief: unknown }
    expect(parsed.thread_slug).toBe('no-such-thread')
    expect(parsed.brief).toBeNull()
    await client.close()
  })

  it('lists propose_work_package alongside the other Phase 1 tools', async () => {
    const audit = new ConnectorAuditEmitter({ home })
    handle = await startConnectorListener({
      home,
      port: 0,
      host: '127.0.0.1',
      audit,
      serverDeps: stubServerDeps(),
    })
    const client = await newClient(token, handle.port)
    const tools = await client.listTools()
    expect(tools.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'liveness',
        'contribute_to_thread',
        'get_fleet_context',
        'get_research_brief',
        'propose_work_package',
      ]),
    )
    await client.close()
  })

  it('propose_work_package (agent target) returns queued_for_review with package/coordination ids', async () => {
    const audit = new ConnectorAuditEmitter({ home })
    let captured: { proposal: unknown; primaryAgent: string } | null = null
    handle = await startConnectorListener({
      home,
      port: 0,
      host: '127.0.0.1',
      audit,
      serverDeps: stubServerDeps({
        knownAgents: ['hobby'],
        proposeWorkPackage: (args) => {
          captured = args
          return Promise.resolve({
            packageId: 'pkg_abcdef0123456789abcdef01',
            packageSlug: 'work-package-pkg_abcdef0123456789abcdef01',
            coordinationTaskId: 'task_coordination_xyz',
          })
        },
      }),
    })
    const client = await newClient(token, handle.port)
    const result = await client.callTool({
      name: 'propose_work_package',
      arguments: {
        title: 'Test proposal',
        summary: 'A small test.',
        proposed_steps: ['step 1', 'step 2'],
        target: { agent: 'hobby' },
      },
    })
    const text = textFromContent(result.content)
    expect(text).not.toBeNull()
    const out = JSON.parse(text ?? '{}') as {
      status: string
      package_id: string
      coordination_task_id: string
    }
    expect(out.status).toBe('queued_for_review')
    expect(out.package_id).toBe('pkg_abcdef0123456789abcdef01')
    expect(out.coordination_task_id).toBe('task_coordination_xyz')
    expect(captured).not.toBeNull()
    await client.close()
  })

  it('propose_work_package (thread target) is rejected when the thread has no primary agent', async () => {
    const audit = new ConnectorAuditEmitter({ home })
    handle = await startConnectorListener({
      home,
      port: 0,
      host: '127.0.0.1',
      audit,
      serverDeps: stubServerDeps({
        resolveThreadPrimaryAgent: () => Promise.resolve(null),
      }),
    })
    const client = await newClient(token, handle.port)
    const result = await client.callTool({
      name: 'propose_work_package',
      arguments: {
        title: 'Test proposal',
        summary: 'A small test.',
        proposed_steps: ['step 1'],
        target: { thread: 'orphan-thread' },
      },
    })
    expect(result.isError).toBe(true)
    expect(textFromContent(result.content)).toMatch(/no primary agent/)
    await client.close()
  })

  it('contribute_to_thread (thread target) creates a shared-brain research thread + emits contribution_received', async () => {
    const audit = new ConnectorAuditEmitter({ home })
    handle = await startConnectorListener({
      home,
      port: 0,
      host: '127.0.0.1',
      audit,
      serverDeps: stubServerDeps(),
    })
    const client = await newClient(token, handle.port)
    const result = await client.callTool({
      name: 'contribute_to_thread',
      arguments: {
        target: { thread: 'Tesla Grok MCP spike' },
        research_findings: 'Custom connectors are reachable from the Voice Agent API.',
        reasoning: 'Verified against xAI docs and the connector consumer flow.',
        sources: [{ url: 'https://docs.x.ai/grok/connectors', title: 'xAI connectors docs' }],
        open_questions: ['Does the in-car Tesla surface honor allowed_tools?'],
        proposed_direction: 'Ship the connector as-is and verify on Doug-s hardware.',
      },
    })
    const text = textFromContent(result.content)
    expect(text).not.toBeNull()
    const out = JSON.parse(text ?? '{}') as {
      status: string
      target_kind: string
      target_name: string
      contribution_slug: string
      contribution_path: string
      created_target: boolean
    }
    expect(out.status).toBe('accepted')
    expect(out.target_kind).toBe('thread')
    expect(out.target_name).toBe('tesla-grok-mcp-spike')
    expect(out.contribution_slug).toBe('research-tesla-grok-mcp-spike')
    expect(out.created_target).toBe(true)
    await client.close()

    // Allow the audit emit to flush.
    await new Promise((r) => setTimeout(r, 50))
    const notes = await readEmittedNotifications()
    const contribNote = notes.find((n) => n.includes('kind: connector.contribution_received'))
    expect(contribNote).toBeDefined()
    expect(contribNote).toContain('target_kind: thread')
    expect(contribNote).toContain('target_name: tesla-grok-mcp-spike')
  })

  it('contribute_to_thread (agent target) is rejected when the agent is unknown', async () => {
    const audit = new ConnectorAuditEmitter({ home })
    handle = await startConnectorListener({
      home,
      port: 0,
      host: '127.0.0.1',
      audit,
      // No agents in the snapshot; targeting one must fail with a clear error.
      serverDeps: stubServerDeps({ knownAgents: [] }),
    })
    const client = await newClient(token, handle.port)
    // The MCP SDK surfaces tool-handler errors as result.isError === true
    // with the error message in the content blocks, rather than throwing.
    const result = await client.callTool({
      name: 'contribute_to_thread',
      arguments: {
        target: { agent: 'nonexistent' },
        research_findings: 'x',
        reasoning: 'y',
        sources: [],
        open_questions: [],
      },
    })
    expect(result.isError).toBe(true)
    expect(textFromContent(result.content)).toMatch(/unknown agent/)
    await client.close()
  })

  it('handles repeated `initialize` calls without `Server already initialized` (stateless transport)', async () => {
    // Regression test for the 2026-05-23 empirical smoke against the real
    // grok.com/connectors flow: grok-connectors-manager/0.1.0 sends a
    // fresh `initialize` payload for each tool invocation rather than
    // reusing an mcp-session-id. Stateful mode rejected the re-init
    // with `-32600 Invalid Request: Server already initialized`,
    // surfacing as "error decoding response body" on Grok's side.
    // Stateless transport handles each request independently.
    const audit = new ConnectorAuditEmitter({ home })
    handle = await startConnectorListener({
      home,
      port: 0,
      host: '127.0.0.1',
      audit,
      serverDeps: stubServerDeps(),
    })
    const initPayload = {
      jsonrpc: '2.0' as const,
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'regression-test-client', version: '0.0.0' },
      },
    }
    // Two back-to-back initialize calls from "different sessions"
    // (no mcp-session-id header on either). Both must succeed.
    for (let i = 0; i < 2; i++) {
      const resp = await fetch(`http://127.0.0.1:${String(handle.port)}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ ...initPayload, id: i }),
      })
      expect(resp.status).toBe(200)
      // Stateless mode characteristic: NO mcp-session-id header on responses.
      expect(resp.headers.get('mcp-session-id')).toBeNull()
    }
  })

  it('get_fleet_context returns a schema_version=1 packet shape', async () => {
    const audit = new ConnectorAuditEmitter({ home })
    handle = await startConnectorListener({
      home,
      port: 0,
      host: '127.0.0.1',
      audit,
      serverDeps: stubServerDeps(),
    })
    const client = await newClient(token, handle.port)
    const result = await client.callTool({ name: 'get_fleet_context', arguments: {} })
    const text = textFromContent(result.content)
    expect(text).not.toBeNull()
    const packet = JSON.parse(text ?? '{}') as {
      schema_version: number
      agents: unknown[]
      threads: unknown[]
      recent_activity: unknown[]
    }
    expect(packet.schema_version).toBe(1)
    expect(Array.isArray(packet.agents)).toBe(true)
    expect(Array.isArray(packet.threads)).toBe(true)
    expect(Array.isArray(packet.recent_activity)).toBe(true)
    await client.close()
  })
})

function textFromContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const fields = block as Record<string, unknown>
    if (fields['type'] !== 'text') continue
    const text = fields['text']
    if (typeof text === 'string') return text
  }
  return null
}
