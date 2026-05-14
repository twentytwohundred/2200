/**
 * HTTP MCP transport (Epic 9 Phase C-1).
 *
 * Wraps `@modelcontextprotocol/sdk`'s `Client` + `StreamableHTTPClientTransport`
 * with the same 2200 facade as the stdio transport: open a connection,
 * run `initialize`, list tools, and surface each as a 2200 `ToolDefinition`.
 *
 * Differences from stdio:
 *   - There is no child process. The transport owns an HTTP/SSE
 *     connection. `close()` closes that connection.
 *   - Auth is per-request: a Bearer token (resolved by the supervisor
 *     from a SecretRef) is set as `Authorization: Bearer <token>`. The
 *     SDK lets us pass static headers via `requestInit.headers`.
 *   - The SDK transport handles transient network errors and SSE
 *     reconnection internally. Our McpServerManager-style restart
 *     wrapper is NOT applied here at v1; long-term outages surface as
 *     tool-call failures (which Phase C-2 tool-health reflects).
 *
 * Phase C-1 ships the transport + Identity wiring; the per-tool
 * counters and dormant indicator land in Phase C-2.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import type { McpServer } from './server.js'
import { defineTool, type ToolContext, type ToolDefinition } from './tool.js'

const PERMISSIVE_ARGS_SCHEMA = z.record(z.string(), z.unknown())

export interface HttpMcpServerHandle extends McpServer {
  close(): Promise<void>
  readonly client: Client
}

export interface SpawnHttpMcpArgs {
  /** Identity-declared server name; dotted prefix on every tool. */
  name: string
  /** MCP HTTP endpoint URL. */
  url: string
  /** Optional bearer token (already resolved from any SecretRef). */
  bearerToken?: string
  /** Static headers to apply to every request. */
  extraHeaders?: Record<string, string>
  /** Optional SDK Client info override. */
  clientInfo?: { name: string; version: string }
  /** Inject fetch (testing). */
  fetchImpl?: typeof fetch
}

const DEFAULT_CLIENT_INFO = {
  name: '2200',
  version: '0.0.0',
}

export async function spawnHttpMcpServer(args: SpawnHttpMcpArgs): Promise<HttpMcpServerHandle> {
  const headers: Record<string, string> = { ...args.extraHeaders }
  if (args.bearerToken) {
    headers['Authorization'] = `Bearer ${args.bearerToken}`
  }

  const transport = new StreamableHTTPClientTransport(new URL(args.url), {
    requestInit: { headers },
    ...(args.fetchImpl ? { fetch: args.fetchImpl } : {}),
  })

  const client = new Client(args.clientInfo ?? DEFAULT_CLIENT_INFO)

  try {
    // The SDK transport's TS surface narrows sessionId to string after
    // connection, but our exactOptionalPropertyTypes-strict tsconfig
    // doesn't accept that narrowing pre-connect. Cast through unknown.
    await client.connect(transport as unknown as Parameters<Client['connect']>[0])
  } catch (err) {
    await transport.close().catch(() => undefined)
    throw err
  }

  let listResult
  try {
    listResult = await client.listTools()
  } catch (err) {
    await client.close().catch(() => undefined)
    throw err
  }

  const toolMap = new Map<string, ToolDefinition>()
  for (const tool of listResult.tools) {
    // Underscore separator; matches stdio transport. See the note there
    // for the full reasoning (OpenAI native function-calling regex
    // rejects dots; tool-grant expansion handles both wildcard forms).
    const namespacedName = `${args.name}_${tool.name}`
    toolMap.set(
      namespacedName,
      makeExternalToolDefinition({
        namespacedName,
        rawName: tool.name,
        description: tool.description ?? `External MCP tool ${namespacedName}`,
        client,
      }),
    )
  }

  return {
    name: args.name,
    tools: toolMap,
    client,
    async close(): Promise<void> {
      await client.close().catch(() => undefined)
    },
  }
}

interface MakeExternalToolArgs {
  namespacedName: string
  rawName: string
  description: string
  client: Client
}

function makeExternalToolDefinition(args: MakeExternalToolArgs): ToolDefinition {
  return defineTool({
    name: args.namespacedName,
    description: args.description,
    idempotency: 'destructive',
    argsSchema: PERMISSIVE_ARGS_SCHEMA,
    execute: async (toolArgs: unknown, _ctx: ToolContext): Promise<unknown> => {
      const result = await args.client.callTool({
        name: args.rawName,
        arguments: toolArgs as Record<string, unknown>,
      })
      if (result.isError === true) {
        const text = textFromContent(result.content)
        throw new Error(
          `MCP tool ${args.namespacedName} returned an error${text !== null ? `: ${text}` : ''}`,
        )
      }
      return result
    },
  })
}

function textFromContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const fields = block as Record<string, unknown>
    if (fields['type'] !== 'text') continue
    const text = fields['text']
    if (typeof text === 'string') parts.push(text)
  }
  return parts.length > 0 ? parts.join('\n') : null
}
