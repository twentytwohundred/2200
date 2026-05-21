/**
 * Discord tool surface (passthrough).
 *
 * One tool shipped: `discord_api`. Thin HTTP passthrough to the Discord
 * REST API. The previous 5-wrapper surface (send_message, list_channels,
 * fetch_history, react, create_thread) was collapsed into the passthrough
 * per the 2026-05-12 platform-integration pattern (same shape as the
 * Spotify pivot landed 2026-05-11).
 *
 * Why passthrough:
 *   - Provider SDKs (@discordjs/core, @discordjs/rest) carry version
 *     coupling and bundle weight for endpoints we mostly do not use.
 *     New Discord features become a brain-note update, not a code +
 *     bundle change.
 *   - 5 typed wrappers + N future endpoints is a quadratic surface.
 *     The model navigates by reading the API reference and calling
 *     paths directly; this scales without us shipping new tools.
 *
 * The endpoint catalog (paths, methods, required scopes, gotchas) lives
 * in the shared brain note `discord-api-reference`, seeded by
 * starter-pack. Agents read the note, then call `discord_api`.
 *
 * Auth: bot token from `_2200_DISCORD_BOT_TOKEN` in the supervisor env.
 * Resolved lazily at call time so the agent process boots without
 * Discord configured and surfaces a clean error to the model only if it
 * actually tries to use the tool.
 */
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../../../mcp/tool.js'
import { DiscordCredentialError, type DiscordClient } from './client.js'

const DISCORD_API_BASE = 'https://discord.com/api/v10'

const DiscordApiArgsSchema = z.object({
  method: z
    .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
    .describe('HTTP method. Discord uses PUT for reactions, PATCH for edits.'),
  path: z
    .string()
    .min(1)
    .max(500)
    .describe(
      "Discord REST API path. Leading '/' or '/api/v10/' is stripped. " +
        "Examples: 'channels/{id}/messages', 'guilds/{id}/channels', " +
        "'channels/{id}/messages/{msg}/reactions/{emoji}/@me'. " +
        'See brain note `discord-api-reference` for the endpoint catalog.',
    ),
  query: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe(
      'URL query parameters. Numbers and booleans coerced to strings. ' +
        'Omit for paths that take no query.',
    ),
  body: z
    .unknown()
    .optional()
    .describe(
      'JSON request body for POST/PUT/PATCH. Pass as a structured object; ' +
        'will be JSON-serialized.',
    ),
})

interface DiscordApiErrorBody {
  code?: number
  message?: string
  errors?: unknown
}

function mapDiscordHttpError(status: number, body: DiscordApiErrorBody): never {
  const code = typeof body.code === 'number' ? body.code : undefined
  switch (code) {
    case 10003:
      throw new Error('Discord channel not found (10003). Check the channel id in the path.')
    case 10004:
      throw new Error('Discord guild not found (10004). Check the guild id in the path.')
    case 10008:
      throw new Error('Discord message not found (10008). Check the message id in the path.')
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
        `Discord rejected the request body (50035): ${body.message ?? 'invalid form body'}.`,
      )
    case 30003:
      throw new Error('Hit the maximum number of pinned messages (30003).')
    case 50083:
      throw new Error('Thread is archived; unarchive it before posting (50083).')
    default:
      if (status === 429) {
        throw new Error(
          `Discord rate-limited the request (HTTP 429): ${body.message ?? 'retry after the indicated delay'}.`,
        )
      }
      throw new Error(
        `Discord API error (HTTP ${String(status)}${code !== undefined ? `, code ${String(code)}` : ''}): ${body.message ?? 'no message'}`,
      )
  }
}

function normalizePath(raw: string): string {
  let p = raw.trim()
  if (p.startsWith('/')) p = p.slice(1)
  if (p.startsWith('api/v10/')) p = p.slice('api/v10/'.length)
  if (p.startsWith('api/')) p = p.slice('api/'.length)
  if (p.startsWith('v10/')) p = p.slice('v10/'.length)
  return p
}

function buildQueryString(query: Record<string, string | number | boolean> | undefined): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    params.append(k, String(v))
  }
  const s = params.toString()
  return s ? `?${s}` : ''
}

export interface DiscordToolDeps {
  /** Inject a Discord client (test seam). Default: lazy resolver from env. */
  client?: DiscordClient
  /** Inject a fetch-compatible function (test seam). Default: global fetch. */
  fetcher?: typeof fetch
}

export function makeDiscordTools(_client: DiscordClient, deps?: DiscordToolDeps): ToolDefinition[] {
  const fetcher = deps?.fetcher ?? fetch

  // Token resolver: the existing DiscordClient class reads from env on
  // first .get() call; we mirror that lazy behavior at call time. We do
  // not need the SDK's API object for the passthrough; just the token.
  const resolveToken = (): string => {
    const raw = process.env['_2200_DISCORD_BOT_TOKEN']
    if (!raw || raw.trim().length === 0) {
      throw new DiscordCredentialError(
        'Discord bot token is not configured. Set _2200_DISCORD_BOT_TOKEN in ' +
          'the supervisor environment, or run `2200 platform discord set-token`.',
      )
    }
    return raw.trim()
  }

  const apiPassthrough = defineTool({
    name: 'discord_api',
    description:
      'Call the Discord REST API directly. Takes (method, path, query?, body?) and returns the JSON response. ' +
      'Auth: bot token from the supervisor env (`_2200_DISCORD_BOT_TOKEN`). ' +
      'Read `discord-api-reference` in the shared brain for the endpoint catalog, required permissions, ' +
      'and request/response shapes. Use this for: sending messages, listing channels, fetching history, ' +
      'reactions, threads, member lookups, anything Discord exposes via REST.',
    idempotency: 'destructive',
    argsSchema: DiscordApiArgsSchema,
    execute: async (args) => {
      const token = resolveToken()
      const fullUrl = `${DISCORD_API_BASE}/${normalizePath(args.path)}${buildQueryString(args.query)}`
      const headers: Record<string, string> = {
        Authorization: `Bot ${token}`,
        'User-Agent': 'DiscordBot (2200, v1)',
      }
      const init: RequestInit = { method: args.method, headers }
      if (args.body !== undefined) {
        headers['Content-Type'] = 'application/json'
        init.body = JSON.stringify(args.body)
      }
      let response: Response
      try {
        response = await fetcher(fullUrl, init)
      } catch (err) {
        throw new Error(
          `Discord fetch failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        )
      }
      // 204 No Content (e.g., for reaction add). Return ok marker.
      if (response.status === 204) {
        return { ok: true }
      }
      let bodyText: string
      try {
        bodyText = await response.text()
      } catch (err) {
        throw new Error(
          `Discord response read failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        )
      }
      let parsed: unknown = null
      if (bodyText.length > 0) {
        try {
          parsed = JSON.parse(bodyText)
        } catch {
          // Non-JSON body. Pass the text through.
          parsed = { text: bodyText }
        }
      }
      if (!response.ok) {
        const errBody = parsed && typeof parsed === 'object' ? (parsed as DiscordApiErrorBody) : {}
        mapDiscordHttpError(response.status, errBody)
      }
      return parsed
    },
  })

  return [apiPassthrough]
}

export const DISCORD_TOOL_NAMES = ['discord_api'] as const
