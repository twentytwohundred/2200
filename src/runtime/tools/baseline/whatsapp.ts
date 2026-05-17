/**
 * whatsapp_send ... outbound WhatsApp message tool.
 *
 * Posts to the WhatsApp connector gateway's local outbound listener.
 * The gateway port is discovered via `<home>/state/extensions/whatsapp/gateway.json`
 * (the supervisor writes this when it starts the gateway). The tool
 * fails cleanly with a "gateway_not_running" error if the file is
 * absent or the gateway is unreachable.
 *
 * v1 scope: text-only outbound. Media + reply quoting + reactions are
 * deferred.
 *
 * Decision: 2026-05-16-connector-extensions.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../../mcp/tool.js'

const WhatsappSendArgsSchema = z.object({
  /**
   * Target conversation. For DMs this is the WhatsApp JID
   * (`<E.164>@s.whatsapp.net` or `<E.164>@c.us`). For groups,
   * `<id>@g.us`. Use the value the inbound task body surfaced; the
   * gateway does the routing.
   */
  to: z.string().min(1),
  /** Message text. Required (text-only sends at v1). */
  body: z.string().min(1).max(4000),
})

interface GatewayInfo {
  port: number
}

async function readGatewayInfo(home: string): Promise<GatewayInfo | null> {
  const path = join(home, 'state', 'extensions', 'whatsapp', 'gateway.json')
  try {
    const text = await readFile(path, 'utf-8')
    const data = JSON.parse(text) as Record<string, unknown>
    const port = data['port']
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) {
      return null
    }
    return { port }
  } catch {
    return null
  }
}

export const whatsappTools: ToolDefinition[] = [
  defineTool({
    name: 'whatsapp_send',
    description:
      "Send a WhatsApp message to a conversation the WhatsApp connector has access to. `to` is the WhatsApp JID surfaced in the inbound task body (DMs end in `@s.whatsapp.net`; groups end in `@g.us`). `body` is the text to send. The credential is on disk in the gateway's auth dir; you never see it. The connector handles delivery via the user's paired WhatsApp account.\n\nTypical use: an inbound `connector` task lands; you process it; you reply via this tool with `to` set to the inbound task's `conversation_id`. Do NOT use this for cold outbound to numbers the operator has not allowlisted ... gateway will refuse.\n\nReturns `{status, message_id}` on success. Fails fast with `gateway_not_running` if the WhatsApp connector's gateway process is not active for this 2200 home.",
    idempotency: 'destructive',
    argsSchema: WhatsappSendArgsSchema,
    execute: async (args, ctx) => {
      const info = await readGatewayInfo(ctx.home)
      if (!info) {
        throw new Error(
          'whatsapp_send: gateway_not_running ... no <home>/state/extensions/whatsapp/gateway.json. Confirm the WhatsApp connector is installed and paired (`2200 connector status whatsapp`).',
        )
      }
      const res = await fetch(`http://127.0.0.1:${String(info.port)}/outbound`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: args.to, body: args.body }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`whatsapp_send: gateway returned ${String(res.status)}: ${text}`)
      }
      const payload = (await res.json()) as {
        ok?: boolean
        message_id?: string | null
        error?: string
      }
      if (payload.ok !== true) {
        throw new Error(`whatsapp_send: ${payload.error ?? 'unknown gateway error'}`)
      }
      return {
        status: 'sent' as const,
        message_id: payload.message_id ?? null,
        to: args.to,
      }
    },
  }),
]
