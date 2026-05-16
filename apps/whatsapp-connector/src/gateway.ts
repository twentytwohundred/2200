/**
 * WhatsApp connector gateway (Baileys-backed WhatsApp Web).
 *
 * Standalone long-lived child process. Maintains the WhatsApp Web
 * socket, prints the pairing QR on first run, forwards inbound
 * messages to the supervisor's connector inbound endpoint, and
 * exposes an HTTP listener that the runtime's `whatsapp_send` tool
 * calls to send outbound.
 *
 * v1 scope: text-only DM in + DM out, single account. Groups, media,
 * reactions, multi-account, and reply quoting are deferred.
 *
 * Env contract (set by the supervisor when it spawns this process;
 * also supports manual invocation during dev):
 *   - SUPERVISOR_URL      base URL of the supervisor HTTP server
 *                         (e.g. http://127.0.0.1:8200)
 *   - GATEWAY_PORT        port to bind for outbound POSTs from the
 *                         runtime's whatsapp_send tool
 *   - AUTH_DIR            absolute path to the directory where Baileys
 *                         persists auth state (creds.json + key files)
 *   - SUPERVISOR_BEARER   optional bearer token for the inbound POST.
 *                         When set, gateway sends as Authorization
 *                         header. Leave unset for the in-process loopback
 *                         path that does not require auth.
 *   - CONNECTOR_ACCOUNT   defaults to 'default'
 *
 * Reference: wiki/decisions/2026-05-16-connector-extensions.md
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve as resolvePath } from 'node:path'

import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
  type WAMessage,
  type WAMessageKey,
} from '@whiskeysockets/baileys'
import qrcodeTerminal from 'qrcode-terminal'

interface GatewayEnv {
  supervisorUrl: string
  gatewayPort: number
  authDir: string
  account: string
  supervisorBearer: string | null
  /**
   * Absolute path to `<home>/state/extensions/whatsapp/gateway.json`.
   * The gateway writes its port here at startup so the runtime's
   * `whatsapp_send` tool can find it. Optional: if unset, the gateway
   * does not advertise (useful for dev runs that only test inbound).
   */
  gatewayInfoPath: string | null
}

const CONNECTOR_ID = 'whatsapp'

function readEnv(): GatewayEnv {
  const supervisorUrl = process.env['SUPERVISOR_URL']
  if (!supervisorUrl) throw new Error('SUPERVISOR_URL required')
  const gatewayPortRaw = process.env['GATEWAY_PORT']
  if (!gatewayPortRaw) throw new Error('GATEWAY_PORT required')
  const gatewayPort = Number(gatewayPortRaw)
  if (!Number.isInteger(gatewayPort) || gatewayPort <= 0 || gatewayPort > 65535) {
    throw new Error(`GATEWAY_PORT must be a valid TCP port; got ${gatewayPortRaw}`)
  }
  const authDirRaw = process.env['AUTH_DIR']
  if (!authDirRaw) throw new Error('AUTH_DIR required')
  const authDir = isAbsolute(authDirRaw) ? authDirRaw : resolvePath(process.cwd(), authDirRaw)
  const gatewayInfoRaw = process.env['GATEWAY_INFO_PATH']
  const gatewayInfoPath = gatewayInfoRaw
    ? isAbsolute(gatewayInfoRaw)
      ? gatewayInfoRaw
      : resolvePath(process.cwd(), gatewayInfoRaw)
    : null
  return {
    supervisorUrl,
    gatewayPort,
    authDir,
    account: process.env['CONNECTOR_ACCOUNT'] ?? 'default',
    supervisorBearer: process.env['SUPERVISOR_BEARER'] ?? null,
    gatewayInfoPath,
  }
}

async function writeGatewayInfo(env: GatewayEnv): Promise<void> {
  if (!env.gatewayInfoPath) return
  const dir = env.gatewayInfoPath.slice(0, env.gatewayInfoPath.lastIndexOf('/'))
  if (dir) await mkdir(dir, { recursive: true })
  await writeFile(
    env.gatewayInfoPath,
    JSON.stringify(
      {
        port: env.gatewayPort,
        account: env.account,
        pid: process.pid,
        started_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  )
  console.error(`[whatsapp-gateway] info written to ${env.gatewayInfoPath}`)
}

async function clearGatewayInfo(env: GatewayEnv): Promise<void> {
  if (!env.gatewayInfoPath) return
  try {
    await unlink(env.gatewayInfoPath)
  } catch {
    // best effort
  }
}

interface BaileysSock {
  sendMessage: (jid: string, content: { text: string }) => Promise<{ key: WAMessageKey } | undefined>
  ev: {
    on: (event: string, handler: (...args: unknown[]) => void) => void
  }
  end: (err?: Error | undefined) => void
}

async function postInbound(env: GatewayEnv, body: unknown): Promise<void> {
  const url = `${env.supervisorUrl.replace(/\/$/, '')}/api/v1/connectors/${CONNECTOR_ID}/inbound`
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
      console.error(`[whatsapp-gateway] inbound POST failed: ${String(res.status)} ${text}`)
    }
  } catch (err) {
    console.error('[whatsapp-gateway] inbound POST threw:', err instanceof Error ? err.message : err)
  }
}

function extractMessageText(msg: WAMessage): string | undefined {
  const m = msg.message
  if (!m) return undefined
  if (m.conversation) return m.conversation
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text
  if (m.imageMessage?.caption) return m.imageMessage.caption
  if (m.videoMessage?.caption) return m.videoMessage.caption
  return undefined
}

