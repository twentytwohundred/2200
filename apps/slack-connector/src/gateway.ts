/**
 * Slack connector gateway (per-Agent bot identity, Socket Mode).
 *
 * Long-lived child process spawned by the supervisor. One gateway per
 * (extension_id, agent_name) tuple. Connects to Slack via Socket Mode (a
 * WebSocket ... no public URL to provision, like Telegram's long-poll),
 * forwards inbound messages to the supervisor's connector inbound endpoint,
 * and exposes an HTTP listener the runtime's `slack_send` tool calls for
 * outbound (`chat.postMessage`).
 *
 * Slack needs TWO tokens: an app-level token (`xapp-...`) to open the Socket
 * Mode WebSocket, and the bot token (`xoxb-...`) for auth.test + sending.
 * Dependency-free: raw Web API over `fetch` + the Node global `WebSocket`, so
 * it bundles to a self-contained CJS and ships in the npm package.
 *
 * Env contract (mirrors the Discord/Telegram gateways):
 *   - SUPERVISOR_URL       supervisor HTTP base
 *   - GATEWAY_PORT         port for the outbound HTTP listener
 *   - CONNECTOR_ID         'slack'
 *   - AGENT_NAME           which Agent this gateway is for
 *   - SLACK_BOT_TOKEN      xoxb-... (auth.test + chat.postMessage)
 *   - SLACK_APP_TOKEN      xapp-... (apps.connections.open for Socket Mode)
 *   - GATEWAY_INFO_PATH    where to write the gateway.json descriptor
 *   - SUPERVISOR_BEARER    optional bearer for the POSTs back
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path'

interface GatewayEnv {
  supervisorUrl: string
  gatewayPort: number
  connectorId: string
  agentName: string
  botToken: string
  appToken: string
  gatewayInfoPath: string | null
  supervisorBearer: string | null
}

const SLACK_API = 'https://slack.com/api'
/** Slack accepts up to 40k chars but truncates display long before; keep readable. */
const MAX_MESSAGE_CHARS = 3500

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
    connectorId: process.env['CONNECTOR_ID'] ?? 'slack',
    agentName: required('AGENT_NAME'),
    botToken: required('SLACK_BOT_TOKEN'),
    appToken: required('SLACK_APP_TOKEN'),
    gatewayInfoPath,
    supervisorBearer: process.env['SUPERVISOR_BEARER'] ?? null,
  }
}

// --- Slack Web API ---------------------------------------------------------

class SlackApiError extends Error {}

/** Call a Slack Web API method with a token. Returns the parsed `ok:true` body. */
async function slackApi<T extends { ok: boolean; error?: string }>(
  method: string,
  token: string,
  body: Record<string, unknown>,
  abortMs: number,
): Promise<T> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(abortMs),
  })
  const data = (await res.json().catch(() => ({ ok: false, error: 'non_json_response' }))) as T
  if (!data.ok) throw new SlackApiError(`${method}: ${data.error ?? `HTTP ${String(res.status)}`}`)
  return data
}

// --- Supervisor callbacks (mirror the Discord/Telegram gateways) -----------

async function postPairState(
  env: GatewayEnv,
  state: {
    state: 'connecting' | 'paired' | 'disconnected' | 'errored'
    self_user?: { id: string; username: string }
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
      body: JSON.stringify({ account: env.agentName, ...state, at: new Date().toISOString() }),
    })
  } catch (err) {
    console.error('[slack-gateway] pair-state POST threw:', err instanceof Error ? err.message : err)
  }
}

async function postInbound(env: GatewayEnv, body: unknown): Promise<void> {
  const url = `${env.supervisorUrl.replace(/\/$/, '')}/api/v1/connectors/${env.connectorId}/inbound`
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (env.supervisorBearer) headers['authorization'] = `Bearer ${env.supervisorBearer}`
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error(`[slack-gateway] inbound POST failed: ${String(res.status)} ${text}`)
    }
  } catch (err) {
    console.error('[slack-gateway] inbound POST threw:', err instanceof Error ? err.message : err)
  }
}

