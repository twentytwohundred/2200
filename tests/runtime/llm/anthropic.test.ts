/**
 * Tests for the AnthropicProvider.
 *
 * Uses an injected fetch mock to assert request shape and to return
 * canned responses. No real network calls.
 */
import { describe, expect, it } from 'vitest'
import { AnthropicProvider } from '../../../src/runtime/llm/anthropic.js'
import { LlmError } from '../../../src/runtime/llm/errors.js'

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
    return handler(urlStr, init ?? {})
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('AnthropicProvider request shape', () => {
  it('hits POST /v1/messages with x-api-key + anthropic-version headers', async () => {
    let captured: { url: string; init: RequestInit } | undefined
    const fetchImpl = mockFetch((url, init) => {
      captured = { url, init }
      return jsonResponse({
        id: 'msg_abc',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 3 },
      })
    })
    const provider = new AnthropicProvider({ apiKey: 'sk-test', fetchImpl })
    await provider.complete({
      modelId: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'hello' }],
    })
    expect(captured?.url).toBe('https://api.anthropic.com/v1/messages')
    expect(captured?.init.method).toBe('POST')
    const headers = captured?.init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-test')
    expect(headers['anthropic-version']).toBe('2023-06-01')
  })

  it('includes systemPrompt in the system field, not in messages', async () => {
    let body: unknown
    const fetchImpl = mockFetch((_, init) => {
      body = JSON.parse(init.body as string)
      return jsonResponse({
        id: 'msg_x',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    })
    const provider = new AnthropicProvider({ apiKey: 'sk', fetchImpl })
    await provider.complete({
      modelId: 'claude-opus-4-7',
      systemPrompt: 'You are helpful.',
      messages: [{ role: 'user', content: 'hi' }],
    })
    const b = body as Record<string, unknown>
    expect(b['system']).toBe('You are helpful.')
    expect(b['messages']).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('drops system messages from the messages array (system goes in the top-level system field)', async () => {
    let body: unknown
    const fetchImpl = mockFetch((_, init) => {
      body = JSON.parse(init.body as string)
      return jsonResponse({
        id: 'msg_x',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    })
    const provider = new AnthropicProvider({ apiKey: 'sk', fetchImpl })
    await provider.complete({
      modelId: 'claude-opus-4-7',
      messages: [
        { role: 'system', content: 'ignored' },
        { role: 'user', content: 'hi' },
      ],
    })
    expect((body as Record<string, unknown>)['messages']).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('forwards tool messages to Anthropic as user messages tagged tool_result:', async () => {
    // Without this, multi-turn tool use is broken: the model sees its
    // own tool call but never the result, and the next turn returns
    // empty / confused output. This test pins the contract.
    let body: unknown
    const fetchImpl = mockFetch((_, init) => {
      body = JSON.parse(init.body as string)
      return jsonResponse({
        id: 'msg_x',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    })
    const provider = new AnthropicProvider({ apiKey: 'sk', fetchImpl })
    await provider.complete({
      modelId: 'claude-opus-4-7',
      messages: [
        { role: 'user', content: 'fetch the notes' },
        { role: 'assistant', content: '```tool\n{"tool":"fs.read","args":{"path":"x"}}\n```' },
        { role: 'tool', content: '{"tool":"fs.read","ok":true,"output":"hi"}' },
      ],
    })
    expect((body as Record<string, unknown>)['messages']).toEqual([
      { role: 'user', content: 'fetch the notes' },
      { role: 'assistant', content: '```tool\n{"tool":"fs.read","args":{"path":"x"}}\n```' },
      { role: 'user', content: 'tool_result:\n{"tool":"fs.read","ok":true,"output":"hi"}' },
    ])
  })

  it('merges consecutive same-role messages so Anthropic does not reject role repetitions', async () => {
    let body: unknown
    const fetchImpl = mockFetch((_, init) => {
      body = JSON.parse(init.body as string)
      return jsonResponse({
        id: 'msg_x',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    })
    const provider = new AnthropicProvider({ apiKey: 'sk', fetchImpl })
    await provider.complete({
      modelId: 'claude-opus-4-7',
      messages: [
        { role: 'user', content: 'do two things' },
        { role: 'assistant', content: 'calling two tools' },
        { role: 'tool', content: '{"tool":"a","ok":true}' },
        { role: 'tool', content: '{"tool":"b","ok":true}' },
      ],
    })
    expect((body as Record<string, unknown>)['messages']).toEqual([
      { role: 'user', content: 'do two things' },
      { role: 'assistant', content: 'calling two tools' },
      {
        role: 'user',
        content: 'tool_result:\n{"tool":"a","ok":true}\n\ntool_result:\n{"tool":"b","ok":true}',
      },
    ])
  })
})

describe('AnthropicProvider response parsing', () => {
  it('joins multi-block text content', async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({
        id: 'msg_x',
        content: [
          { type: 'text', text: 'foo ' },
          { type: 'text', text: 'bar' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 3 },
      }),
    )
    const provider = new AnthropicProvider({ apiKey: 'sk', fetchImpl })
    const result = await provider.complete({
      modelId: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(result.text).toBe('foo bar')
    expect(result.costMetrics).toEqual({ inputTokens: 5, outputTokens: 3 })
    expect(result.providerResponseId).toBe('msg_x')
  })

  it('maps stop_reason to finishReason', async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({
        id: 'msg_x',
        content: [{ type: 'text', text: 'truncated' }],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    )
    const provider = new AnthropicProvider({ apiKey: 'sk', fetchImpl })
    const result = await provider.complete({
      modelId: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(result.finishReason).toBe('length')
  })

  it('populates cachedTokens from cache_read_input_tokens when present', async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({
        id: 'msg_cached',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 200, // already excludes cache hits per Anthropic's convention
          output_tokens: 50,
          cache_read_input_tokens: 1800,
        },
      }),
    )
    const provider = new AnthropicProvider({ apiKey: 'sk', fetchImpl })
    const result = await provider.complete({
      modelId: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(result.costMetrics).toEqual({
      inputTokens: 200,
      outputTokens: 50,
      cachedTokens: 1800,
    })
  })

  it('omits cachedTokens when the response does not include cache_read_input_tokens', async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({
        id: 'msg_x',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 3 },
      }),
    )
    const provider = new AnthropicProvider({ apiKey: 'sk', fetchImpl })
    const result = await provider.complete({
      modelId: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(result.costMetrics).toEqual({ inputTokens: 5, outputTokens: 3 })
    expect('cachedTokens' in result.costMetrics).toBe(false)
  })
})

describe('AnthropicProvider error mapping', () => {
  it('maps 401 to AUTH_FAILED', async () => {
    const fetchImpl = mockFetch(() => new Response('unauthorized', { status: 401 }))
    const provider = new AnthropicProvider({ apiKey: 'sk', fetchImpl })
    await expect(
      provider.complete({
        modelId: 'claude-opus-4-7',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ name: 'LlmError', code: 'AUTH_FAILED' })
  })

  it('maps 429 to RATE_LIMITED', async () => {
    const fetchImpl = mockFetch(() => new Response('slow down', { status: 429 }))
    const provider = new AnthropicProvider({ apiKey: 'sk', fetchImpl })
    await expect(
      provider.complete({
        modelId: 'claude-opus-4-7',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' })
  })

  it('maps 500 to PROVIDER_ERROR', async () => {
    const fetchImpl = mockFetch(() => new Response('boom', { status: 500 }))
    const provider = new AnthropicProvider({ apiKey: 'sk', fetchImpl })
    await expect(
      provider.complete({
        modelId: 'claude-opus-4-7',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
  })

  it('maps fetch failure to NETWORK_ERROR', async () => {
    const fetchImpl: typeof fetch = () => Promise.reject(new Error('econnrefused'))
    const provider = new AnthropicProvider({ apiKey: 'sk', fetchImpl })
    const err = await provider
      .complete({ modelId: 'claude-opus-4-7', messages: [{ role: 'user', content: 'hi' }] })
      .catch((e: unknown) => e as LlmError)
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).code).toBe('NETWORK_ERROR')
  })

  it('maps malformed JSON to INVALID_RESPONSE', async () => {
    const fetchImpl = mockFetch(
      () =>
        new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    const provider = new AnthropicProvider({ apiKey: 'sk', fetchImpl })
    await expect(
      provider.complete({
        modelId: 'claude-opus-4-7',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
})
