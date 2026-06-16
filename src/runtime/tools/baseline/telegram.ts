/**
 * telegram_send ... outbound Telegram message tool.
 *
 * Per-Agent: each Agent's bot has its own gateway, its own gateway.json with
 * the local outbound port. The tool reads the gateway info from
 * `<home>/state/extensions/telegram/agents/<calling_agent>/gateway.json` and
 * POSTs to that gateway's /outbound endpoint, which calls the Bot API's
 * `sendMessage` (chunking long bodies at the 4096-char limit). Fails fast with
 * `gateway_not_running` if the file is absent or the gateway is unreachable.
 *
 * v1 scope: text-only outbound to a Telegram chat id (a DM chat id ... positive
 * ... or a group chat id ... negative). The bot's token is sealed to the
 * Agent's vault; the tool never sees it.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../../mcp/tool.js'

const TelegramSendArgsSchema = z.object({
  /**
   * Target Telegram chat id (from an inbound task's `conversation.id`): a
   * positive id for a DM, a negative id for a group/supergroup. The bot must
   * share the chat (the user has messaged it, or it's in the group) to send.
   */
  to: z.string().min(1),
  /** Message text. Required (text-only sends at v1); auto-chunked if > 4096. */
  body: z.string().min(1).max(12000),
})

interface GatewayInfo {
  port: number
  agent: string
  bot_user_id: string
  bot_username: string
}

async function readGatewayInfo(home: string, agent: string): Promise<GatewayInfo | null> {
  const path = join(home, 'state', 'extensions', 'telegram', 'agents', agent, 'gateway.json')
  try {
    const text = await readFile(path, 'utf-8')
    const data = JSON.parse(text) as Record<string, unknown>
    const port = data['port']
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) {
      return null
    }
    return {
      port,
      agent: typeof data['agent'] === 'string' ? data['agent'] : agent,
      bot_user_id: typeof data['bot_user_id'] === 'string' ? data['bot_user_id'] : '',
      bot_username: typeof data['bot_username'] === 'string' ? data['bot_username'] : '',
    }
  } catch {
    return null
  }
}

export const telegramTools: ToolDefinition[] = [
  defineTool({
    name: 'telegram_send',
    description:
      "Send a Telegram message via your bot. `to` is a Telegram chat id (a DM chat id you have in an inbound task ... positive ... or a group chat id ... negative). `body` is the text to send; long bodies are auto-split into multiple messages. The bot's token is sealed to your vault; you never see it.\n\nTypical use: an inbound Telegram task lands on you with the conversation_id; reply with this tool using the same id. Fails fast with `gateway_not_running` if the Telegram connector's gateway for this Agent is not active.",
    idempotency: 'destructive',
    argsSchema: TelegramSendArgsSchema,
    execute: async (args, ctx) => {
      const info = await readGatewayInfo(ctx.home, ctx.callingAgent)
      if (!info) {
        throw new Error(
          `telegram_send: gateway_not_running ... no gateway.json for agent "${ctx.callingAgent}". Install the Telegram connector for this Agent from the Extensions Store first.`,
        )
      }
      const res = await fetch(`http://127.0.0.1:${String(info.port)}/outbound`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: args.to, body: args.body }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`telegram_send: gateway returned ${String(res.status)}: ${text}`)
      }
      const payload = (await res.json()) as {
        ok?: boolean
        message_id?: string | null
        error?: string
      }
      if (payload.ok !== true) {
        throw new Error(`telegram_send: ${payload.error ?? 'unknown gateway error'}`)
      }
      return {
        status: 'sent' as const,
        message_id: payload.message_id ?? null,
        to: args.to,
        bot_username: info.bot_username,
      }
    },
  }),
]
