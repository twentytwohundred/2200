/**
 * Slack tool defs ... unit-level coverage of the passthrough.
 *
 * One tool now: `slack_api`. We inject a fake `fetch` so we can assert
 * the URL, method, headers, and body the tool would send to Slack
 * without touching the network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SlackClient } from '../../../../src/runtime/tools/platform/slack/client.js'
import { makeSlackTools } from '../../../../src/runtime/tools/platform/slack/tools.js'
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
  let response: Response = new Response(JSON.stringify({ ok: true }), { status: 200 })
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
  const client = new SlackClient(() => 'xoxb-fake-token')
  const tools = makeSlackTools(client, { fetcher })
  const t = tools.find((tt) => tt.name === 'slack_api')
  if (!t) throw new Error('slack_api not registered')
  return { tool: t }
}

const ORIGINAL_SLACK_TOKEN = process.env['_2200_SLACK_BOT_TOKEN']

beforeEach(() => {
  process.env['_2200_SLACK_BOT_TOKEN'] = 'xoxb-fake-token'
})

afterEach(() => {
  if (ORIGINAL_SLACK_TOKEN === undefined) {
    delete process.env['_2200_SLACK_BOT_TOKEN']
  } else {
    process.env['_2200_SLACK_BOT_TOKEN'] = ORIGINAL_SLACK_TOKEN
  }
})

describe('slack_api: argsSchema', () => {
  function t(): ToolDefinition {
    return withFakeFetch(makeFakeFetch()).tool
  }

  it('rejects empty path', () => {
    expect(() => t().argsSchema.parse({ method: 'POST', path: '' })).toThrow()
  })

  it('rejects unknown method', () => {
    expect(() => t().argsSchema.parse({ method: 'PUT', path: 'chat.postMessage' })).toThrow()
  })

  it('defaults method to POST', () => {
    const parsed = t().argsSchema.parse({ path: 'chat.postMessage' }) as { method: string }
    expect(parsed.method).toBe('POST')
  })
})

describe('slack_api: URL + body', () => {
  it('builds the full URL from a bare method name', async () => {
    const f = makeFakeFetch()
    const { tool } = withFakeFetch(f)
    await tool.execute(
      { method: 'POST', path: 'chat.postMessage', body: { channel: 'C1', text: 'hi' } },
      ctx(),
    )
    expect(f.calls[0]!.url).toBe('https://slack.com/api/chat.postMessage')
  })

  it('strips leading slash and /api/', async () => {
    const f = makeFakeFetch()
    const { tool } = withFakeFetch(f)
    await tool.execute(
      { method: 'POST', path: '/api/chat.postMessage', body: { channel: 'C1', text: 'hi' } },
      ctx(),
    )
    expect(f.calls[0]!.url).toBe('https://slack.com/api/chat.postMessage')
  })

  it('appends query parameters on GET', async () => {
    const f = makeFakeFetch()
    const { tool } = withFakeFetch(f)
    await tool.execute(
      { method: 'GET', path: 'conversations.history', query: { channel: 'C1', limit: 50 } },
      ctx(),
    )
    const url = f.calls[0]!.url
    expect(url.startsWith('https://slack.com/api/conversations.history?')).toBe(true)
    const qs = new URLSearchParams(url.split('?')[1] ?? '')
    expect(qs.get('channel')).toBe('C1')
    expect(qs.get('limit')).toBe('50')
  })

  it('attaches Bearer auth on every call', async () => {
    const f = makeFakeFetch()
    const { tool } = withFakeFetch(f)
    await tool.execute(
      { method: 'POST', path: 'chat.postMessage', body: { channel: 'C1', text: 'hi' } },
      ctx(),
    )
    const headers = f.calls[0]!.init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer xoxb-fake-token')
  })

  it('serializes the body as JSON on POST', async () => {
    const f = makeFakeFetch()
    const { tool } = withFakeFetch(f)
    await tool.execute(
      { method: 'POST', path: 'chat.postMessage', body: { channel: 'C1', text: 'hi' } },
      ctx(),
    )
    expect(f.calls[0]!.init.method).toBe('POST')
    expect(f.calls[0]!.init.body).toBe(JSON.stringify({ channel: 'C1', text: 'hi' }))
    const headers = f.calls[0]!.init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json; charset=utf-8')
  })
})

describe('slack_api: envelope handling', () => {
  it('returns parsed response on ok: true', async () => {
    const f = makeFakeFetch()
    f.setResponse(
      new Response(JSON.stringify({ ok: true, ts: '1715290000.000100', channel: 'C1' }), {
        status: 200,
      }),
    )
    const { tool } = withFakeFetch(f)
    const result = (await tool.execute(
      { method: 'POST', path: 'chat.postMessage', body: { channel: 'C1', text: 'hi' } },
      ctx(),
    )) as { ok: boolean; ts: string }
    expect(result.ok).toBe(true)
    expect(result.ts).toBe('1715290000.000100')
  })

  it('throws a clean error when ok: false with channel_not_found', async () => {
    const f = makeFakeFetch()
    f.setResponse(
      new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), { status: 200 }),
    )
    const { tool } = withFakeFetch(f)
    await expect(
      tool.execute(
        { method: 'POST', path: 'chat.postMessage', body: { channel: 'C1', text: 'hi' } },
        ctx(),
      ),
    ).rejects.toThrow(/channel not found/i)
  })

  it('maps missing_scope with needed/provided context', async () => {
    const f = makeFakeFetch()
    f.setResponse(
      new Response(
        JSON.stringify({
          ok: false,
          error: 'missing_scope',
          needed: 'channels:write',
          provided: 'channels:read',
        }),
        { status: 200 },
      ),
    )
    const { tool } = withFakeFetch(f)
    await expect(
      tool.execute(
        { method: 'POST', path: 'chat.postMessage', body: { channel: 'C1', text: 'hi' } },
        ctx(),
      ),
    ).rejects.toThrow(/channels:write.*channels:read/)
  })

  it('maps invalid_auth to a token-rotation hint', async () => {
    const f = makeFakeFetch()
    f.setResponse(
      new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), { status: 200 }),
    )
    const { tool } = withFakeFetch(f)
    await expect(
      tool.execute(
        { method: 'POST', path: 'chat.postMessage', body: { channel: 'C1', text: 'hi' } },
        ctx(),
      ),
    ).rejects.toThrow(/invalid_auth.*regenerate/i)
  })
})

describe('slack_api: credentials', () => {
  it('throws SlackCredentialError when token is missing', async () => {
    delete process.env['_2200_SLACK_BOT_TOKEN']
    const f = makeFakeFetch()
    const { tool } = withFakeFetch(f)
    await expect(
      tool.execute(
        { method: 'POST', path: 'chat.postMessage', body: { channel: 'C1', text: 'hi' } },
        ctx(),
      ),
    ).rejects.toThrow(/Slack bot token is not configured/)
  })
})
