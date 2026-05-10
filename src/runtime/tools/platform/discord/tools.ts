/**
 * Discord tool definitions.
 *
 * Five tools in v1:
 *   - discord_send_message     post to a channel (optionally as reply)
 *   - discord_list_channels    enumerate channels in a guild
 *   - discord_fetch_history    read recent messages from a channel
 *   - discord_react            add a reaction emoji to a message
 *   - discord_create_thread    spawn a thread (from message or in channel)
 *
 * All five are wrappers around `@discordjs/core/http-only`'s domain
 * APIs (`channels.*`, `guilds.*`, `threads.*`). The model sees a flat
 * tool surface; the underlying HTTP shape is hidden behind the tool
 * args/return contract.
 *
 * Idempotency:
 *   - `discord_list_channels` and `discord_fetch_history` are pure.
 *   - `discord_send_message`, `discord_react`, `discord_create_thread`
 *     mutate channel/message state ... destructive. (Discord does not
 *     offer a stable client-supplied idempotency key, so two send calls
 *     with the same content would post twice. The agent loop is
 *     responsible for not retrying these.)
 */
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../../../mcp/tool.js'
import type { DiscordClient } from './client.js'
import { DiscordCredentialError } from './client.js'

const SnowflakeSchema = z
  .string()
  .regex(/^\d{17,20}$/, { message: 'Discord IDs are 17-20 digit snowflakes' })

const SendMessageArgsSchema = z.object({
  channel_id: SnowflakeSchema.describe('The Discord channel ID to post to.'),
  content: z
    .string()
    .min(1)
    .max(2000)
    .describe('Message text. Discord caps message bodies at 2000 chars.'),
  reply_to: SnowflakeSchema.optional().describe(
    'If set, post as a reply to the given message ID in the same channel.',
  ),
})

const ListChannelsArgsSchema = z.object({
  guild_id: SnowflakeSchema.describe('The Discord guild (server) ID.'),
})

const FetchHistoryArgsSchema = z.object({
  channel_id: SnowflakeSchema,
  limit: z.number().int().min(1).max(100).default(50),
  before: SnowflakeSchema.optional().describe(
    'Return messages older than this message ID (pagination cursor).',
  ),
})

const ReactArgsSchema = z.object({
  channel_id: SnowflakeSchema,
  message_id: SnowflakeSchema,
  emoji: z
    .string()
    .min(1)
    .describe(
      'Unicode emoji (e.g. "🎉") or a custom emoji as "name:id" (e.g. "thumbsup:123456789").',
    ),
})

const CreateThreadArgsSchema = z.object({
  channel_id: SnowflakeSchema.describe('The parent channel ID.'),
  name: z.string().min(1).max(100).describe('Thread name.'),
  message_id: SnowflakeSchema.optional().describe(
    'If set, the thread is anchored on this message. If omitted, creates a standalone thread in the channel.',
  ),
  auto_archive_duration: z
    .union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)])
    .default(1440)
    .describe('Auto-archive in minutes: 60 (1h), 1440 (1d), 4320 (3d), 10080 (7d).'),
})

interface DiscordApiError {
  code?: number
  message?: string
  status?: number
}

function mapDiscordError(err: unknown): never {
  if (err instanceof DiscordCredentialError) throw err
  const e = err as DiscordApiError
  const code = typeof e.code === 'number' ? e.code : undefined
  switch (code) {
    case 10003:
      throw new Error('Discord channel not found (10003). Check the channel_id.')
    case 10004:
      throw new Error('Discord guild not found (10004). Check the guild_id.')
    case 10008:
      throw new Error('Discord message not found (10008). Check the message_id.')
    case 50001:
      throw new Error(
        'Bot lacks access to this resource (50001). Invite the bot to the guild and grant channel permissions.',
      )
    case 50013:
      throw new Error(
        'Bot is missing permissions for this action (50013). Check the bot role permissions in the guild.',
      )
    case 50035:
      throw new Error(
        `Discord rejected the request body (50035): ${e.message ?? 'invalid form body'}.`,
      )
    case 30003:
      throw new Error('Hit the maximum number of pinned messages (30003).')
    case 50083:
      throw new Error('Thread is archived; unarchive it before posting (50083).')
    default:
      if (e.status === 429) {
        throw new Error(
          `Discord rate-limited the request (HTTP 429): ${e.message ?? 'retry after the indicated delay'}.`,
        )
      }
      throw new Error(
        `Discord API error${code !== undefined ? ` (${String(code)})` : ''}: ${e.message ?? String(err)}`,
      )
  }
}

