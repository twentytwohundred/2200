/**
 * Slack tool surface (passthrough).
 *
 * One tool shipped: `slack_api`. Thin HTTP passthrough to the Slack Web
 * API. The previous 6-wrapper surface (send_message, list_channels,
 * fetch_history, react, get_user, get_thread) was collapsed into the
 * passthrough per the 2026-05-12 platform-integration pattern (same
 * shape as the Spotify pivot landed 2026-05-11).
 *
 * Why passthrough:
 *   - Provider SDKs (@slack/web-api) carry version coupling and bundle
 *     weight for endpoints we mostly do not use. New Slack features
 *     become a brain-note update, not a code + bundle change.
 *   - 6 typed wrappers + N future endpoints is a quadratic surface.
 *
 * The endpoint catalog (paths, methods, required scopes, gotchas) lives
 * in the shared brain note `slack-api-reference`, seeded by starter-pack.
 *
 * Auth: bot token (`xoxb-...`) from `_2200_SLACK_BOT_TOKEN` in the
 * supervisor env. v1 is outbound-only; no incoming events.
 *
 * Slack response envelope: every Web API response carries `ok: boolean`.
 * On failures, `ok: false` and `error: '<error_code>'`. The tool reads
 * this envelope and throws a clean error so the model gets actionable
 * feedback instead of having to inspect the response.
 */
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../../../mcp/tool.js'
import { SlackCredentialError, type SlackClient } from './client.js'

const SLACK_API_BASE = 'https://slack.com/api'

const SlackApiArgsSchema = z.object({
  method: z
    .enum(['GET', 'POST'])
    .optional()
    .default('POST')
    .describe(
      'HTTP method. Slack Web API is mostly POST; a few endpoints (conversations.list, ' +
        "users.info) also accept GET. Default 'POST'.",
    ),
  path: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "Slack Web API method name. Leading '/' or '/api/' is stripped. " +
        "Examples: 'chat.postMessage', 'conversations.list', " +
        "'reactions.add', 'users.info'. " +
        'See brain note `slack-api-reference` for the endpoint catalog.',
    ),
  body: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'JSON request body for POST. Pass as a structured object; will be ' +
        'JSON-serialized. For chat.postMessage: { channel, text, thread_ts? }. ' +
        'For most read endpoints, parameters travel in `query` instead.',
    ),
  query: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe(
      'URL query parameters. Use for GET endpoints and for POST endpoints that take ' +
        'params via query (e.g. conversations.history). Numbers and booleans coerced ' +
        'to strings.',
    ),
})

interface SlackEnvelope {
  ok: boolean
  error?: string
  needed?: string
  provided?: string
  response_metadata?: { messages?: string[] }
  warning?: string
}

function mapSlackError(envelope: SlackEnvelope): never {
  const err = envelope.error ?? 'unknown_error'
  switch (err) {
    case 'channel_not_found':
      throw new Error('Slack channel not found. Check the channel id; the bot may not be invited.')
    case 'not_in_channel':
      throw new Error('Bot is not a member of this channel. Invite the bot, then retry.')
    case 'is_archived':
      throw new Error('Slack channel is archived; unarchive it before posting.')
    case 'msg_too_long':
      throw new Error('Slack message text exceeds the 40000 character limit.')
    case 'rate_limited':
      throw new Error('Slack rate-limited the request. Retry after the indicated delay.')
    case 'missing_scope': {
      const needed = envelope.needed ?? 'unknown'
      const provided = envelope.provided ?? 'unknown'
      throw new Error(
        `Slack rejected the request: missing scope. Needed: ${needed}; provided: ${provided}. ` +
          `Update the bot's OAuth & Permissions, then re-install to the workspace.`,
      )
    }
    case 'invalid_auth':
    case 'not_authed':
    case 'token_revoked':
    case 'token_expired':
      throw new Error(
        `Slack rejected the bot token (${err}). The token may have been revoked or expired; ` +
          `regenerate it in your Slack app config and update _2200_SLACK_BOT_TOKEN.`,
      )
    default:
      throw new Error(`Slack API error: ${err}`)
  }
}

function normalizePath(raw: string): string {
  let p = raw.trim()
  if (p.startsWith('/')) p = p.slice(1)
  if (p.startsWith('api/')) p = p.slice('api/'.length)
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

export interface SlackToolDeps {
  /** Inject a Slack client (test seam). Default: lazy resolver from env. */
  client?: SlackClient
  /** Inject a fetch-compatible function (test seam). Default: global fetch. */
  fetcher?: typeof fetch
}

export function makeSlackTools(_client: SlackClient, deps?: SlackToolDeps): ToolDefinition[] {
  const fetcher = deps?.fetcher ?? fetch

  const resolveToken = (): string => {
    const raw = process.env['_2200_SLACK_BOT_TOKEN']
    if (!raw || raw.trim().length === 0) {
      throw new SlackCredentialError(
        'Slack bot token is not configured. Set _2200_SLACK_BOT_TOKEN ' +
          "(an 'xoxb-...' token from your Slack app's OAuth & Permissions page) " +
          'in the supervisor environment, then restart the daemon.',
      )
    }
    return raw.trim()
  }

  const apiPassthrough = defineTool({
    name: 'slack_api',
    description:
      'Call the Slack Web API directly. Takes (method, path, body?, query?) and returns the JSON response. ' +
      'Auth: bot token from the supervisor env (`_2200_SLACK_BOT_TOKEN`). ' +
      'Read `slack-api-reference` in the shared brain for the endpoint catalog, required OAuth scopes, ' +
      'and request/response shapes. Use this for: sending messages, listing channels, fetching history, ' +
      'reactions, user lookups, threads, anything the Slack Web API exposes.',
    idempotency: 'destructive',
    argsSchema: SlackApiArgsSchema,
    execute: async (args) => {
      const token = resolveToken()
      const fullUrl = `${SLACK_API_BASE}/${normalizePath(args.path)}${buildQueryString(args.query)}`
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
      }
      const init: RequestInit = { method: args.method, headers }
      if (args.body !== undefined && args.method === 'POST') {
        headers['Content-Type'] = 'application/json; charset=utf-8'
        init.body = JSON.stringify(args.body)
      }
      let response: Response
      try {
        response = await fetcher(fullUrl, init)
      } catch (err) {
        throw new Error(`Slack fetch failed: ${err instanceof Error ? err.message : String(err)}`, {
          cause: err,
        })
      }
      let bodyText: string
      try {
        bodyText = await response.text()
      } catch (err) {
        throw new Error(
          `Slack response read failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        )
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(bodyText)
      } catch (err) {
        throw new Error(
          `Slack response is not JSON (HTTP ${String(response.status)}): ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        )
      }
      // Slack returns 200 even for logical errors; the envelope's `ok`
      // field is the source of truth.
      const env = parsed as SlackEnvelope
      if (!env.ok) {
        mapSlackError(env)
      }
      return parsed
    },
  })

  return [apiPassthrough]
}

export const SLACK_TOOL_NAMES = ['slack_api'] as const
