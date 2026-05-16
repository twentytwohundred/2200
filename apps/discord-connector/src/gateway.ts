/**
 * Discord connector gateway (per-Agent bot identity).
 *
 * Long-lived child process spawned by the supervisor. One gateway per
 * (extension_id, agent_name) tuple. Connects to Discord with the
 * Agent's bot token, forwards inbound DMs to the supervisor's
 * connector inbound endpoint, and exposes an HTTP listener the
 * runtime's `discord_send` tool calls for outbound.
 *
 * v1 scope:
 * - DM-only inbound + outbound (no channels yet).
 * - Single bot token (per-Agent; multi-token comes when an Agent
 *   wants more than one Discord identity, unusual).
 * - Self-introduces on first inbound from a user that isn't yet in
 *   the allowlist (operator notification → approve → permanent).
 *
 * Env contract:
 *   - SUPERVISOR_URL       supervisor HTTP base
 *   - GATEWAY_PORT         port for the outbound HTTP listener
 *   - CONNECTOR_ID         'discord'
 *   - AGENT_NAME           which Agent this gateway is for
 *   - DISCORD_BOT_TOKEN    the bot token (supervisor reads from vault
 *                          + passes via env at spawn time)
 *   - GATEWAY_INFO_PATH    where to write the gateway.json descriptor
 *
 * Reference: wiki/decisions/2026-05-16-connector-per-agent-identity.md
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path'

import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  type Message,
} from 'discord.js'

interface GatewayEnv {
  supervisorUrl: string
  gatewayPort: number
  connectorId: string
  agentName: string
  botToken: string
  gatewayInfoPath: string | null
  supervisorBearer: string | null
}

function readEnv(): GatewayEnv {
  const required = (k: string): string => {
    const v = process.env[k]
    if (!v) throw new Error(`${k} required`)
    return v
  }
  const port = Number(required('GATEWAY_PORT'))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`GATEWAY_PORT must be a TCP port; got ${String(process.env['GATEWAY_PORT'])}`)
  }
  const infoRaw = process.env['GATEWAY_INFO_PATH']
  const gatewayInfoPath = infoRaw
    ? isAbsolute(infoRaw)
      ? infoRaw
      : resolvePath(process.cwd(), infoRaw)
    : null
  return {
    supervisorUrl: required('SUPERVISOR_URL'),
    gatewayPort: port,
    connectorId: process.env['CONNECTOR_ID'] ?? 'discord',
    agentName: required('AGENT_NAME'),
    botToken: required('DISCORD_BOT_TOKEN'),
    gatewayInfoPath,
    supervisorBearer: process.env['SUPERVISOR_BEARER'] ?? null,
  }
}

async function postPairState(
  env: GatewayEnv,
  state: {
    state: 'connecting' | 'paired' | 'disconnected' | 'errored'
    self_user?: { id: string; username: string; discriminator?: string }
    detail?: string
  },
): Promise<void> {
  const url = `${env.supervisorUrl.replace(/\/$/, '')}/api/v1/extensions/${env.connectorId}/pair/state`
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (env.supervisorBearer) headers['authorization'] = `Bearer ${env.supervisorBearer}`
  try {
    await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        account: env.agentName,
        ...state,
        at: new Date().toISOString(),
      }),
    })
  } catch (err) {
    console.error(
      '[discord-gateway] pair-state POST threw:',
      err instanceof Error ? err.message : err,
    )
  }
}

async function postInbound(env: GatewayEnv, body: unknown): Promise<void> {
  const url = `${env.supervisorUrl.replace(/\/$/, '')}/api/v1/connectors/${env.connectorId}/inbound`
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (env.supervisorBearer) headers['authorization'] = `Bearer ${env.supervisorBearer}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error(`[discord-gateway] inbound POST failed: ${String(res.status)} ${text}`)
    }
  } catch (err) {
    console.error(
      '[discord-gateway] inbound POST threw:',
      err instanceof Error ? err.message : err,
    )
  }
}

async function writeGatewayInfo(env: GatewayEnv, selfUser: { id: string; username: string }): Promise<void> {
  if (!env.gatewayInfoPath) return
  await mkdir(dirname(env.gatewayInfoPath), { recursive: true })
  await writeFile(
    env.gatewayInfoPath,
    JSON.stringify(
      {
        port: env.gatewayPort,
        agent: env.agentName,
        bot_user_id: selfUser.id,
        bot_username: selfUser.username,
        pid: process.pid,
        started_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  )
  console.error(`[discord-gateway] info written to ${env.gatewayInfoPath}`)
}

async function clearGatewayInfo(env: GatewayEnv): Promise<void> {
  if (!env.gatewayInfoPath) return
  try {
    await unlink(env.gatewayInfoPath)
  } catch {
    // best effort
  }
}

async function handleInbound(env: GatewayEnv, msg: Message, selfUserId: string): Promise<void> {
  // v1: DM-only. Skip channel messages, bots, and our own messages.
  if (msg.author.bot) return
  if (msg.author.id === selfUserId) return
  if (msg.channel.type !== ChannelType.DM) return

  const event = {
    connector_id: env.connectorId,
    account: env.agentName,
    kind: 'message' as const,
    conversation: {
      id: msg.channel.id,
      kind: 'dm' as const,
      display_name: msg.author.username,
    },
    sender: {
      id: msg.author.id,
      display_name: msg.author.username,
      is_self: false,
    },
    text: msg.content,
    attachments: msg.attachments.map((a) => ({
      kind: (a.contentType?.startsWith('image/') ? 'image' : 'document') as 'image' | 'document',
      url: a.url,
      ...(a.name ? { caption: a.name } : {}),
    })),
    received_at: msg.createdAt.toISOString(),
    platform_extras: {
      message_id: msg.id,
      ...(msg.reference?.messageId ? { reply_to: msg.reference.messageId } : {}),
    },
  }
  await postInbound(env, event)
}

function startOutboundListener(
  env: GatewayEnv,
  getClient: () => Client | null,
): void {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'POST' && req.url === '/outbound') {
      let body = ''
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8')
      })
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body) as { to?: unknown; body?: unknown }
          if (typeof payload.to !== 'string' || payload.to.length === 0) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: '`to` is required (Discord channel id)' }))
            return
          }
          if (typeof payload.body !== 'string' || payload.body.length === 0) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: '`body` is required for text sends' }))
            return
          }
          const client = getClient()
          if (!client?.isReady()) {
            res.statusCode = 503
            res.end(JSON.stringify({ error: 'gateway not ready' }))
            return
          }
          const channel = await client.channels.fetch(payload.to)
          if (!channel || !('send' in channel) || typeof channel.send !== 'function') {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'channel not sendable' }))
            return
          }
          const sent = await channel.send(payload.body)
          res.statusCode = 200
          res.end(
            JSON.stringify({
              ok: true,
              message_id: sent.id,
            }),
          )
        } catch (err) {
          res.statusCode = 500
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : 'unknown',
            }),
          )
        }
      })
      return
    }
    if (req.method === 'GET' && req.url === '/health') {
      const client = getClient()
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, ready: Boolean(client?.isReady()) }))
      return
    }
    res.statusCode = 404
    res.end()
  })
  server.listen(env.gatewayPort, '127.0.0.1', () => {
    console.error(
      `[discord-gateway] outbound listener bound to 127.0.0.1:${String(env.gatewayPort)}`,
    )
  })
}

async function run(): Promise<void> {
  const env = readEnv()
  let client: Client | null = null

  startOutboundListener(env, () => client)
  await postPairState(env, { state: 'connecting' })

  const next = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel, Partials.Message],
  })
  client = next

  next.once('ready', (c) => {
    const me = c.user
    console.error(`[discord-gateway] connected as ${me.username} (${me.id})`)
    void writeGatewayInfo(env, { id: me.id, username: me.username })
    void postPairState(env, {
      state: 'paired',
      self_user: {
        id: me.id,
        username: me.username,
        ...(me.discriminator ? { discriminator: me.discriminator } : {}),
      },
    })
  })

  next.on('messageCreate', (msg) => {
    void handleInbound(env, msg, next.user?.id ?? '')
  })

  next.on('error', (err: Error) => {
    console.error(`[discord-gateway] client error: ${err.message}`)
    void postPairState(env, { state: 'errored', detail: err.message })
  })

  next.on('shardDisconnect', () => {
    void postPairState(env, { state: 'disconnected' })
  })

  try {
    await next.login(env.botToken)
  } catch (err) {
    console.error('[discord-gateway] login failed:', err instanceof Error ? err.message : err)
    await postPairState(env, {
      state: 'errored',
      detail: err instanceof Error ? err.message : 'login failed',
    })
    process.exit(1)
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.error(`[discord-gateway] ${signal}; logging out`)
    await client?.destroy().catch(() => undefined)
    await clearGatewayInfo(env)
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

run().catch((err: unknown) => {
  console.error('[discord-gateway] fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
