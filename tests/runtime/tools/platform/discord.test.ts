/**
 * Discord tool defs ... unit-level coverage of the passthrough.
 *
 * One tool now: `discord_api`. We inject a fake `fetch` so we can
 * assert the URL, method, headers, and body the tool would send to
 * Discord without touching the network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DiscordClient } from '../../../../src/runtime/tools/platform/discord/client.js'
import { makeDiscordTools } from '../../../../src/runtime/tools/platform/discord/tools.js'
import type { ToolContext, ToolDefinition } from '../../../../src/runtime/mcp/tool.js'

const ctx = (): ToolContext => ({
  callingAgent: 'jodin',
  home: '/h',
  brainDir: '/h/agents/jodin/brain',
  projectDir: '/h/agents/jodin/project',
  taskId: 'task_test',
  callId: 'call_test',
})

interface FetchCall {
  url: string
  init: RequestInit
}

interface FakeFetch {
  (...args: Parameters<typeof fetch>): ReturnType<typeof fetch>
  calls: FetchCall[]
  setResponse: (r: Response) => void
}

function makeFakeFetch(): FakeFetch {
  let response: Response = new Response('{}', { status: 200 })
  const calls: FetchCall[] = []
  const fn = ((input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return Promise.resolve(response)
  }) as FakeFetch
  fn.calls = calls
  fn.setResponse = (r: Response) => {
    response = r
  }
  return fn
}

function withFakeFetch(fetcher: FakeFetch): { tool: ToolDefinition } {
  const client = new DiscordClient(() => 'fake-bot-token')
  const tools = makeDiscordTools(client, { fetcher })
  const t = tools.find((tt) => tt.name === 'discord_api')
  if (!t) throw new Error('discord_api not registered')
  return { tool: t }
}

const ORIGINAL_DISCORD_TOKEN = process.env['_2200_DISCORD_BOT_TOKEN']

beforeEach(() => {
  process.env['_2200_DISCORD_BOT_TOKEN'] = 'fake-bot-token'
})

afterEach(() => {
  if (ORIGINAL_DISCORD_TOKEN === undefined) {
    delete process.env['_2200_DISCORD_BOT_TOKEN']
  } else {
    process.env['_2200_DISCORD_BOT_TOKEN'] = ORIGINAL_DISCORD_TOKEN
  }
})

describe('discord_api: argsSchema', () => {
  function t(): ToolDefinition {
    return withFakeFetch(makeFakeFetch()).tool
  }

  it('rejects unknown HTTP method', () => {
    expect(() => t().argsSchema.parse({ method: 'TRACE', path: 'me' })).toThrow()
  })

  it('rejects empty path', () => {
    expect(() => t().argsSchema.parse({ method: 'GET', path: '' })).toThrow()
  })

  it('accepts a typical send-message shape', () => {
    expect(() =>
      t().argsSchema.parse({
        method: 'POST',
        path: 'channels/123/messages',
        body: { content: 'hi' },
      }),
    ).not.toThrow()
  })

  it('accepts query params with mixed types', () => {
    expect(() =>
      t().argsSchema.parse({
        method: 'GET',
        path: 'channels/123/messages',
        query: { limit: 50, before: '999', stripped: true },
      }),
    ).not.toThrow()
  })
})

describe('discord_api: URL construction', () => {
  it('builds a full URL from a bare path', async () => {
    const f = makeFakeFetch()
    const { tool } = withFakeFetch(f)
    await tool.execute({ method: 'GET', path: 'channels/123/messages' }, ctx())
    expect(f.calls[0]!.url).toBe('https://discord.com/api/v10/channels/123/messages')
  })

  it('strips a leading slash', async () => {
    const f = makeFakeFetch()
    const { tool } = withFakeFetch(f)
    await tool.execute({ method: 'GET', path: '/channels/123/messages' }, ctx())
    expect(f.calls[0]!.url).toBe('https://discord.com/api/v10/channels/123/messages')
  })

  it('strips a leading /api/v10/', async () => {
    const f = makeFakeFetch()
    const { tool } = withFakeFetch(f)
    await tool.execute({ method: 'GET', path: '/api/v10/channels/123/messages' }, ctx())
    expect(f.calls[0]!.url).toBe('https://discord.com/api/v10/channels/123/messages')
  })

  it('appends query parameters', async () => {
    const f = makeFakeFetch()
    const { tool } = withFakeFetch(f)
    await tool.execute(
      { method: 'GET', path: 'channels/123/messages', query: { limit: 50, before: '999' } },
      ctx(),
    )
    const url = f.calls[0]!.url
    expect(url.startsWith('https://discord.com/api/v10/channels/123/messages?')).toBe(true)
    const qs = new URLSearchParams(url.split('?')[1] ?? '')
    expect(qs.get('limit')).toBe('50')
    expect(qs.get('before')).toBe('999')
  })
})

describe('discord_api: body + headers', () => {
  it('attaches the Bot Authorization header on every call', async () => {
    const f = makeFakeFetch()
    const { tool } = withFakeFetch(f)
    await tool.execute({ method: 'GET', path: 'users/@me' }, ctx())
    const headers = f.calls[0]!.init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bot fake-bot-token')
  })

  it('serializes the body as JSON on POST', async () => {
    const f = makeFakeFetch()
    f.setResponse(new Response(JSON.stringify({ id: 'msg1', channel_id: '123' }), { status: 200 }))
    const { tool } = withFakeFetch(f)
    await tool.execute(
      {
        method: 'POST',
        path: 'channels/123/messages',
        body: { content: 'hello world' },
      },
      ctx(),
    )
    expect(f.calls[0]!.init.method).toBe('POST')
    const headers = f.calls[0]!.init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    expect(f.calls[0]!.init.body).toBe(JSON.stringify({ content: 'hello world' }))
  })
})

describe('discord_api: response handling', () => {
  it('returns parsed JSON on 200', async () => {
    const f = makeFakeFetch()
    const expected = { id: 'msg1', channel_id: '123', content: 'hi' }
    f.setResponse(new Response(JSON.stringify(expected), { status: 200 }))
    const { tool } = withFakeFetch(f)
    const result = await tool.execute({ method: 'GET', path: 'channels/123/messages/msg1' }, ctx())
    expect(result).toEqual(expected)
  })

  it('returns { ok: true } on 204 No Content', async () => {
    const f = makeFakeFetch()
    f.setResponse(new Response(null, { status: 204 }))
    const { tool } = withFakeFetch(f)
    const result = await tool.execute(
      { method: 'PUT', path: 'channels/123/messages/msg1/reactions/%F0%9F%8E%89/@me' },
      ctx(),
    )
    expect(result).toEqual({ ok: true })
  })

  it('maps Discord error code 10003 (channel not found)', async () => {
    const f = makeFakeFetch()
    f.setResponse(
      new Response(JSON.stringify({ code: 10003, message: 'Unknown Channel' }), { status: 404 }),
    )
    const { tool } = withFakeFetch(f)
    await expect(
      tool.execute({ method: 'GET', path: 'channels/123/messages' }, ctx()),
    ).rejects.toThrow(/channel not found.*10003/i)
  })

  it('maps Discord error code 50013 (missing permissions)', async () => {
    const f = makeFakeFetch()
    f.setResponse(
      new Response(JSON.stringify({ code: 50013, message: 'Missing Permissions' }), {
        status: 403,
      }),
    )
    const { tool } = withFakeFetch(f)
    await expect(
      tool.execute(
        { method: 'POST', path: 'channels/123/messages', body: { content: 'x' } },
        ctx(),
      ),
    ).rejects.toThrow(/missing permissions.*50013/i)
  })

  it('maps HTTP 429 to a rate-limit hint', async () => {
    const f = makeFakeFetch()
    f.setResponse(
      new Response(JSON.stringify({ message: 'You are being rate limited.' }), { status: 429 }),
    )
    const { tool } = withFakeFetch(f)
    await expect(
      tool.execute({ method: 'GET', path: 'channels/123/messages' }, ctx()),
    ).rejects.toThrow(/429/)
  })
})

describe('discord_api: credentials', () => {
  it('throws DiscordCredentialError when token is missing', async () => {
    delete process.env['_2200_DISCORD_BOT_TOKEN']
    const f = makeFakeFetch()
    const { tool } = withFakeFetch(f)
    await expect(tool.execute({ method: 'GET', path: 'users/@me' }, ctx())).rejects.toThrow(
      /Discord bot token is not configured/,
    )
  })
})
