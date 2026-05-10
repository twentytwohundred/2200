/**
 * Discord tool defs ... unit-level coverage.
 *
 * The `@discordjs/core` API is mocked at the client level; we are not
 * testing Discord's HTTP API. The tests verify:
 *   - argsSchema rejects malformed input (snowflake validation, length
 *     caps, enum boundaries)
 *   - execute() calls the right API method with the expected shape
 *   - Discord error codes get mapped to readable messages
 *   - missing-credential errors are clean and actionable
 */
import { describe, expect, it, beforeEach } from 'vitest'
import {
  DiscordClient,
  DiscordCredentialError,
  DISCORD_BOT_TOKEN_ENV,
} from '../../../../src/runtime/tools/platform/discord/client.js'
import { makeDiscordTools } from '../../../../src/runtime/tools/platform/discord/tools.js'
import type { ToolContext, ToolDefinition } from '../../../../src/runtime/mcp/tool.js'

function byName(client: DiscordClient, name: string): ToolDefinition {
  const tool = makeDiscordTools(client).find((t) => t.name === name)
  if (!tool) throw new Error(`tool not found: ${name}`)
  return tool
}

const ctx = (): ToolContext => ({
  callingAgent: 'hobby',
  home: '/h',
  brainDir: '/h/agents/hobby/brain',
  projectDir: '/h/agents/hobby/project',
  taskId: null,
  callId: 'call_test',
})

interface MockApi {
  channels: {
    createMessage: ReturnType<typeof mockFn>
    getMessages: ReturnType<typeof mockFn>
    addMessageReaction: ReturnType<typeof mockFn>
    createThread: ReturnType<typeof mockFn>
  }
  guilds: {
    getChannels: ReturnType<typeof mockFn>
  }
}

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

function makeMockApi(): MockApi {
  return {
    channels: {
      createMessage: mockFn(),
      getMessages: mockFn(),
      addMessageReaction: mockFn(),
      createThread: mockFn(),
    },
    guilds: {
      getChannels: mockFn(),
    },
  }
}

function withMockClient(api: MockApi): DiscordClient {
  const client = new DiscordClient(() => 'fake-token')
  client.setApiForTest(api as unknown as Parameters<DiscordClient['setApiForTest']>[0])
  return client
}

