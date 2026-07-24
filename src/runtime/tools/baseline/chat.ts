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
 * Thread routing: the message lands in the thread the Agent's current
 * task came from, read off `ctx.taskSource`. This is not a nicety.
 * Chat went multi-thread in the design-system v1.1 port, but this tool
 * predates that and wrote unconditionally to the legacy single-thread
 * log ... which the multi-store surfaces only as the `default` chat.
 * So an Agent asked a question in some other thread, went off to do
 * the work, came back to report via `chat_send`, and the report
 * appeared in a thread the operator was not looking at. From the
 * operator's side that is indistinguishable from the Agent never
 * answering. Routing is automatic rather than an argument the model
 * has to remember to pass, because "the model forgot to say where the
 * answer goes" is the exact failure this is fixing.
 *
 * Non-chat tasks (pub wakes, schedules, CLI) have no originating
 * thread, so they keep the legacy path into `default`. That path is
 * still load-bearing: MultiChatStore merges the legacy log into the
 * default thread's view rather than migrating it.
 *
 * Concurrency: ChatStore wraps `fs.appendFile`, which is atomic
 * for small writes on POSIX. Multi-writer (daemon HTTP handler +
 * agent processes) is safe at v1; if dedup or branching ever
 * matters we revisit.
 */
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../../mcp/tool.js'
import { ChatStore } from '../../agent/chat/store.js'
import { DEFAULT_CHAT_ID, MultiChatStore } from '../../agent/chat/multi-store.js'

const ChatSendArgsSchema = z.object({
  content: z.string().min(1).max(8000),
})

export const chatSend = defineTool({
  name: 'chat_send',
  description:
    "Send an unsolicited assistant-role message to the user's private 1:1 chat with you. It lands in the chat thread your current task came from, so if the user asked you something in chat and you went away to work on it, this is how you come back and tell them the answer. Use it for follow-ups, status updates, and anything you noticed that the user should know, without going through the pub. Only the user sees it; other Agents do not.",
  idempotency: 'checkpointed',
  argsSchema: ChatSendArgsSchema,
  execute: async (args, ctx) => {
    // Route to the originating thread when the task came from chat.
    // `default` keeps the legacy path: MultiChatStore merges the legacy
    // log into the default thread's view, so writing through ChatStore
    // is what makes those messages appear.
    const chatId = ctx.taskSource?.kind === 'chat' ? ctx.taskSource.chat_id : DEFAULT_CHAT_ID
    if (chatId !== DEFAULT_CHAT_ID) {
      const multi = new MultiChatStore(ctx.home, ctx.callingAgent)
      const msg = await multi.appendMessage({
        chatId,
        role: 'assistant',
        body: args.content,
        ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
      })
      return {
        message_id: msg.id,
        ts: msg.ts,
        delivered_to: `chat with ${ctx.callingAgent} (thread ${chatId})`,
      }
    }
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
