/**
 * MCP connector server (PR 1a substrate).
 *
 * Constructs an `@modelcontextprotocol/sdk` `McpServer` instance with
 * a single zero-effect `liveness` tool. The real Phase 1 tools
 * (contribute_to_thread, propose_work_package, get_fleet_context)
 * land in subsequent PRs after Grok's code review on this substrate.
 *
 * Supply-chain note (Grok review, 2026-05-22): we mount
 * StreamableHTTPServerTransport from `@modelcontextprotocol/sdk`
 * directly. Pin updates and re-review the SDK's security posture on
 * each version bump.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

export interface ConnectorMcpServerHandle {
  readonly mcpServer: McpServer
  readonly transport: StreamableHTTPServerTransport
  close(): Promise<void>
}

const SERVER_INFO = {
  name: '2200-mcp-connector',
  version: '0.1.0',
}

const SERVER_OPTIONS = {
  // Brief description shown to MCP clients on initialize.
  instructions:
    "2200's fleet-facing MCP connector. Phase 1 exposes a small, read-and-ingest-shaped surface: research contributions flow into the fleet, work proposals arrive inert pending human approval. No execution crosses this surface without explicit operator approval.",
}

/**
 * Construct the connector McpServer instance with the PR 1a liveness
 * probe registered. The transport is created in stateful mode so each
 * MCP session gets a server-issued session ID; the bearer at the HTTP
 * layer is independent of the session ID.
 */
export async function createConnectorMcpServer(): Promise<ConnectorMcpServerHandle> {
  const mcpServer = new McpServer(SERVER_INFO, SERVER_OPTIONS)

  mcpServer.registerTool(
    'liveness',
    {
      title: 'liveness',
      description:
        'Proof-of-life probe. Returns "ok" plus the server timestamp. Phase 1 substrate only; replaced by the real tool surface in subsequent PRs.',
      inputSchema: {},
      outputSchema: {
        status: z.literal('ok'),
        server_time: z.string(),
      },
    },
    (_args, _extra) => {
      const serverTime = new Date().toISOString()
      const payload = { status: 'ok' as const, server_time: serverTime }
      return {
        structuredContent: payload,
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
      }
    },
  )

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  })

  // The SDK transport's TS surface declares mandatory `onclose`/`onerror`
  // setters after connection, but our exactOptionalPropertyTypes-strict
  // tsconfig sees the Transport interface's pre-connect optionality and
  // refuses the call. Mirror the cast pattern used in
  // runtime/mcp/http-transport.ts (client side) on the server side here.
  await mcpServer.connect(transport as unknown as Parameters<typeof mcpServer.connect>[0])

  return {
    mcpServer,
    transport,
    async close(): Promise<void> {
      await mcpServer.close().catch(() => undefined)
      await transport.close().catch(() => undefined)
    },
  }
}
