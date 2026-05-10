/**
 * Slack tool definitions.
 *
 * Six tools in v1 (outbound REST only; no incoming events surface):
 *   - slack_send_message    post to a channel (optionally as thread reply)
 *   - slack_list_channels   enumerate workspace channels
 *   - slack_fetch_history   read messages in a channel
 *   - slack_react           add an emoji reaction to a message
 *   - slack_get_user        fetch user info by id
 *   - slack_get_thread      fetch all messages in a thread
 *
 * Auth: workspace bot token (`xoxb-...`) only. Search is intentionally
 * omitted from v1 because Slack's `search.messages` endpoint requires
 * a user token; bot tokens get a permission_denied error. If the
 * operator wires the user-OAuth install flow later, search lands
 * alongside.
 *
 * The output projections drop most of the fat that a raw Slack
 * payload carries: message IDs, channel IDs, and core fields stay; the
 * bulk attachment / blocks / metadata trees are dropped because Agents
 * burning context on them is a token tax with no upside for v1.
 */
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../../../mcp/tool.js'
import type { SlackClient } from './client.js'
import { SlackCredentialError } from './client.js'

const ChannelIdSchema = z.string().regex(/^[CGD][A-Z0-9]{8,}$/, {
  message: 'Slack channel/dm ids start with C, G, or D and are alphanumeric',
})

const UserIdSchema = z.string().regex(/^[UW][A-Z0-9]{8,}$/, {
  message: 'Slack user ids start with U or W and are alphanumeric',
})

const TimestampSchema = z
  .string()
  .regex(/^\d+\.\d+$/, { message: 'Slack message timestamps look like "1715290000.000100"' })

const SendMessageArgsSchema = z.object({
  channel: ChannelIdSchema,
  text: z.string().min(1).max(40000),
  thread_ts: TimestampSchema.optional().describe(
    'If set, post as a reply in this thread (use the parent message ts).',
  ),
})

const ListChannelsArgsSchema = z.object({
  include_archived: z.boolean().default(false),
  types: z
    .array(z.enum(['public_channel', 'private_channel', 'mpim', 'im']))
    .default(['public_channel', 'private_channel']),
  limit: z.number().int().min(1).max(1000).default(200),
})

const FetchHistoryArgsSchema = z.object({
  channel: ChannelIdSchema,
  limit: z.number().int().min(1).max(200).default(50),
  oldest: TimestampSchema.optional(),
  latest: TimestampSchema.optional(),
})

const ReactArgsSchema = z.object({
  channel: ChannelIdSchema,
  timestamp: TimestampSchema,
  emoji_name: z
    .string()
    .min(1)
    .max(100)
    .describe('Emoji shortcode WITHOUT colons. e.g. "thumbsup", not ":thumbsup:".'),
})

const GetUserArgsSchema = z.object({
  user: UserIdSchema,
})

const GetThreadArgsSchema = z.object({
  channel: ChannelIdSchema,
  thread_ts: TimestampSchema,
  limit: z.number().int().min(1).max(200).default(100),
})

interface SlackErrorPayload {
  data?: { error?: string; ok?: boolean }
  code?: string
  message?: string
}

function mapSlackError(err: unknown): never {
  if (err instanceof SlackCredentialError) throw err
  const e = err as SlackErrorPayload
  const slackErr = e.data?.error
  switch (slackErr) {
    case 'channel_not_found':
      throw new Error('Slack channel not found. Check the channel id; the bot may not be invited.')
    case 'not_in_channel':
      throw new Error('Bot is not a member of this channel. Invite the bot, then retry.')
    case 'is_archived':
      throw new Error('Slack channel is archived; unarchive it before posting.')
    case 'msg_too_long':
      throw new Error('Slack message exceeds the 40,000-char limit; split into multiple posts.')
    case 'rate_limited':
      throw new Error('Slack rate-limited the request. Retry after the indicated delay.')
    case 'invalid_auth':
    case 'token_expired':
    case 'token_revoked':
      throw new Error(
        `Slack rejected the bot token (${slackErr}). Re-issue the token from the app settings and update the env var.`,
      )
    case 'missing_scope':
      throw new Error(
        `Slack rejected the call: the bot token is missing a required scope (${slackErr}). Add the scope to the app and reinstall.`,
      )
    case 'user_not_found':
      throw new Error('Slack user not found. Check the user id.')
    case 'thread_not_found':
      throw new Error('Slack thread not found. Check the thread_ts.')
    default:
      if (slackErr) {
        throw new Error(`Slack API error: ${slackErr}.`)
      }
      throw new Error(`Slack request failed: ${e.message ?? String(err)}`)
  }
}