async function writeGatewayInfo(env: GatewayEnv, bot: { id: string; username: string }): Promise<void> {
  if (!env.gatewayInfoPath) return
  await mkdir(dirname(env.gatewayInfoPath), { recursive: true })
  await writeFile(
    env.gatewayInfoPath,
    JSON.stringify(
      {
        port: env.gatewayPort,
        agent: env.agentName,
        bot_user_id: bot.id,
        bot_username: bot.username,
        pid: process.pid,
        started_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  )
  console.error(`[slack-gateway] info written to ${env.gatewayInfoPath}`)
}

async function clearGatewayInfo(env: GatewayEnv): Promise<void> {
  if (!env.gatewayInfoPath) return
  try {
    await unlink(env.gatewayInfoPath)
  } catch {
    // best effort
  }
}

// --- Inbound normalization -------------------------------------------------

interface SlackMessageEvent {
  type: string
  subtype?: string
  bot_id?: string
  user?: string
  channel?: string
  channel_type?: 'im' | 'channel' | 'group' | 'mpim'
  text?: string
  ts?: string
  thread_ts?: string
}

async function handleEvent(
  env: GatewayEnv,
  event: SlackMessageEvent,
  botUserId: string,
  botUsername: string,
): Promise<void> {
  if (event.type !== 'message') return
  // Skip bot messages, edits/deletes, and our own.
  if (event.bot_id) return
  if (event.subtype && event.subtype !== 'file_share') return
  if (!event.user || event.user === botUserId) return
  if (typeof event.text !== 'string' || event.text.length === 0) return
  if (!event.channel) return

  const isDm = event.channel_type === 'im'
  const mentioned = event.text.includes(`<@${botUserId}>`)
  // Rewrite the bot's own raw mention to a readable @handle (leave others).
  const text = event.text.replace(new RegExp(`<@${botUserId}>`, 'g'), `@${botUsername}`)

  const out = {
    connector_id: env.connectorId,
    // Must match the binding slot the setup endpoint writes ('default'), or
    // the supervisor's router drops every event as account_mismatch.
    account: 'default',
    kind: 'message' as const,
    conversation: {
      id: event.channel,
      kind: (isDm ? 'dm' : 'group') as 'dm' | 'group',
      display_name: event.channel,
    },
    sender: { id: event.user, display_name: event.user, is_self: false },
    text,
    attachments: [] as { kind: 'image' | 'document'; url: string; caption?: string }[],
    received_at: new Date().toISOString(),
    platform_extras: {
      ...(event.ts ? { message_id: event.ts } : {}),
      mentioned,
      channel_id: event.channel,
      ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
    },
  }
  await postInbound(env, out)
}

// --- Outbound --------------------------------------------------------------

function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max)
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max)
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max)
    if (cut <= 0) cut = max
    out.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest.length > 0) out.push(rest)
  return out
}

function startOutboundListener(env: GatewayEnv, isReady: () => boolean): void {
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
            res.end(JSON.stringify({ error: '`to` is required (Slack channel id)' }))
            return
          }
          if (typeof payload.body !== 'string' || payload.body.length === 0) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: '`body` is required for text sends' }))
            return
          }
          if (!isReady()) {
            res.statusCode = 503
            res.end(JSON.stringify({ error: 'gateway not ready' }))
            return
          }
          let lastTs: string | null = null
          for (const chunk of chunkText(payload.body, MAX_MESSAGE_CHARS)) {
            const sent = await slackApi<{ ok: boolean; ts?: string; error?: string }>(
              'chat.postMessage',
              env.botToken,
              { channel: payload.to, text: chunk },
              20_000,
            )
            lastTs = sent.ts ?? null
          }
          res.statusCode = 200
          res.end(JSON.stringify({ ok: true, message_id: lastTs }))
        } catch (err) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'unknown' }))
        }
      })
      return
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, ready: isReady() }))
      return
    }
    res.statusCode = 404
    res.end()
  })
  server.listen(env.gatewayPort, '127.0.0.1', () => {
    console.error(`[slack-gateway] outbound listener bound to 127.0.0.1:${String(env.gatewayPort)}`)
  })
}

// --- Socket Mode -----------------------------------------------------------

// The Node global WebSocket (>=22), referenced structurally so we don't depend
// on @types/node exposing the global type.
interface WSEvent {
  data?: unknown
}
interface WebSocketLike {
  addEventListener(type: 'open', cb: () => void): void
  addEventListener(type: 'message', cb: (ev: WSEvent) => void): void
  addEventListener(type: 'close', cb: () => void): void
  addEventListener(type: 'error', cb: (ev: unknown) => void): void
  send(data: string): void
  close(): void
}
const WS = (globalThis as unknown as { WebSocket: new (url: string) => WebSocketLike }).WebSocket

