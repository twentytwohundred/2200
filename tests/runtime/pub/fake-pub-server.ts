/**
 * Fake `@openpub-ai/pub-server` for tests.
 *
 * Spins up a real `http.Server` with both REST endpoints (identity)
 * and a WebSocket server attached at `/ws`. Mirrors the v0.3.2
 * LOCAL_TRUST contract so the consumer code under test is the same
 * code path the real binary exercises.
 *
 * Used by:
 *   - tests/runtime/pub/client.test.ts (PubClient)
 *   - tests/runtime/tools/baseline/pub-tools.test.ts (the four MCP tools)
 *   - tests/runtime/agent/pub-end-to-end.test.ts (PR C smoke)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws'
import { randomUUID } from 'node:crypto'

export interface FakePub {
  port: number
  baseUrl: string
  /** Send-message log so tests can assert on what arrived. */
  receivedMessages: { agentId: string; content: string }[]
  /** All connected agents keyed by agent_id. */
  connectedAgents: Map<string, WsWebSocket>
  /** Inject a server-pushed message to all connected agents. */
  pushMessageToAll: (msg: Record<string, unknown>) => void
  close: () => Promise<void>
}

export async function startFakePub(
  opts: { pubName?: string; pubId?: string } = {},
): Promise<FakePub> {
  const pubName = opts.pubName ?? 'ops'
  const pubId = opts.pubId ?? randomUUID()
  const agents = new Map<
    string,
    { agent_id: string; display_name: string; public_key: string; key_version: number }
  >()
  const byName = new Map<string, string>()
  const receivedMessages: { agentId: string; content: string }[] = []
  const connectedAgents = new Map<string, WsWebSocket>()
  /**
   * Rolling window of recent messages. Mirrors openpub-server's
   * `conversation_window_size` so newly-connecting agents see history
   * via their initial room_state broadcast.
   */
  const conversationWindow: Record<string, unknown>[] = []
  const WINDOW_SIZE = 50

  const httpServer: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    void readBody(req).then((rawBody) => {
      // GET /agents/me
      if (req.method === 'GET' && url.pathname === '/agents/me') {
        const agentId = req.headers['x-openpub-agent-id']
        if (typeof agentId !== 'string' || !agents.has(agentId)) {
          res.writeHead(404).end()
          return
        }
        const record = agents.get(agentId)!
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(record))
        return
      }
      // POST /admin/register-agent
      if (req.method === 'POST' && url.pathname === '/admin/register-agent') {
        const parsed = JSON.parse(rawBody) as {
          display_name: string
          public_key: string
          key_version: number
        }
        if (byName.has(parsed.display_name)) {
          res.writeHead(409).end()
          return
        }
        const agent_id = randomUUID()
        const record = { agent_id, ...parsed }
        agents.set(agent_id, record)
        byName.set(parsed.display_name, agent_id)
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ agent_id }))
        return
      }
      // POST /agents/auth
      if (req.method === 'POST' && url.pathname === '/agents/auth') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            access_token: 'access-' + randomUUID(),
            refresh_token: 'refresh-' + randomUUID(),
            access_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
          }),
        )
        return
      }
      // GET /info
      if (req.method === 'GET' && url.pathname === '/info') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            pub: { id: pubId, name: pubName, owner: 'doug', capacity: 10, entry: 'open' },
            runtime: { version: '0.3.1' },
            agents: { connected: connectedAgents.size, capacity: 10 },
          }),
        )
        return
      }
      res.writeHead(404).end()
    })
  })

  // WebSocket server attached to the same HTTP server, but only for /ws path.
  const wss = new WebSocketServer({ noServer: true })
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    if (url.pathname !== '/ws') {
      socket.destroy()
      return
    }
    const agentId = req.headers['x-openpub-agent-id']
    if (typeof agentId !== 'string' || !agents.has(agentId)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      connectedAgents.set(agentId, ws)
      const agentRecord = agents.get(agentId)!

      ws.send(JSON.stringify({ type: 'welcome' }))
      // Send initial room_state with the rolling conversation window so
      // newly-connecting agents see recent history. Mirrors openpub-server.
      ws.send(
        JSON.stringify({
          type: 'room_state',
          data: {
            pub_id: pubId,
            pub_name: pubName,
            timestamp: new Date().toISOString(),
            agents_present: Array.from(connectedAgents.keys()).map((aid) => {
              const rec = agents.get(aid)
              return {
                agent_id: aid,
                display_name: rec?.display_name ?? '',
                reputation_score: 100,
                joined_at: new Date().toISOString(),
                message_count: 0,
                status: 'active',
              }
            }),
            conversation: [...conversationWindow],
            conversation_window_size: WINDOW_SIZE,
          },
        }),
      )

      ws.on('message', (raw) => {
        let parsed: Record<string, unknown>
        try {
          const buf = raw as Buffer | string
          const text = typeof buf === 'string' ? buf : buf.toString('utf8')
          parsed = JSON.parse(text) as Record<string, unknown>
        } catch {
          return
        }
        const t = parsed['type']
        if (t === 'heartbeat') return
        if (t === 'checkout') {
          ws.close()
          return
        }
        if (t === 'message') {
          const rawContent = parsed['content']
          const content = typeof rawContent === 'string' ? rawContent : ''
          receivedMessages.push({ agentId, content })
          const data = {
            message_id: randomUUID(),
            agent_id: agentId,
            display_name: agentRecord.display_name,
            timestamp: new Date().toISOString(),
            content,
            type: 'chat',
            mentions: (parsed['mentions'] as string[] | undefined) ?? [],
            mention_names: [],
            directed_to: null,
            reply_to: (parsed['reply_to'] as string | null | undefined) ?? null,
          }
          // Cache in the rolling window for future connectors' room_state.
          conversationWindow.push(data)
          while (conversationWindow.length > WINDOW_SIZE) conversationWindow.shift()
          // Broadcast to all currently connected agents (including sender).
          const messageEvent = { type: 'message', data }
          for (const otherWs of connectedAgents.values()) {
            otherWs.send(JSON.stringify(messageEvent))
          }
          return
        }
        if (t === 'reaction') {
          const rawMessageId = parsed['message_id']
          const rawEmoji = parsed['emoji']
          const reactionEvent = {
            type: 'pub_reaction',
            data: {
              reaction_id: randomUUID(),
              pub_id: pubId,
              message_id: typeof rawMessageId === 'string' ? rawMessageId : '',
              agent_id: agentId,
              display_name: agentRecord.display_name,
              emoji: typeof rawEmoji === 'string' ? rawEmoji : '',
              timestamp: new Date().toISOString(),
            },
          }
          for (const otherWs of connectedAgents.values()) {
            otherWs.send(JSON.stringify(reactionEvent))
          }
          return
        }
      })

      ws.on('close', () => {
        connectedAgents.delete(agentId)
      })
    })
  })

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      resolve()
    })
  })
  const addr = httpServer.address()
  if (addr === null || typeof addr === 'string') throw new Error('no address')
  const port = addr.port

  return {
    port,
    baseUrl: `http://127.0.0.1:${String(port)}`,
    receivedMessages,
    connectedAgents,
    pushMessageToAll: (msg) => {
      for (const ws of connectedAgents.values()) {
        ws.send(JSON.stringify(msg))
      }
    },
    close: async () => {
      for (const ws of connectedAgents.values()) {
        try {
          ws.terminate()
        } catch {
          // best-effort
        }
      }
      connectedAgents.clear()
      await new Promise<void>((resolve) => {
        wss.close(() => {
          resolve()
        })
      })
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    },
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  return new Promise((resolve, reject) => {
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}
