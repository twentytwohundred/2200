/**
 * Per-Agent MCP server registry.
 *
 * Each Agent process gets one registry containing the baseline servers
 * (fs, shell, web, brain, time) plus any user-registered servers from
 * Identity. The registry is the single dispatch point: callers ask
 * `registry.find('fs_read')` and get back a `ToolDefinition` they can
 * pass to the dispatcher. Tool resolution is by exact dotted name.
 */
import type { McpServer } from './server.js'
import type { ToolDefinition } from './tool.js'

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()
  private readonly servers: McpServer[] = []

  /** Register an MCP server's tools. Throws on duplicate tool names. */
  register(server: McpServer): void {
    for (const [name, tool] of server.tools) {
      if (this.tools.has(name)) {
        throw new Error(`duplicate tool name across servers: ${name}`)
      }
      this.tools.set(name, tool)
    }
    this.servers.push(server)
  }

  /** Look up a tool by exact dotted name. */
  find(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  /** All tool names, sorted. */
  toolNames(): string[] {
    return Array.from(this.tools.keys()).sort()
  }

  /** All registered servers, in registration order. */
  serverList(): readonly McpServer[] {
    return this.servers
  }

  /** All registered tools, sorted by name. Used to enumerate the tool surface for native tool-use specs. */
  allTools(): { name: string; tool: ToolDefinition }[] {
    const out: { name: string; tool: ToolDefinition }[] = []
    for (const name of this.toolNames()) {
      const tool = this.tools.get(name)
      if (tool) out.push({ name, tool })
    }
    return out
  }
}