interface SocketFrame {
  type: string
  envelope_id?: string
  reason?: string
  payload?: { event?: SlackMessageEvent }
}

async function run(): Promise<void> {
  const env = readEnv()
  let ready = false

  startOutboundListener(env, () => ready)
  await postPairState(env, { state: 'connecting' })

  // Validate the bot token + learn the bot identity (for self-filter + mentions).
  let auth: { user_id?: string; user?: string }
  try {
    auth = await slackApi<{ ok: boolean; user_id?: string; user?: string; error?: string }>(
      'auth.test',
      env.botToken,
      {},
      15_000,
    )
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'auth.test failed'
    console.error('[slack-gateway] auth.test failed:', detail)
    await postPairState(env, { state: 'errored', detail })
    process.exit(1)
  }
  const botUserId = auth.user_id ?? ''
  const botUsername = auth.user ?? env.agentName
  console.error(`[slack-gateway] authed as @${botUsername} (${botUserId})`)
  await writeGatewayInfo(env, { id: botUserId, username: botUsername })

  let running = true
  let ws: WebSocketLike | null = null
  let backoffMs = 1000

  const connect = async (): Promise<void> => {
    // Each Socket Mode connection needs a fresh single-use wss URL.
    const open = await slackApi<{ ok: boolean; url?: string; error?: string }>(
      'apps.connections.open',
      env.appToken,
      {},
      15_000,
    )
    if (!open.url) throw new SlackApiError('apps.connections.open: no url')
    const socket = new WS(open.url)
    ws = socket

    socket.addEventListener('open', () => {
      console.error('[slack-gateway] socket open')
      backoffMs = 1000
      ready = true
      void postPairState(env, { state: 'paired', self_user: { id: botUserId, username: botUsername } })
    })

    socket.addEventListener('message', (ev: WSEvent) => {
      const raw = typeof ev.data === 'string' ? ev.data : ''
      if (raw === '') return
      let frame: SocketFrame
      try {
        frame = JSON.parse(raw) as SocketFrame
      } catch {
        return
      }
      // ACK any enveloped frame immediately (Slack retries if not ack'd <3s).
      if (frame.envelope_id) {
        try {
          socket.send(JSON.stringify({ envelope_id: frame.envelope_id }))
        } catch {
          // socket may be closing; ignore
        }
      }
      if (frame.type === 'events_api' && frame.payload?.event) {
        void handleEvent(env, frame.payload.event, botUserId, botUsername)
      } else if (frame.type === 'disconnect') {
        console.error(`[slack-gateway] disconnect frame (${frame.reason ?? 'unknown'}); reconnecting`)
        try {
          socket.close()
        } catch {
          // ignore
        }
      }
    })

    socket.addEventListener('close', () => {
      ready = false
      if (!running) return
      console.error(`[slack-gateway] socket closed; reconnecting in ${String(backoffMs)}ms`)
      void postPairState(env, { state: 'disconnected' })
      setTimeout(() => void reconnect(), backoffMs)
      backoffMs = Math.min(backoffMs * 2, 30_000)
    })

    socket.addEventListener('error', (e: unknown) => {
      console.error('[slack-gateway] socket error:', e instanceof Error ? e.message : 'error')
    })
  }

  const reconnect = async (): Promise<void> => {
    if (!running) return
    try {
      await connect()
    } catch (err) {
      console.error('[slack-gateway] reconnect failed:', err instanceof Error ? err.message : err)
      setTimeout(() => void reconnect(), backoffMs)
      backoffMs = Math.min(backoffMs * 2, 30_000)
    }
  }

  try {
    await connect()
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'connect failed'
    console.error('[slack-gateway] initial connect failed:', detail)
    await postPairState(env, { state: 'errored', detail })
    process.exit(1)
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.error(`[slack-gateway] ${signal}; closing`)
    running = false
    ready = false
    try {
      ws?.close()
    } catch {
      // ignore
    }
    await clearGatewayInfo(env)
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

run().catch((err: unknown) => {
  console.error('[slack-gateway] fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
