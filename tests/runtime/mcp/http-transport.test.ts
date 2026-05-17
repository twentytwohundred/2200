import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { launchHttpMcpServer } from '../../../src/runtime/mcp/http-transport.js'

interface RunningServer {
  server: Server
  url: string
  capturedAuth: { value: string | undefined }
  close: () => Promise<void>
}

async function startMcpServer(opts: { requireBearer?: string } = {}): Promise<RunningServer> {
  const captured: { value: string | undefined } = { value: undefined }
  const mcp = new McpServer({ name: 'test-server', version: '0.0.1' })
  mcp.registerTool(
    'echo',
    {
      title: 'Echo',
      description: 'Echoes back the provided message',
      inputSchema: { message: z.string() },
    },
    ({ message }) => ({ content: [{ type: 'text', text: `echo: ${message}` }] }),
  )

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  })
  await mcp.connect(transport as unknown as Parameters<typeof mcp.connect>[0])

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    captured.value = req.headers.authorization
    if (opts.requireBearer && req.headers.authorization !== `Bearer ${opts.requireBearer}`) {
      res.statusCode = 401
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    void transport.handleRequest(req, res)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve()
    })
  })

  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('failed to bind')
  const url = `http://127.0.0.1:${String(addr.port)}/`
  return {
    server,
    url,
    capturedAuth: captured,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
      await transport.close().catch(() => undefined)
      await mcp.close().catch(() => undefined)
    },
  }
}

let running: RunningServer | undefined

beforeEach(() => {
  running = undefined
})

afterEach(async () => {
  if (running) {
    await running.close()
    running = undefined
  }
})

describe('launchHttpMcpServer', () => {
  it('connects, lists tools, and dispatches a tool call', async () => {
    running = await startMcpServer()
    const handle = await launchHttpMcpServer({
      name: 'remote',
      url: running.url,
    })
    try {
      expect(handle.tools.size).toBe(1)
      expect(handle.tools.has('remote_echo')).toBe(true)
      const tool = handle.tools.get('remote_echo')!
      const result = (await tool.execute({ message: 'hi' }, {} as never)) as {
        content: { type: string; text: string }[]
      }
      expect(result.content[0]?.text).toBe('echo: hi')
    } finally {
      await handle.close()
    }
  })

  it('sends Authorization: Bearer when bearerToken is provided', async () => {
    running = await startMcpServer({ requireBearer: 'TKN-abc' })
    const handle = await launchHttpMcpServer({
      name: 'remote',
      url: running.url,
      bearerToken: 'TKN-abc',
    })
    try {
      expect(running.capturedAuth.value).toBe('Bearer TKN-abc')
    } finally {
      await handle.close()
    }
  })

  it('rejects when bearer token is wrong (server returns 401)', async () => {
    running = await startMcpServer({ requireBearer: 'TKN-correct' })
    await expect(
      launchHttpMcpServer({
        name: 'remote',
        url: running.url,
        bearerToken: 'TKN-wrong',
      }),
    ).rejects.toBeDefined()
  })

  it('namespaces tools with the configured server name', async () => {
    running = await startMcpServer()
    const handle = await launchHttpMcpServer({
      name: 'hosted_mcp',
      url: running.url,
    })
    try {
      expect(handle.tools.has('hosted_mcp_echo')).toBe(true)
    } finally {
      await handle.close()
    }
  })

  it('passes static extra headers along with bearer auth', async () => {
    let capturedTenant: string | undefined
    const mcp = new McpServer({ name: 't', version: '0.0.1' })
    mcp.registerTool('noop', { description: 'noop', inputSchema: {} }, () => ({
      content: [{ type: 'text', text: 'ok' }],
    }))
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    })
    await mcp.connect(transport as unknown as Parameters<typeof mcp.connect>[0])
    const server = createServer((req, res) => {
      capturedTenant = req.headers['x-tenant'] as string | undefined
      void transport.handleRequest(req, res)
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve()
      })
    })
    const addr = server.address()
    if (addr === null || typeof addr === 'string') throw new Error('failed to bind')
    const url = `http://127.0.0.1:${String(addr.port)}/`

    try {
      const handle = await launchHttpMcpServer({
        name: 'remote',
        url,
        bearerToken: 'tkn',
        extraHeaders: { 'X-Tenant': '2200' },
      })
      await handle.close()
      expect(capturedTenant).toBe('2200')
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
      await transport.close().catch(() => undefined)
      await mcp.close().catch(() => undefined)
    }
  })
})
