/**
 * Tests for the OpenAIProvider.
 */
import { describe, expect, it } from 'vitest'
import { OpenAIProvider } from '../../../src/runtime/llm/openai.js'

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

describe('OpenAIProvider request shape', () => {
  it('hits POST /v1/chat/completions with Bearer auth', async () => {
    let captured: { url: string; init: RequestInit } | undefined
    const fetchImpl = mockFetch((url, init) => {
      captured = { url, init }
      return jsonResponse({
        id: 'chatcmpl-1',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      })
    })
    const provider = new OpenAIProvider({ apiKey: 'sk-test', fetchImpl })
    await provider.complete({
      modelId: 'gpt-5-4',
      messages: [{ role: 'user', content: 'hello' }],
    })
    expect(captured?.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(captured?.init.method).toBe('POST')
    expect((captured?.init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer sk-test',
    )
  })

  it('places systemPrompt as the first system message', async () => {
    let body: unknown
    const fetchImpl = mockFetch((_, init) => {
      body = JSON.parse(init.body as string)
      return jsonResponse({
        id: 'x',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    })
    const provider = new OpenAIProvider({ apiKey: 'sk', fetchImpl })
    await provider.complete({
      modelId: 'gpt-5-4',
      systemPrompt: 'system text',
      messages: [{ role: 'user', content: 'hi' }],
    })
    const messages = (body as Record<string, unknown>)['messages']
    expect(messages).toEqual([
      { role: 'system', content: 'system text' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('respects baseUrl override (used for openai-compatible vendors)', async () => {
    let captured: { url: string; init: RequestInit } | undefined
    const fetchImpl = mockFetch((url, init) => {
      captured = { url, init }
      return jsonResponse({
        id: 'x',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    })
    const provider = new OpenAIProvider({
      apiKey: 'sk',
      baseUrl: 'https://api.deepseek.com',
      providerName: 'deepseek',
      fetchImpl,
    })
    await provider.complete({
      modelId: 'v4-pro',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(captured?.url).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(provider.name).toBe('deepseek')
  })
})

describe('OpenAIProvider response parsing', () => {
  it('returns text + costMetrics + finishReason', async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({
        id: 'chatcmpl-2',
        choices: [{ message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 },
      }),
    )
    const provider = new OpenAIProvider({ apiKey: 'sk', fetchImpl })
    const result = await provider.complete({
      modelId: 'gpt-5-4',
      messages: [{ role: 'user', content: 'ping' }],
    })
    expect(result.text).toBe('pong')
    expect(result.costMetrics).toEqual({ inputTokens: 7, outputTokens: 1 })
    expect(result.finishReason).toBe('stop')
    expect(result.providerResponseId).toBe('chatcmpl-2')
  })

  it('treats null content as empty string', async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({
        id: 'x',
        choices: [{ message: { role: 'assistant', content: null }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
      }),
    )
    const provider = new OpenAIProvider({ apiKey: 'sk', fetchImpl })
    const result = await provider.complete({
      modelId: 'gpt-5-4',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(result.text).toBe('')
    expect(result.finishReason).toBe('tool_calls')
  })

  it('rejects empty choices array', async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({
        id: 'x',
        choices: [],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
    )
    const provider = new OpenAIProvider({ apiKey: 'sk', fetchImpl })
    await expect(
      provider.complete({ modelId: 'gpt-5-4', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
})

describe('OpenAIProvider error mapping', () => {
  it.each([
    [401, 'AUTH_FAILED'],
    [403, 'AUTH_FAILED'],
    [404, 'MODEL_NOT_FOUND'],
    [429, 'RATE_LIMITED'],
    [500, 'PROVIDER_ERROR'],
    [502, 'PROVIDER_ERROR'],
    [400, 'PROVIDER_ERROR'],
  ])('maps HTTP %d to %s', async (status, code) => {
    const fetchImpl = mockFetch(() => new Response('err', { status }))
    const provider = new OpenAIProvider({ apiKey: 'sk', fetchImpl })
    await expect(
      provider.complete({ modelId: 'gpt-5-4', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ code })
  })
})