function jidToSenderId(jid: string | null | undefined): string | null {
  if (!jid) return null
  // Group messages: participant carries the actual sender JID. DM:
  // the remoteJid is the peer. WhatsApp JIDs come as <number>@s.whatsapp.net
  // or <number>@c.us; strip the @-tail for the public id.
  const at = jid.indexOf('@')
  if (at === -1) return jid
  return `+${jid.slice(0, at)}`
}

function isGroupJid(jid: string | null | undefined): boolean {
  return Boolean(jid && jid.endsWith('@g.us'))
}

async function handleInbound(env: GatewayEnv, msg: WAMessage, selfJid: string | null): Promise<void> {
  const remoteJid = msg.key.remoteJid ?? null
  if (!remoteJid) return
  // WhatsApp pushes a stream of metadata-ish events; only forward
  // actual messages with content the agent can act on.
  const text = extractMessageText(msg)
  if (text === undefined) return
  // Status broadcasts and the announcements channel are noise for v1.
  if (remoteJid === 'status@broadcast') return
  const conversationKind = isGroupJid(remoteJid) ? 'group' : 'dm'
  const senderJid =
    conversationKind === 'group' ? msg.key.participant ?? remoteJid : remoteJid
  const senderId = jidToSenderId(senderJid)
  if (!senderId) return
  const isSelf =
    msg.key.fromMe === true ||
    (selfJid !== null && (senderJid === selfJid || senderJid === selfJid.replace(/:\d+/, '')))
  const event = {
    connector_id: CONNECTOR_ID,
    account: env.account,
    kind: 'message' as const,
    conversation: {
      id: remoteJid,
      kind: conversationKind,
      ...(msg.pushName ? { display_name: msg.pushName } : {}),
    },
    sender: {
      id: senderId,
      ...(msg.pushName ? { display_name: msg.pushName } : {}),
      is_self: isSelf,
    },
    text,
    attachments: [],
    received_at: new Date().toISOString(),
    platform_extras: {
      ...(msg.key.id ? { message_id: msg.key.id } : {}),
      ...(msg.key.participant ? { participant: msg.key.participant } : {}),
    },
  }
  await postInbound(env, event)
}

function startOutboundListener(env: GatewayEnv, getSocket: () => BaileysSock | null): void {
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
            res.end(JSON.stringify({ error: '`to` is required' }))
            return
          }
          const text = typeof payload.body === 'string' ? payload.body : ''
          if (text.length === 0) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: '`body` is required for text sends' }))
            return
          }
          const sock = getSocket()
          if (!sock) {
            res.statusCode = 503
            res.end(JSON.stringify({ error: 'gateway not connected' }))
            return
          }
          const result = await sock.sendMessage(payload.to, { text })
          res.statusCode = 200
          res.end(
            JSON.stringify({
              ok: true,
              message_id: result?.key.id ?? null,
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
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, connected: getSocket() !== null }))
      return
    }
    res.statusCode = 404
    res.end()
  })
  server.listen(env.gatewayPort, '127.0.0.1', () => {
    console.error(`[whatsapp-gateway] outbound listener bound to 127.0.0.1:${String(env.gatewayPort)}`)
  })
}

async function run(): Promise<void> {
  const env = readEnv()
  await mkdir(env.authDir, { recursive: true })
  const { state, saveCreds } = await useMultiFileAuthState(env.authDir)

  let sock: BaileysSock | null = null
  let selfJid: string | null = null

  startOutboundListener(env, () => sock)
  await writeGatewayInfo(env)

  const connect = (): void => {
    const next = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: Browsers.appropriate('2200 (WhatsApp connector)'),
    }) as unknown as BaileysSock
    sock = next

    next.ev.on('creds.update', () => {
      void saveCreds()
    })

    next.ev.on('connection.update', (update: unknown) => {
      const u = update as {
        connection?: 'open' | 'close' | 'connecting'
        qr?: string
        lastDisconnect?: { error?: { output?: { statusCode?: number } } }
      }
      if (u.qr) {
        console.error('\n[whatsapp-gateway] scan this QR with your phone (WhatsApp > Linked Devices):\n')
        qrcodeTerminal.generate(u.qr, { small: true })
      }
      if (u.connection === 'open') {
        // @ts-expect-error Baileys exposes the user on the socket
        const me = next.user as { id?: string } | undefined
        selfJid = me?.id ?? null
        console.error(`[whatsapp-gateway] connected as ${selfJid ?? '<unknown>'}`)
      }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode ?? 0
        const shouldReconnect = code !== (DisconnectReason.loggedOut as number)
        console.error(
          `[whatsapp-gateway] connection closed (status ${String(code)}); reconnect=${String(shouldReconnect)}`,
        )
        if (shouldReconnect) {
          setTimeout(connect, 1500)
        } else {
          console.error('[whatsapp-gateway] logged out; remove the auth dir to re-pair')
          process.exit(1)
        }
      }
    })

    next.ev.on('messages.upsert', (event: unknown) => {
      const e = event as { messages?: WAMessage[]; type?: string }
      if (e.type !== 'notify') return
      for (const msg of e.messages ?? []) {
        void handleInbound(env, msg, selfJid)
      }
    })
  }

  connect()

  const shutdown = async (signal: string): Promise<void> => {
    console.error(`[whatsapp-gateway] ${signal}; closing socket`)
    sock?.end(undefined)
    await clearGatewayInfo(env)
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

run().catch((err: unknown) => {
  console.error('[whatsapp-gateway] fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
