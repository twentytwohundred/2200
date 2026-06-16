/**
 * slack_send ... outbound Slack message tool (connector path).
 *
 * Per-Agent: each Agent's bot has its own Socket Mode gateway, its own
 * gateway.json with the local outbound port. The tool reads the gateway info
 * from `<home>/state/extensions/slack/agents/<calling_agent>/gateway.json` and
 * POSTs to that gateway's /outbound endpoint, which calls `chat.postMessage`
 * (chunking long bodies). Fails fast with `gateway_not_running` if the file is
 * absent or the gateway is unreachable.
 *
 * This is the CONNECTOR send tool (replies to inbound Slack tasks via the
 * Agent's own bot). It is distinct from the `slack_api` platform tool, which
 * is a raw Web API passthrough using a single global workspace token.
 *
 * v1 scope: text-only outbound to a Slack channel id (a DM channel id from an
 * inbound task, or a channel id where the bot is a member).
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../../mcp/tool.js'

const SlackSendArgsSchema = z.object({
  /**
   * Target Slack channel id (from an inbound task's `conversation.id`): a
   * channel id (`C…`) where the bot is a member, or a DM channel id (`D…`).
   */
  to: z.string().min(1),
  /** Message text. Required (text-only sends at v1); auto-chunked if long. */
  body: z.string().min(1).max(12000),
})

interface GatewayInfo {
  port: number
  agent: string
  bot_user_id: string
  bot_username: string
}

async function readGatewayInfo(home: string, agent: string): Promise<GatewayInfo | null> {
  const path = join(home, 'state', 'extensions', 'slack', 'agents', agent, 'gateway.json')
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

export const slackTools: ToolDefinition[] = [
  defineTool({
    name: 'slack_send',
    description:
      "Send a Slack message via your bot. `to` is a Slack channel id (a channel id like `C…` where the bot is a member, or a DM channel id like `D…` from an inbound task). `body` is the text to send; long bodies are auto-split. The bot's token is sealed to your vault; you never see it.\n\nTypical use: an inbound Slack task lands on you with the conversation_id; reply with this tool using the same id. Fails fast with `gateway_not_running` if the Slack connector's gateway for this Agent is not active. (For raw Slack Web API calls with a workspace token, use `slack_api` instead.)",
    idempotency: 'destructive',
    argsSchema: SlackSendArgsSchema,
    execute: async (args, ctx) => {
      const info = await readGatewayInfo(ctx.home, ctx.callingAgent)
      if (!info) {
        throw new Error(
          `slack_send: gateway_not_running ... no gateway.json for agent "${ctx.callingAgent}". Install the Slack connector for this Agent from the Extensions Store first.`,
        )
      }
      const res = await fetch(`http://127.0.0.1:${String(info.port)}/outbound`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: args.to, body: args.body }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`slack_send: gateway returned ${String(res.status)}: ${text}`)
      }
      const payload = (await res.json()) as {
        ok?: boolean
        message_id?: string | null
        error?: string
      }
      if (payload.ok !== true) {
        throw new Error(`slack_send: ${payload.error ?? 'unknown gateway error'}`)
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
