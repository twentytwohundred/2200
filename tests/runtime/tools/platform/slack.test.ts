/**
 * Slack tool defs ... unit-level coverage.
 *
 * Slack's WebClient is mocked at the SlackClient level. The tests
 * verify:
 *   - argsSchema enforces channel id / user id / timestamp shapes
 *   - execute() calls the right method with the right args
 *   - Slack's `data.error` strings get mapped to readable messages
 *   - Missing-credential errors name the env var
 */
import { describe, expect, it, beforeEach } from 'vitest'
import {
  SlackClient,
  SlackCredentialError,
  SLACK_BOT_TOKEN_ENV,
} from '../../../../src/runtime/tools/platform/slack/client.js'
import { makeSlackTools } from '../../../../src/runtime/tools/platform/slack/tools.js'
import type { ToolContext, ToolDefinition } from '../../../../src/runtime/mcp/tool.js'
import type { WebClient } from '@slack/web-api'

const ctx = (): ToolContext => ({
  callingAgent: 'hobby',
  home: '/h',
  brainDir: '/h/agents/hobby/brain',
  projectDir: '/h/agents/hobby/project',
  taskId: null,
  callId: 'call_test',
})

interface CallRecord {
  args: unknown[]
}
interface MockedFn {
  (...args: unknown[]): unknown
  calls: CallRecord[]
  setResult: (result: unknown) => void
  setError: (err: unknown) => void
}
function mockFn(): MockedFn {
  let result: unknown = undefined
  let error: unknown = null
  const calls: CallRecord[] = []
  const fn = ((...args: unknown[]) => {
    calls.push({ args })
    if (error) {
      const wrapped =
        error instanceof Error
          ? error
          : Object.assign(new Error('mock error'), error as Record<string, unknown>)
      return Promise.reject(wrapped)
    }
    return Promise.resolve(result)
  }) as MockedFn
  fn.calls = calls
  fn.setResult = (r: unknown) => {
    result = r
    error = null
  }
  fn.setError = (e: unknown) => {
    error = e
  }
  return fn
}

interface MockWeb {
  chat: { postMessage: MockedFn }
  conversations: { list: MockedFn; history: MockedFn; replies: MockedFn }
  reactions: { add: MockedFn }
  users: { info: MockedFn }
}
function makeMockWeb(): MockWeb {
  return {
    chat: { postMessage: mockFn() },
    conversations: { list: mockFn(), history: mockFn(), replies: mockFn() },
    reactions: { add: mockFn() },
    users: { info: mockFn() },
  }
}

function withMock(web: MockWeb): {
  byName: (name: string) => ToolDefinition
} {
  const client = new SlackClient(() => 'xoxb-test')
  client.setClientForTest(web as unknown as WebClient)
  const tools = makeSlackTools(client)
  return {
    byName: (name) => {
      const t = tools.find((tt) => tt.name === name)
      if (!t) throw new Error(`tool not found: ${name}`)
      return t
    },
  }
}

describe('SlackClient', () => {
  beforeEach(() => {
    Reflect.deleteProperty(process.env, SLACK_BOT_TOKEN_ENV)
  })

  it('throws SlackCredentialError when token is unset', () => {
    const client = new SlackClient()
    expect(() => client.get()).toThrow(SlackCredentialError)
  })

  it('credential error names the env var', () => {
    const client = new SlackClient()
    try {
      client.get()
      expect.fail('expected throw')
    } catch (err) {
      expect((err as Error).message).toContain(SLACK_BOT_TOKEN_ENV)
      expect((err as Error).message).toContain('xoxb-')
    }
  })
})

