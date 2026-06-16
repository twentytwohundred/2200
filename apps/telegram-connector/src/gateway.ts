/**
 * Telegram connector gateway (per-Agent bot identity).
 *
 * Long-lived child process spawned by the supervisor. One gateway per
 * (extension_id, agent_name) tuple. Connects to Telegram with the Agent's
 * bot token via the Bot API (plain HTTPS ... no SDK), forwards inbound
 * messages to the supervisor's connector inbound endpoint, and exposes an
 * HTTP listener the runtime's `telegram_send` tool calls for outbound.
 *
 * Inbound is `getUpdates` long-polling (outbound HTTPS only ... no public URL
 * to provision, unlike webhooks; and exactly-one-consumer, which matches the
 * "gateway owns the token" model the supervisor already enforces). Outbound is
 * `sendMessage`. No intents, no WebSocket gateway, no privileged toggles.
 *
 * v1 scope: text DM + group in/out, single bot token. Mention detection for
 * `require_mention` is computed from the bot's @username + message entities.
 *
 * Env contract (mirrors the Discord gateway):
 *   - SUPERVISOR_URL       supervisor HTTP base
 *   - GATEWAY_PORT         port for the outbound HTTP listener
 *   - CONNECTOR_ID         'telegram'
 *   - AGENT_NAME           which Agent this gateway is for
 *   - TELEGRAM_BOT_TOKEN   the bot token (supervisor reads from vault + passes
 *                          via env at spawn time)
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
  gatewayInfoPath: string | null
  supervisorBearer: string | null
}

const TELEGRAM_API = 'https://api.telegram.org'
/** Long-poll hold (s). The client abort must exceed this (see POLL_ABORT_MS). */
const POLL_TIMEOUT_S = 30
const POLL_ABORT_MS = (POLL_TIMEOUT_S + 10) * 1000
/** Telegram's hard cap is 4096 UTF-16 units; leave headroom like OpenClaw. */
const MAX_MESSAGE_CHARS = 4000

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
    connectorId: process.env['CONNECTOR_ID'] ?? 'telegram',
    agentName: required('AGENT_NAME'),
    botToken: required('TELEGRAM_BOT_TOKEN'),
    gatewayInfoPath,
    supervisorBearer: process.env['SUPERVISOR_BEARER'] ?? null,
  }
}

// --- Telegram Bot API ------------------------------------------------------

/** A non-2xx / ok:false Telegram response. Carries the code for the loop's policy. */
class TelegramApiError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message)
    this.name = 'TelegramApiError'
  }
}

interface TgUser {
  id: number
  is_bot?: boolean
  first_name?: string
  username?: string
}
interface TgChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title?: string
  username?: string
  first_name?: string
}
interface TgMessageEntity {
  type: string
  offset: number
  length: number
  user?: TgUser
}
interface TgMessage {
  message_id: number
  from?: TgUser
  chat: TgChat
  date: number
  text?: string
  entities?: TgMessageEntity[]
  reply_to_message?: { from?: TgUser; message_id?: number }
}
interface TgUpdate {
  update_id: number
  message?: TgMessage
}

/**
 * Call a Bot API method. Returns `result`. Throws `TelegramApiError` on
 * `ok:false`, surfacing `error_code` + `retry_after` so the caller can apply
 * the right policy (fatal vs retry vs back off).
 */
