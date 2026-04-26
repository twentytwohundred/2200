/**
 * MCP server abstraction.
 *
 * In-process v1: a server is a named bundle of tools the runtime loads
 * at boot. Each baseline tool category (fs, shell, web, brain, time)
 * is one server. The shape mirrors MCP wire protocol so a future PR
 * can add stdio / HTTP MCP transports for user-registered servers
 * without changing the dispatcher or tool consumers.
 */
import type { ToolDefinition } from './tool.js'

export interface McpServer {
  /** Server identity, e.g., "fs", "shell", "web", "brain", "time". */
  readonly name: string
  /** Tools this server exposes. Keys are dotted tool names ("fs.read"). */
  readonly tools: ReadonlyMap<string, ToolDefinition>
}

/**
 * Construct an in-process MCP server from a list of tool definitions.
 * The server's name is derived from the first dotted-prefix; all tools
 * MUST share the same prefix (enforced).
 */
export function createInProcessServer(name: string, tools: ToolDefinition[]): McpServer {
  const map = new Map<string, ToolDefinition>()
  for (const tool of tools) {
    if (!tool.name.startsWith(`${name}.`)) {
      throw new Error(
        `tool '${tool.name}' does not match server prefix '${name}.'; cannot register`,
      )
    }
    if (map.has(tool.name)) {
      throw new Error(`duplicate tool registration: ${tool.name}`)
    }
    map.set(tool.name, tool)
  }
  return { name, tools: map }
}