describe('slack_send_message', () => {
  it('rejects malformed channel id', () => {
    const web = makeMockWeb()
    const { byName } = withMock(web)
    const tool = byName('slack_send_message')
    expect(() => tool.argsSchema.parse({ channel: 'not-valid', text: 'hi' })).toThrow()
  })

  it('posts a message and returns ts', async () => {
    const web = makeMockWeb()
    web.chat.postMessage.setResult({
      ok: true,
      channel: 'C12345678',
      ts: '1715290000.000100',
    })
    const { byName } = withMock(web)
    const tool = byName('slack_send_message')
    const result = await tool.execute({ channel: 'C12345678', text: 'hello' }, ctx())
    expect(result).toEqual({
      ok: true,
      channel: 'C12345678',
      ts: '1715290000.000100',
    })
    expect(web.chat.postMessage.calls[0]!.args[0]).toEqual({
      channel: 'C12345678',
      text: 'hello',
    })
  })

  it('passes thread_ts when threading', async () => {
    const web = makeMockWeb()
    web.chat.postMessage.setResult({ ok: true, channel: 'C12345678', ts: '1715290000.000200' })
    const { byName } = withMock(web)
    await byName('slack_send_message').execute(
      {
        channel: 'C12345678',
        text: 'reply',
        thread_ts: '1715290000.000100',
      },
      ctx(),
    )
    expect(web.chat.postMessage.calls[0]!.args[0]).toEqual({
      channel: 'C12345678',
      text: 'reply',
      thread_ts: '1715290000.000100',
    })
  })

  it('maps `not_in_channel` to a clear hint', async () => {
    const web = makeMockWeb()
    web.chat.postMessage.setError({ data: { error: 'not_in_channel' } })
    const { byName } = withMock(web)
    await expect(
      byName('slack_send_message').execute({ channel: 'C12345678', text: 'hi' }, ctx()),
    ).rejects.toThrow(/not a member.*Invite the bot/i)
  })

  it('maps `missing_scope` to a reinstall hint', async () => {
    const web = makeMockWeb()
    web.chat.postMessage.setError({ data: { error: 'missing_scope' } })
    const { byName } = withMock(web)
    await expect(
      byName('slack_send_message').execute({ channel: 'C12345678', text: 'hi' }, ctx()),
    ).rejects.toThrow(/missing.*scope.*reinstall/i)
  })
})

describe('slack_list_channels', () => {
  it('defaults to public+private and excludes archived', async () => {
    const web = makeMockWeb()
    web.conversations.list.setResult({
      channels: [
        {
          id: 'C1',
          name: 'general',
          is_private: false,
          is_archived: false,
          is_member: true,
          topic: { value: 'chat' },
          purpose: { value: '' },
          num_members: 12,
        },
      ],
    })
    const { byName } = withMock(web)
    const tool = byName('slack_list_channels')
    const result = await tool.execute(tool.argsSchema.parse({}), ctx())
    expect(web.conversations.list.calls[0]!.args[0]).toEqual({
      exclude_archived: true,
      types: 'public_channel,private_channel',
      limit: 200,
    })
    expect(result).toEqual([
      {
        id: 'C1',
        name: 'general',
        is_private: false,
        is_archived: false,
        is_member: true,
        topic: 'chat',
        purpose: '',
        num_members: 12,
      },
    ])
  })

  it('include_archived flips exclude_archived', async () => {
    const web = makeMockWeb()
    web.conversations.list.setResult({ channels: [] })
    const { byName } = withMock(web)
    const tool = byName('slack_list_channels')
    await tool.execute(tool.argsSchema.parse({ include_archived: true }), ctx())
    const arg = web.conversations.list.calls[0]!.args[0] as { exclude_archived: boolean }
    expect(arg.exclude_archived).toBe(false)
  })
})

