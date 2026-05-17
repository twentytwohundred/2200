/**
 * chat.* baseline tools.
 *
 * `chat_send` lets an Agent unilaterally push an assistant-role
 * message into its own per-Agent chat thread (the persistent 1:1
 * conversation surface at `<home>/agents/<name>/chat.jsonl`).
 *
 * Why the Agent needs this:
 *   The chat surface was historically one-way ... user posts, the
 *   daemon starts a task, on completion the daemon appends the
 *   assistant reply. So the only way an Agent could appear in its
 *   chat was as a response to the user's most recent turn. There
 *   was no path for the Agent to say "hey, follow-up after my
 *   pub work" or "I just noticed X" without the user prompting
 *   first. This tool closes that gap: any time an Agent has
 *   something to tell the user privately, it calls `chat_send`
 *   and the message lands in the chat log; the web client picks
 *   it up on the next 3s poll (or instantly via WS push when we
 *   wire that broadcast).
 *
 * Scope: an Agent can only push to ITS OWN chat (resolved from
 * `ctx.callingAgent`). Cross-Agent messaging goes through pubs.
 *
 * Concurrency: ChatStore wraps `fs.appendFile`, which is atomic
 * for small writes on POSIX. Multi-writer (daemon HTTP handler +
 * agent processes) is safe at v1; if dedup or branching ever
 * matters we revisit.
 */
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../../mcp/tool.js'
import { ChatStore } from '../../agent/chat/store.js'

const ChatSendArgsSchema = z.object({
  content: z.string().min(1).max(8000),
})

export const chatSend = defineTool({
  name: 'chat_send',
  description:
    "Send an unsolicited assistant-role message to the user's private 1:1 chat with you. The message lands at <home>/agents/<your-name>/chat.jsonl and shows up in the web app's chat screen the next time the user opens or refreshes it. Use this when you want to tell the user something privately (a follow-up, a status update, a heads-up about something you noticed) without going through the pub. Only the user sees it; other Agents do not.",
  idempotency: 'checkpointed',
  argsSchema: ChatSendArgsSchema,
  execute: async (args, ctx) => {
    const store = new ChatStore(ctx.home, ctx.callingAgent)
    const msg = await store.append({
      role: 'assistant',
      content: args.content,
      taskId: ctx.taskId,
    })
    return {
      message_id: msg.id,
      ts: msg.ts,
      delivered_to: `chat with ${ctx.callingAgent}`,
    }
  },
})

export const chatTools: ToolDefinition[] = [chatSend]