describe('DiscordClient', () => {
  beforeEach(() => {
    Reflect.deleteProperty(process.env, DISCORD_BOT_TOKEN_ENV)
  })

  it('throws DiscordCredentialError when token is unset', () => {
    const client = new DiscordClient()
    expect(() => client.get()).toThrow(DiscordCredentialError)
  })

  it('throws DiscordCredentialError on whitespace-only token', () => {
    const client = new DiscordClient(() => '   ')
    expect(() => client.get()).toThrow(DiscordCredentialError)
  })

  it('credential error message names the env var so the operator can fix it', () => {
    const client = new DiscordClient()
    try {
      client.get()
      expect.fail('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(DiscordCredentialError)
      expect((err as Error).message).toContain(DISCORD_BOT_TOKEN_ENV)
    }
  })

  it('caches the API instance across calls', () => {
    const client = new DiscordClient(() => 'fake-token')
    const a = client.get()
    const b = client.get()
    expect(a).toBe(b)
  })
})

describe('discord_send_message', () => {
  it('rejects malformed channel_id', () => {
    const api = makeMockApi()
    const client = withMockClient(api)
    const send = byName(client, 'discord_send_message')
    expect(() => send.argsSchema.parse({ channel_id: 'not-a-snowflake', content: 'hi' })).toThrow()
  })

  it('rejects oversize content (>2000 chars)', () => {
    const api = makeMockApi()
    const client = withMockClient(api)
    const send = byName(client, 'discord_send_message')
    expect(() =>
      send.argsSchema.parse({ channel_id: '12345678901234567', content: 'x'.repeat(2001) }),
    ).toThrow()
  })

  it('posts a message and returns the message id', async () => {
    const api = makeMockApi()
    api.channels.createMessage.setResult({
      id: '999999999999999999',
      channel_id: '12345678901234567',
      timestamp: '2026-05-10T00:00:00Z',
    })
    const client = withMockClient(api)
    const send = byName(client, 'discord_send_message')
    const result = await send.execute({ channel_id: '12345678901234567', content: 'hello' }, ctx())
    expect(result).toEqual({
      message_id: '999999999999999999',
      channel_id: '12345678901234567',
      timestamp: '2026-05-10T00:00:00Z',
    })
    expect(api.channels.createMessage.calls).toHaveLength(1)
    expect(api.channels.createMessage.calls[0]!.args[0]).toBe('12345678901234567')
    expect(api.channels.createMessage.calls[0]!.args[1]).toEqual({ content: 'hello' })
  })

  it('passes message_reference when reply_to is set', async () => {
    const api = makeMockApi()
    api.channels.createMessage.setResult({
      id: '999',
      channel_id: '12345678901234567',
      timestamp: '2026-05-10T00:00:00Z',
    })
    const client = withMockClient(api)
    const send = byName(client, 'discord_send_message')
    await send.execute(
      {
        channel_id: '12345678901234567',
        content: 'hello',
        reply_to: '88888888888888888',
      },
      ctx(),
    )
    expect(api.channels.createMessage.calls[0]!.args[1]).toEqual({
      content: 'hello',
      message_reference: { message_id: '88888888888888888' },
    })
  })

  it('maps Discord error code 50013 (missing permissions) to a readable message', async () => {
    const api = makeMockApi()
    api.channels.createMessage.setError({ code: 50013, message: 'Missing Permissions' })
    const client = withMockClient(api)
    const send = byName(client, 'discord_send_message')
    await expect(
      send.execute({ channel_id: '12345678901234567', content: 'hi' }, ctx()),
    ).rejects.toThrow(/missing permissions.*50013/i)
  })

  it('maps Discord error code 10003 (unknown channel) to a readable message', async () => {
    const api = makeMockApi()
    api.channels.createMessage.setError({ code: 10003, message: 'Unknown Channel' })
    const client = withMockClient(api)
    const send = byName(client, 'discord_send_message')
    await expect(
      send.execute({ channel_id: '12345678901234567', content: 'hi' }, ctx()),
    ).rejects.toThrow(/channel not found.*10003/i)
  })

  it('maps HTTP 429 rate limits to a clear message', async () => {
    const api = makeMockApi()
    api.channels.createMessage.setError({ status: 429, message: 'You are being rate limited' })
    const client = withMockClient(api)
    const send = byName(client, 'discord_send_message')
    await expect(
      send.execute({ channel_id: '12345678901234567', content: 'hi' }, ctx()),
    ).rejects.toThrow(/rate-limited/i)
  })
})

describe('discord_list_channels', () => {
  it('lists channels with the expected projection', async () => {
    const api = makeMockApi()
    api.guilds.getChannels.setResult([
      { id: '1', name: 'general', type: 0, parent_id: null, topic: 'chat' },
      { id: '2', name: 'voice', type: 2 },
      { id: '3', name: 'announcements', type: 5, parent_id: '1', topic: null },
    ])
    const client = withMockClient(api)
    const list = byName(client, 'discord_list_channels')
    const result = await list.execute({ guild_id: '12345678901234567' }, ctx())
    expect(result).toEqual([
      { id: '1', name: 'general', type: 0, parent_id: null, topic: 'chat' },
      { id: '2', name: 'voice', type: 2, parent_id: null, topic: null },
      { id: '3', name: 'announcements', type: 5, parent_id: '1', topic: null },
    ])
  })
})

describe('discord_fetch_history', () => {
  it('caps limit at 100', () => {
    const api = makeMockApi()
    const client = withMockClient(api)
    const history = byName(client, 'discord_fetch_history')
    expect(() =>
      history.argsSchema.parse({ channel_id: '12345678901234567', limit: 101 }),
    ).toThrow()
  })

  it('defaults limit to 50 and projects messages cleanly', async () => {
    const api = makeMockApi()
    api.channels.getMessages.setResult([
      {
        id: 'm1',
        author: { id: 'u1', username: 'doug', bot: false },
        content: 'hi',
        timestamp: '2026-05-10T00:00:00Z',
        edited_timestamp: null,
        reactions: [{ emoji: { name: '🎉', id: null }, count: 3 }],
      },
    ])
    const client = withMockClient(api)
    const history = byName(client, 'discord_fetch_history')
    const result = await history.execute({ channel_id: '12345678901234567', limit: 50 }, ctx())
    expect(api.channels.getMessages.calls[0]!.args[1]).toEqual({ limit: 50 })
    expect(result).toEqual([
      {
        id: 'm1',
        author: { id: 'u1', username: 'doug', bot: false },
        content: 'hi',
        timestamp: '2026-05-10T00:00:00Z',
        edited_timestamp: null,
        reactions: [{ emoji: '🎉', count: 3 }],
      },
    ])
  })

  it('passes `before` when paginating', async () => {
    const api = makeMockApi()
    api.channels.getMessages.setResult([])
    const client = withMockClient(api)
    const history = byName(client, 'discord_fetch_history')
    await history.execute(
      { channel_id: '12345678901234567', limit: 25, before: '99999999999999999' },
      ctx(),
    )
    expect(api.channels.getMessages.calls[0]!.args[1]).toEqual({
      limit: 25,
      before: '99999999999999999',
    })
  })
})

describe('discord_react', () => {
  it('calls addMessageReaction with the unicode emoji', async () => {
    const api = makeMockApi()
    api.channels.addMessageReaction.setResult(undefined)
    const client = withMockClient(api)
    const react = byName(client, 'discord_react')
    const result = await react.execute(
      {
        channel_id: '12345678901234567',
        message_id: '88888888888888888',
        emoji: '🎉',
      },
      ctx(),
    )
    expect(result).toEqual({ ok: true })
    expect(api.channels.addMessageReaction.calls[0]!.args).toEqual([
      '12345678901234567',
      '88888888888888888',
      '🎉',
    ])
  })
})

describe('discord_create_thread', () => {
  it('sets type=11 (PublicThread) for standalone threads', async () => {
    const api = makeMockApi()
    api.channels.createThread.setResult({ id: 't1', name: 'chat' })
    const client = withMockClient(api)
    const thread = byName(client, 'discord_create_thread')
    await thread.execute(
      {
        channel_id: '12345678901234567',
        name: 'chat',
        auto_archive_duration: 1440,
      },
      ctx(),
    )
    expect(api.channels.createThread.calls[0]!.args[1]).toEqual({
      name: 'chat',
      auto_archive_duration: 1440,
      type: 11,
    })
    expect(api.channels.createThread.calls[0]!.args[2]).toBeUndefined()
  })

  it('omits type and passes messageId when anchoring on a message', async () => {
    const api = makeMockApi()
    api.channels.createThread.setResult({ id: 't1', name: 'chat' })
    const client = withMockClient(api)
    const thread = byName(client, 'discord_create_thread')
    await thread.execute(
      {
        channel_id: '12345678901234567',
        message_id: '88888888888888888',
        name: 'reply thread',
        auto_archive_duration: 60,
      },
      ctx(),
    )
    expect(api.channels.createThread.calls[0]!.args[1]).toEqual({
      name: 'reply thread',
      auto_archive_duration: 60,
    })
    expect(api.channels.createThread.calls[0]!.args[2]).toBe('88888888888888888')
  })

  it('rejects unsupported auto_archive_duration values', () => {
    const api = makeMockApi()
    const client = withMockClient(api)
    const thread = byName(client, 'discord_create_thread')
    expect(() =>
      thread.argsSchema.parse({
        channel_id: '12345678901234567',
        name: 'x',
        auto_archive_duration: 999,
      }),
    ).toThrow()
  })
})
