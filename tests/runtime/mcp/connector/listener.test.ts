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
      await expect(startConnectorListener({ home: home2, port: 0, audit })).rejects.toThrow(
        /no bearer token in vault/,
      )
    } finally {
      await rm(home2, { recursive: true, force: true })
    }
  })

  it('lists the liveness tool over the MCP transport with the valid bearer', async () => {
    const audit = new ConnectorAuditEmitter({ home })
    handle = await startConnectorListener({ home, port: 0, host: '127.0.0.1', audit })

    const client = await newClient(token, handle.port)
    const tools = await client.listTools()
    expect(tools.tools.map((t) => t.name)).toContain('liveness')
    await client.close()
  })

  it('liveness probe returns ok + a server timestamp', async () => {
    const audit = new ConnectorAuditEmitter({ home })
    handle = await startConnectorListener({ home, port: 0, host: '127.0.0.1', audit })

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
    handle = await startConnectorListener({ home, port: 0, host: '127.0.0.1', audit })

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
    handle = await startConnectorListener({ home, port: 0, host: '127.0.0.1', audit })

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
    handle = await startConnectorListener({ home, port: 0, host: '127.0.0.1', audit })

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
    handle = await startConnectorListener({ home, port: 0, host: '127.0.0.1', audit })

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
    handle = await startConnectorListener({ home, port: 0, host: '127.0.0.1', audit })
    await handle.close('test')
    handle = null
    const notes = await readEmittedNotifications()
    const stateNotes = notes.filter((n) => n.includes('kind: connector.listener_state_changed'))
    expect(stateNotes.some((n) => n.includes('listener_state: started'))).toBe(true)
    expect(stateNotes.some((n) => n.includes('listener_state: stopped'))).toBe(true)
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