export function makeDiscordTools(client: DiscordClient): ToolDefinition[] {
  const sendMessage = defineTool({
    name: 'discord_send_message',
    description:
      'Post a message to a Discord channel. Optionally post as a reply to an existing message. ' +
      'Requires the bot to be in the guild and have Send Messages permission on the channel.',
    idempotency: 'destructive',
    argsSchema: SendMessageArgsSchema,
    execute: async (args) => {
      const api = client.get()
      try {
        const message = await api.channels.createMessage(args.channel_id, {
          content: args.content,
          ...(args.reply_to ? { message_reference: { message_id: args.reply_to } } : {}),
        })
        return {
          message_id: message.id,
          channel_id: message.channel_id,
          timestamp: message.timestamp,
        }
      } catch (err) {
        mapDiscordError(err)
      }
    },
  })

  const listChannels = defineTool({
    name: 'discord_list_channels',
    description:
      'List all channels in a Discord guild (server). Returns channel id, name, type, parent_id, and topic for each.',
    idempotency: 'pure',
    argsSchema: ListChannelsArgsSchema,
    execute: async (args) => {
      const api = client.get()
      try {
        const channels = await api.guilds.getChannels(args.guild_id)
        return channels.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          parent_id: 'parent_id' in c ? c.parent_id : null,
          topic: 'topic' in c ? (c.topic ?? null) : null,
        }))
      } catch (err) {
        mapDiscordError(err)
      }
    },
  })

  const fetchHistory = defineTool({
    name: 'discord_fetch_history',
    description:
      'Fetch recent messages from a Discord channel, newest first. ' +
      'Pass `before` to paginate into older messages.',
    idempotency: 'pure',
    argsSchema: FetchHistoryArgsSchema,
    execute: async (args) => {
      const api = client.get()
      try {
        const messages = await api.channels.getMessages(args.channel_id, {
          limit: args.limit,
          ...(args.before ? { before: args.before } : {}),
        })
        return messages.map((m) => ({
          id: m.id,
          author: {
            id: m.author.id,
            username: m.author.username,
            bot: m.author.bot ?? false,
          },
          content: m.content,
          timestamp: m.timestamp,
          edited_timestamp: m.edited_timestamp,
          reactions: (m.reactions ?? []).map((r) => ({
            emoji: r.emoji.name ?? r.emoji.id ?? null,
            count: r.count,
          })),
        }))
      } catch (err) {
        mapDiscordError(err)
      }
    },
  })

  const react = defineTool({
    name: 'discord_react',
    description:
      'Add a reaction emoji to a Discord message. ' +
      'Use a Unicode emoji ("🎉") or a custom emoji as "name:id" ("thumbsup:123456789").',
    idempotency: 'destructive',
    argsSchema: ReactArgsSchema,
    execute: async (args) => {
      const api = client.get()
      try {
        // Discord's REST API expects the emoji in URL-encoded form.
        // Custom emoji: "name:id". Unicode: the literal codepoint(s).
        // The discord.js core client handles encoding when we pass the
        // plain string.
        await api.channels.addMessageReaction(args.channel_id, args.message_id, args.emoji)
        return { ok: true }
      } catch (err) {
        mapDiscordError(err)
      }
    },
  })

  const createThread = defineTool({
    name: 'discord_create_thread',
    description:
      'Create a thread in a Discord channel. If `message_id` is provided, the thread is anchored to that message; otherwise a standalone thread is created in the channel.',
    idempotency: 'destructive',
    argsSchema: CreateThreadArgsSchema,
    execute: async (args) => {
      const api = client.get()
      try {
        const thread = await api.channels.createThread(
          args.channel_id,
          {
            name: args.name,
            auto_archive_duration: args.auto_archive_duration,
            // type 11 = PublicThread; only used for standalone threads.
            // When `messageId` is passed, Discord infers the type from
            // the parent message and the body.type is ignored.
            ...(args.message_id ? {} : { type: 11 }),
          },
          args.message_id,
        )
        return { thread_id: thread.id, name: thread.name }
      } catch (err) {
        mapDiscordError(err)
      }
    },
  })

  return [sendMessage, listChannels, fetchHistory, react, createThread]
}

export const DISCORD_TOOL_NAMES = [
  'discord_send_message',
  'discord_list_channels',
  'discord_fetch_history',
  'discord_react',
  'discord_create_thread',
] as const