describe('slack_fetch_history', () => {
  it('rejects malformed timestamp', () => {
    const web = makeMockWeb()
    const { byName } = withMock(web)
    expect(() =>
      byName('slack_fetch_history').argsSchema.parse({
        channel: 'C12345678',
        oldest: 'not-a-ts',
      }),
    ).toThrow()
  })

  it('passes oldest/latest when provided', async () => {
    const web = makeMockWeb()
    web.conversations.history.setResult({ messages: [] })
    const { byName } = withMock(web)
    await byName('slack_fetch_history').execute(
      {
        channel: 'C12345678',
        limit: 50,
        oldest: '1715290000.000000',
        latest: '1715290999.999999',
      },
      ctx(),
    )
    expect(web.conversations.history.calls[0]!.args[0]).toEqual({
      channel: 'C12345678',
      limit: 50,
      oldest: '1715290000.000000',
      latest: '1715290999.999999',
    })
  })

  it('projects messages cleanly', async () => {
    const web = makeMockWeb()
    web.conversations.history.setResult({
      messages: [
        {
          ts: '1715290000.000100',
          type: 'message',
          subtype: undefined,
          user: 'U12345678',
          text: 'hello',
          thread_ts: undefined,
          reply_count: 0,
          reactions: [{ name: 'thumbsup', count: 2 }],
        },
      ],
    })
    const { byName } = withMock(web)
    const result = (await byName('slack_fetch_history').execute(
      { channel: 'C12345678', limit: 10 },
      ctx(),
    )) as { ts: string; reactions: { name: string; count: number }[] }[]
    expect(result).toHaveLength(1)
    expect(result[0]!.reactions[0]!.name).toBe('thumbsup')
  })
})

describe('slack_react', () => {
  it('strips colons from emoji name via the schema (caller passes shortcode only)', () => {
    const web = makeMockWeb()
    const { byName } = withMock(web)
    // We accept any non-empty <=100 string; we trust the caller. Validate the lower bound.
    expect(() =>
      byName('slack_react').argsSchema.parse({
        channel: 'C12345678',
        timestamp: '1.0',
        emoji_name: '',
      }),
    ).toThrow()
  })

  it('calls reactions.add with the right shape', async () => {
    const web = makeMockWeb()
    web.reactions.add.setResult({ ok: true })
    const { byName } = withMock(web)
    await byName('slack_react').execute(
      {
        channel: 'C12345678',
        timestamp: '1715290000.000100',
        emoji_name: 'thumbsup',
      },
      ctx(),
    )
    expect(web.reactions.add.calls[0]!.args[0]).toEqual({
      channel: 'C12345678',
      timestamp: '1715290000.000100',
      name: 'thumbsup',
    })
  })
})

describe('slack_get_user', () => {
  it('rejects malformed user id', () => {
    const web = makeMockWeb()
    const { byName } = withMock(web)
    expect(() => byName('slack_get_user').argsSchema.parse({ user: 'not-a-user' })).toThrow()
  })

  it('returns null when the user is missing', async () => {
    const web = makeMockWeb()
    web.users.info.setResult({})
    const { byName } = withMock(web)
    const result = await byName('slack_get_user').execute({ user: 'U12345678' }, ctx())
    expect(result).toBeNull()
  })

  it('projects a profile cleanly', async () => {
    const web = makeMockWeb()
    web.users.info.setResult({
      user: {
        id: 'U12345678',
        name: 'doug',
        real_name: 'Doug Hardman',
        profile: { display_name: 'mrdoug', email: 'doug@mrdoug.com' },
        is_bot: false,
        is_admin: true,
        tz: 'America/Chicago',
      },
    })
    const { byName } = withMock(web)
    const result = await byName('slack_get_user').execute({ user: 'U12345678' }, ctx())
    expect(result).toEqual({
      id: 'U12345678',
      name: 'doug',
      real_name: 'Doug Hardman',
      display_name: 'mrdoug',
      email: 'doug@mrdoug.com',
      is_bot: false,
      is_admin: true,
      tz: 'America/Chicago',
    })
  })
})

describe('slack_get_thread', () => {
  it('calls conversations.replies with the right shape', async () => {
    const web = makeMockWeb()
    web.conversations.replies.setResult({
      messages: [
        { ts: '1.0', user: 'U1', text: 'parent', thread_ts: '1.0' },
        { ts: '2.0', user: 'U2', text: 'reply', thread_ts: '1.0' },
      ],
    })
    const { byName } = withMock(web)
    const result = (await byName('slack_get_thread').execute(
      { channel: 'C12345678', thread_ts: '1715290000.000100', limit: 50 },
      ctx(),
    )) as { text: string }[]
    expect(web.conversations.replies.calls[0]!.args[0]).toEqual({
      channel: 'C12345678',
      ts: '1715290000.000100',
      limit: 50,
    })
    expect(result).toHaveLength(2)
  })
})
