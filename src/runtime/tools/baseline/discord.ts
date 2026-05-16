/**
 * discord_send ... outbound Discord message tool.
 *
 * Per-Agent: each Agent's bot has its own gateway, its own gateway.json
 * with the local outbound port. The tool reads the gateway info from
 * `<home>/state/extensions/discord/agents/<calling_agent>/gateway.json`,
 * POSTs to that gateway's /outbound endpoint. Fails fast with
 * `gateway_not_running` if the file is absent or the gateway is
 * unreachable.
 *
 * v1 scope: text-only outbound to a Discord channel id (DM channel
 * or guild channel). Replies, embeds, threads, attachments are
 * deferred.
 *
 * Decisions:
 *   - [[../../decisions/2026-05-16-connector-extensions]]
 *   - [[../../decisions/2026-05-16-connector-per-agent-identity]]
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../../mcp/tool.js'

const DiscordSendArgsSchema = z.object({
  /**
   * Target Discord channel id (typically a DM channel id from an
   * inbound task's `conversation.id`, or a guild channel id you've
   * been given access to). The bot must be in the relevant server
   * (or sharing a DM) to send.
   */
  to: z.string().min(1),
  /** Message text. Required (text-only sends at v1). */
  body: z.string().min(1).max(4000),
})

interface GatewayInfo {
  port: number
  agent: string
  bot_user_id: string
  bot_username: string
}

async function readGatewayInfo(home: string, agent: string): Promise<GatewayInfo | null> {
  const path = join(home, 'state', 'extensions', 'discord', 'agents', agent, 'gateway.json')
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

export const discordTools: ToolDefinition[] = [
  defineTool({
    name: 'discord_send',
    description:
      "Send a Discord message via your bot. `to` is a Discord channel id (a DM channel id you have in an inbound task, or a guild channel id where the bot is a member). `body` is the text to send. The bot's token is sealed to your vault; you never see it.\n\nTypical use: an inbound Discord task lands on you with the conversation_id; reply with this tool using the same id. Fails fast with `gateway_not_running` if the Discord connector's gateway for this Agent is not active.",
    idempotency: 'destructive',
    argsSchema: DiscordSendArgsSchema,
    execute: async (args, ctx) => {
      const info = await readGatewayInfo(ctx.home, ctx.callingAgent)
      if (!info) {
        throw new Error(
          `discord_send: gateway_not_running ... no gateway.json for agent "${ctx.callingAgent}". Install the Discord connector for this Agent from the Extensions Store first.`,
        )
      }
      const res = await fetch(`http://127.0.0.1:${String(info.port)}/outbound`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: args.to, body: args.body }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`discord_send: gateway returned ${String(res.status)}: ${text}`)
      }
      const payload = (await res.json()) as {
        ok?: boolean
        message_id?: string | null
        error?: string
      }
      if (payload.ok !== true) {
        throw new Error(`discord_send: ${payload.error ?? 'unknown gateway error'}`)
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