async function tgApi<T>(
  env: GatewayEnv,
  method: string,
  params: Record<string, unknown>,
  abortMs: number,
): Promise<T> {
  const url = `${TELEGRAM_API}/bot${env.botToken}/${method}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(abortMs),
  })
  let data: unknown
  try {
    data = await res.json()
  } catch {
    throw new TelegramApiError(res.status, `${method}: non-JSON response (HTTP ${String(res.status)})`)
  }
  const env2 = data as { ok?: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } }
  if (env2.ok === true) return env2.result as T
  throw new TelegramApiError(
    env2.error_code ?? res.status,
    `${method}: ${env2.description ?? `HTTP ${String(res.status)}`}`,
    env2.parameters?.retry_after,
  )
}

// --- Supervisor callbacks (mirror the Discord gateway) ---------------------

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
    console.error('[telegram-gateway] pair-state POST threw:', err instanceof Error ? err.message : err)
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
      console.error(`[telegram-gateway] inbound POST failed: ${String(res.status)} ${text}`)
    }
  } catch (err) {
    console.error('[telegram-gateway] inbound POST threw:', err instanceof Error ? err.message : err)
  }
}

async function writeGatewayInfo(
  env: GatewayEnv,
  bot: { id: string; username: string },
): Promise<void> {
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
  console.error(`[telegram-gateway] info written to ${env.gatewayInfoPath}`)
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

/**
 * Was the bot addressed? In a group, Telegram (privacy mode on) mostly only
 * delivers messages that mention/reply-to/command the bot, but we compute it
 * anyway so the router's `require_mention` is authoritative: an entity of type
 * `mention` matching `@username`, a `text_mention` of the bot's id, a reply to
 * the bot, or a literal `@username` in the text.
 */
function computeMentioned(msg: TgMessage, botId: number, botUsername: string): boolean {
  if (msg.reply_to_message?.from?.id === botId) return true
  const handle = `@${botUsername.toLowerCase()}`
  const text = msg.text ?? ''
  for (const e of msg.entities ?? []) {
    if (e.type === 'text_mention' && e.user?.id === botId) return true
    if ((e.type === 'mention' || e.type === 'bot_command') && text.length >= e.offset + e.length) {
      const slice = text.slice(e.offset, e.offset + e.length).toLowerCase()
      if (slice === handle || slice.startsWith(`${handle}`) || slice.endsWith(handle)) return true
    }
  }
  return text.toLowerCase().includes(handle)
}

async function handleInbound(
  env: GatewayEnv,
  update: TgUpdate,
  botId: number,
  botUsername: string,
): Promise<void> {
  const msg = update.message
  if (!msg || typeof msg.text !== 'string' || msg.text.length === 0) return
  if (msg.from?.is_bot === true) return
  if (msg.from?.id === botId) return

  const isDm = msg.chat.type === 'private'
  const conversationName = isDm
    ? (msg.chat.username ?? msg.chat.first_name ?? String(msg.chat.id))
    : (msg.chat.title ?? String(msg.chat.id))
  const senderName = msg.from?.username ?? msg.from?.first_name ?? String(msg.from?.id ?? 'unknown')

  const event = {
    connector_id: env.connectorId,
    // Must match the binding slot the setup endpoint writes ('default'), or
    // the supervisor's router drops every event as account_mismatch.
    account: 'default',
    kind: 'message' as const,
    conversation: {
      id: String(msg.chat.id),
      kind: (isDm ? 'dm' : 'group') as 'dm' | 'group',
      display_name: conversationName,
    },
    sender: {
      id: String(msg.from?.id ?? msg.chat.id),
      display_name: senderName,
      is_self: false,
    },
    text: msg.text,
    attachments: [] as { kind: 'image' | 'document'; url: string; caption?: string }[],
    received_at: new Date(msg.date * 1000).toISOString(),
    platform_extras: {
      message_id: String(msg.message_id),
      mentioned: computeMentioned(msg, botId, botUsername),
      chat_id: String(msg.chat.id),
      ...(msg.reply_to_message?.message_id
        ? { reply_to: String(msg.reply_to_message.message_id) }
        : {}),
    },
  }
  await postInbound(env, event)
}

// --- Outbound --------------------------------------------------------------

/** Split on paragraph, then line, then hard boundary, into <=max-char chunks. */
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
            res.end(JSON.stringify({ error: '`to` is required (Telegram chat id)' }))
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
          const chunks = chunkText(payload.body, MAX_MESSAGE_CHARS)
          let lastId: number | null = null
          for (const chunk of chunks) {
            const sent = await tgApi<{ message_id: number }>(
              env,
              'sendMessage',
              { chat_id: payload.to, text: chunk },
              20_000,
            )
            lastId = sent.message_id
          }
          res.statusCode = 200
          res.end(JSON.stringify({ ok: true, message_id: lastId === null ? null : String(lastId) }))
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
    console.error(`[telegram-gateway] outbound listener bound to 127.0.0.1:${String(env.gatewayPort)}`)
  })
}

// --- Main long-poll loop ---------------------------------------------------

async function run(): Promise<void> {
  const env = readEnv()
  let ready = false

  startOutboundListener(env, () => ready)
  await postPairState(env, { state: 'connecting' })

  // Validate the token + learn the bot identity (needed for mention detection).
  let me: TgUser
  try {
    me = await tgApi<TgUser>(env, 'getMe', {}, 15_000)
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'getMe failed'
    console.error('[telegram-gateway] getMe failed:', detail)
    await postPairState(env, { state: 'errored', detail })
    process.exit(1)
  }
  const botUsername = me.username ?? env.agentName
  console.error(`[telegram-gateway] connected as @${botUsername} (${String(me.id)})`)
  // A leftover webhook makes getUpdates 409; clearing it is idempotent.
  try {
    await tgApi(env, 'deleteWebhook', { drop_pending_updates: false }, 10_000)
  } catch {
    // not fatal ... if there's no webhook this still returns ok
  }
  await writeGatewayInfo(env, { id: String(me.id), username: botUsername })
  await postPairState(env, { state: 'paired', self_user: { id: String(me.id), username: botUsername } })
  ready = true

  // Discard the backlog so a freshly-installed / just-restarted gateway does
  // not replay old messages (matches Discord's no-replay behavior). We learn
  // the latest update_id without acting on it, then poll from there.
  let offset = 0
  try {
    const backlog = await tgApi<TgUpdate[]>(env, 'getUpdates', { offset: -1, timeout: 0 }, 15_000)
    const last = backlog.at(-1)
    if (last) offset = last.update_id + 1
  } catch {
    // start from 0 if the drain fails; at worst we process recent backlog
  }

  let running = true
  let backoffMs = 1000
  const shutdown = async (signal: string): Promise<void> => {
    console.error(`[telegram-gateway] ${signal}; stopping`)
    running = false
    ready = false
    await clearGatewayInfo(env)
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  while (running) {
    try {
      const updates = await tgApi<TgUpdate[]>(
        env,
        'getUpdates',
        { offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message'] },
        POLL_ABORT_MS,
      )
      backoffMs = 1000 // healthy poll resets backoff
      for (const u of updates) {
        await handleInbound(env, u, me.id, botUsername)
        offset = u.update_id + 1 // advance only after a successful handoff
      }
    } catch (err) {
      if (err instanceof TelegramApiError) {
        if (err.code === 401) {
          console.error('[telegram-gateway] 401 unauthorized ... token invalid/revoked; exiting')
          await postPairState(env, { state: 'errored', detail: 'unauthorized (bad token)' })
          process.exit(1)
        }
        if (err.code === 409) {
          // Another getUpdates consumer or a webhook. Try clearing a webhook;
          // if it persists, this is a misconfiguration ... back off, don't spin.
          console.error('[telegram-gateway] 409 conflict:', err.message)
          await tgApi(env, 'deleteWebhook', { drop_pending_updates: false }, 10_000).catch(() => undefined)
          await postPairState(env, { state: 'errored', detail: '409 conflict (another poller?)' })
        } else if (err.code === 429 && typeof err.retryAfter === 'number') {
          await sleep(err.retryAfter * 1000)
          continue
        } else {
          console.error('[telegram-gateway] api error:', err.message)
        }
      } else {
        // Network / abort / transient. Back off with a cap; never die.
        console.error('[telegram-gateway] poll error:', err instanceof Error ? err.message : err)
      }
      await sleep(backoffMs)
      backoffMs = Math.min(backoffMs * 2, 30_000)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

run().catch((err: unknown) => {
  console.error('[telegram-gateway] fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
