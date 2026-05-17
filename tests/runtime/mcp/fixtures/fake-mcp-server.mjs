#!/usr/bin/env node
/**
 * Fake stdio MCP server for tests of `launchStdioMcpServer`.
 *
 * Exposes:
 *   - `echo`: returns a text content block with the provided message.
 *   - `fail`: returns an MCP error response (`isError: true`).
 *   - `read_env`: reads a process env var name passed in args and
 *     returns its value, used to confirm env propagation through the
 *     transport.
 *
 * Implementation uses the @modelcontextprotocol/sdk server API. Kept
 * intentionally minimal: just the surface our transport tests assert.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'fake-mcp-server', version: '0.0.1' })

server.registerTool(
  'echo',
  {
    description: 'Echo a message back as text content.',
    inputSchema: { message: z.string() },
  },
  async ({ message }) => ({
    content: [{ type: 'text', text: `echo: ${message}` }],
  }),
)

server.registerTool(
  'fail',
  {
    description: 'Return an MCP error response.',
    inputSchema: { reason: z.string() },
  },
  async ({ reason }) => ({
    content: [{ type: 'text', text: `failure: ${reason}` }],
    isError: true,
  }),
)

server.registerTool(
  'read_env',
  {
    description: 'Read an env var by name and return its value.',
    inputSchema: { name: z.string() },
  },
  async ({ name }) => ({
    content: [{ type: 'text', text: process.env[name] ?? '<unset>' }],
  }),
)

const transport = new StdioServerTransport()
await server.connect(transport)
