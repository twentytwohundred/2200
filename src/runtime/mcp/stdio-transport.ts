/**
 * Stdio MCP transport for external user-registered MCP servers
 * (Epic 9 Phase A PR B).
 *
 * Wraps `@modelcontextprotocol/sdk`'s `Client` + `StdioClientTransport`
 * with a 2200-shaped facade: spawn a child process declared in the
 * Agent's Identity (`mcp_servers[]` block, Epic 9 PR A), discover the
 * tools the server exposes, and surface each tool as a 2200
 * `ToolDefinition` so the existing `ToolRegistry` and dispatcher can
 * route calls without further special-casing.
 *
 * The transport is stateless across reconnects: a `close()` followed by
 * a fresh `spawnStdioMcpServer()` is the canonical way to "restart"
 * (the supervisor's restart manager, PR C, owns the backoff + crash
 * policy locked in the Phase A spec).
 *
 * Per the integrate-over-build standing rule, JSON-RPC framing,
 * request/response correlation, and the `initialize` handshake all
 * live in the SDK; this module's job is the 2200-side adaptation
 * (namespace prefix, ToolDefinition shape, env/SecretRef resolution
 * is the supervisor's responsibility, not this module's).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'
import type { McpServer } from './server.js'
import { defineTool, type ToolContext, type ToolDefinition } from './tool.js'

/**
 * Permissive args schema for external MCP tools. The MCP server
 * publishes its own JSON Schema for each tool (`inputSchema`); the
 * server validates incoming args at call time. 2200's dispatcher just
 * passes them through unchanged.
 *
 * Using a permissive schema here is intentional: converting MCP's
 * JSON Schema to a precise Zod schema at runtime is a non-trivial
 * dependency (json-schema-to-zod or similar). Phase A skips that
 * conversion; the MCP server is the source of validation truth, and a
 * malformed args object surfaces as the MCP server's error rather
 * than a Zod error. Phase C adds optional client-side validation.
 */
const PERMISSIVE_ARGS_SCHEMA = z.record(z.string(), z.unknown())

/**
 * The 2200-side handle for a running stdio MCP server. The supervisor
 * holds one of these per declared `mcp_servers[]` entry per Agent
 * process.
 */
export interface StdioMcpServerHandle extends McpServer {
  /** Close the connection and terminate the child process. Idempotent. */
  close(): Promise<void>
  /** Direct access to the underlying SDK client (escape hatch for tests). */
  readonly client: Client
}

export interface SpawnStdioMcpArgs {
  /**
   * Identity-declared server name. Used as the dotted prefix on every
   * tool the server exposes ... if `name: github` and the server lists
   * a tool called `list_issues`, the registered tool name is
   * `github.list_issues`.
   */
  name: string
  /** Executable to spawn. */
  command: string
  /** Arguments to pass to the executable. */
  args: string[]
  /**
   * Already-resolved environment variables. The supervisor resolves
   * each Identity SecretRef to its literal value before calling
   * `spawnStdioMcpServer`; the literal value never appears in this
   * module's logs.
   */
  env: Record<string, string>
  /**
   * Optional override for the SDK Client constructor's `name` / `version`
   * (the values the server sees in the `initialize` handshake). Defaults
   * are sensible for production; tests inject specific values.
   */
  clientInfo?: { name: string; version: string }
  /**
   * Optional working directory for the spawned process. Defaults to
   * the supervisor's working directory.
   */
  cwd?: string
}

const DEFAULT_CLIENT_INFO = {
  name: '2200',
  version: '0.0.0',
}

/**
 * Spawn a stdio MCP server, run the initialize handshake, list its
 * tools, and return a 2200 handle with each tool wrapped as a
 * `ToolDefinition` ready for the registry.
 *
 * Throws on:
 *   - spawn failure (executable not found, permission denied)
 *   - initialize handshake failure (server crash, protocol error)
 *   - tools/list failure
 *
 * The caller is responsible for `close()` on the returned handle when
 * shutting down the Agent process (or restarting the server). Failure
 * to close leaks the child process.
 */
export async function spawnStdioMcpServer(args: SpawnStdioMcpArgs): Promise<StdioMcpServerHandle> {
  const transport = new StdioClientTransport({
    command: args.command,
    args: args.args,
    env: args.env,
    ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
  })

  const client = new Client(args.clientInfo ?? DEFAULT_CLIENT_INFO)

  try {
    await client.connect(transport)
  } catch (err) {
    // Best effort: kill the child if connect partially succeeded.
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
    const namespacedName = `${args.name}.${tool.name}`
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
  /** The tool name as the MCP server reports it (without our namespace prefix). */
  rawName: string
  description: string
  client: Client
}

function makeExternalToolDefinition(args: MakeExternalToolArgs): ToolDefinition {
  return defineTool({
    name: args.namespacedName,
    description: args.description,
    // External tools are conservatively classified as destructive: they
    // typically have real-world side effects (sending an email,
    // creating an issue, transferring funds). The dispatcher's
    // idempotency-compatible perm check then gates appropriately.
    // Future: per-tool overrides via the Identity's mcp_servers entry,
    // or hints from the MCP description.
    idempotency: 'destructive',
    argsSchema: PERMISSIVE_ARGS_SCHEMA,
    execute: async (toolArgs: unknown, _ctx: ToolContext): Promise<unknown> => {
      const result = await args.client.callTool({
        name: args.rawName,
        arguments: toolArgs as Record<string, unknown>,
      })
      // MCP's `callTool` returns { content: ContentBlock[], isError?: boolean }.
      // When isError is true, surface as a thrown error so the
      // dispatcher's existing error path applies. Otherwise return
      // the content array; consumers walk it (text blocks vs. resource
      // blocks vs. embedded resources) the same way they would a
      // baseline-tool response shape.
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

/**
 * Best-effort text extraction from an MCP tool response's content
 * array. Used only to enrich error messages; consumers that need
 * structured access walk the content array themselves.
 */
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