export function makeSlackTools(client: SlackClient): ToolDefinition[] {
  const sendMessage = defineTool({
    name: 'slack_send_message',
    description:
      'Post a message to a Slack channel or DM. Optionally post as a reply in a thread by passing `thread_ts`. ' +
      'Requires the bot to be a member of the channel.',
    idempotency: 'destructive',
    argsSchema: SendMessageArgsSchema,
    execute: async (args) => {
      const web = client.get()
      try {
        const result = await web.chat.postMessage({
          channel: args.channel,
          text: args.text,
          ...(args.thread_ts ? { thread_ts: args.thread_ts } : {}),
        })
        return {
          ok: result.ok,
          channel: result.channel ?? args.channel,
          ts: result.ts ?? null,
        }
      } catch (err) {
        mapSlackError(err)
      }
    },
  })

  const listChannels = defineTool({
    name: 'slack_list_channels',
    description:
      'List Slack channels in the workspace. Filters by visibility (public/private/IM/MPIM) and archive state.',
    idempotency: 'pure',
    argsSchema: ListChannelsArgsSchema,
    execute: async (args) => {
      const web = client.get()
      try {
        const result = await web.conversations.list({
          exclude_archived: !args.include_archived,
          types: args.types.join(','),
          limit: args.limit,
        })
        return (result.channels ?? []).map((c) => ({
          id: c.id ?? null,
          name: c.name ?? null,
          is_private: c.is_private ?? false,
          is_archived: c.is_archived ?? false,
          is_member: c.is_member ?? false,
          topic: c.topic?.value ?? null,
          purpose: c.purpose?.value ?? null,
          num_members: c.num_members ?? null,
        }))
      } catch (err) {
        mapSlackError(err)
      }
    },
  })

  const fetchHistory = defineTool({
    name: 'slack_fetch_history',
    description:
      'Fetch recent messages from a Slack channel, newest first. Pass `latest` and/or `oldest` (Slack timestamps) to bound the range.',
    idempotency: 'pure',
    argsSchema: FetchHistoryArgsSchema,
    execute: async (args) => {
      const web = client.get()
      try {
        const result = await web.conversations.history({
          channel: args.channel,
          limit: args.limit,
          ...(args.oldest ? { oldest: args.oldest } : {}),
          ...(args.latest ? { latest: args.latest } : {}),
        })
        return (result.messages ?? []).map((m) => ({
          ts: m.ts ?? null,
          type: m.type ?? null,
          subtype: m.subtype ?? null,
          user: m.user ?? null,
          text: m.text ?? null,
          thread_ts: m.thread_ts ?? null,
          reply_count: m.reply_count ?? 0,
          reactions: (m.reactions ?? []).map((r) => ({
            name: r.name ?? null,
            count: r.count ?? 0,
          })),
        }))
      } catch (err) {
        mapSlackError(err)
      }
    },
  })

  const react = defineTool({
    name: 'slack_react',
    description:
      'Add an emoji reaction to a Slack message. Pass the emoji shortcode without colons (e.g. "thumbsup", not ":thumbsup:").',
    idempotency: 'destructive',
    argsSchema: ReactArgsSchema,
    execute: async (args) => {
      const web = client.get()
      try {
        await web.reactions.add({
          channel: args.channel,
          timestamp: args.timestamp,
          name: args.emoji_name,
        })
        return { ok: true }
      } catch (err) {
        mapSlackError(err)
      }
    },
  })

  const getUser = defineTool({
    name: 'slack_get_user',
    description: "Fetch a Slack user's profile (display name, real name, email if accessible).",
    idempotency: 'pure',
    argsSchema: GetUserArgsSchema,
    execute: async (args) => {
      const web = client.get()
      try {
        const result = await web.users.info({ user: args.user })
        const u = result.user
        if (!u) return null
        return {
          id: u.id ?? null,
          name: u.name ?? null,
          real_name: u.real_name ?? null,
          display_name: u.profile?.display_name ?? null,
          email: u.profile?.email ?? null,
          is_bot: u.is_bot ?? false,
          is_admin: u.is_admin ?? false,
          tz: u.tz ?? null,
        }
      } catch (err) {
        mapSlackError(err)
      }
    },
  })

  const getThread = defineTool({
    name: 'slack_get_thread',
    description: 'Fetch all messages in a Slack thread (parent + replies).',
    idempotency: 'pure',
    argsSchema: GetThreadArgsSchema,
    execute: async (args) => {
      const web = client.get()
      try {
        const result = await web.conversations.replies({
          channel: args.channel,
          ts: args.thread_ts,
          limit: args.limit,
        })
        return (result.messages ?? []).map((m) => ({
          ts: m.ts ?? null,
          user: m.user ?? null,
          text: m.text ?? null,
          thread_ts: m.thread_ts ?? null,
        }))
      } catch (err) {
        mapSlackError(err)
      }
    },
  })

  return [sendMessage, listChannels, fetchHistory, react, getUser, getThread]
}

export const SLACK_TOOL_NAMES = [
  'slack_send_message',
  'slack_list_channels',
  'slack_fetch_history',
  'slack_react',
  'slack_get_user',
  'slack_get_thread',
] as const
