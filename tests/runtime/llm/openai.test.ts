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

  it('forwards tool messages as user messages tagged tool_result: (we use fenced ```tool blocks, not native function calling)', async () => {
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
      messages: [
        { role: 'user', content: 'fetch the notes' },
        { role: 'assistant', content: '```tool\n{"tool":"fs_read","args":{"path":"x"}}\n```' },
        { role: 'tool', content: '{"tool":"fs_read","ok":true,"output":"hi"}' },
      ],
    })
    expect((body as Record<string, unknown>)['messages']).toEqual([
      { role: 'user', content: 'fetch the notes' },
      { role: 'assistant', content: '```tool\n{"tool":"fs_read","args":{"path":"x"}}\n```' },
      { role: 'user', content: 'tool_result:\n{"tool":"fs_read","ok":true,"output":"hi"}' },
    ])
  })

  it('merges consecutive same-role messages (deepseek-reasoner requires strict alternation)', async () => {
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
      modelId: 'deepseek-reasoner',
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

  it('respects endpointUrl override (used for vendors with non-standard paths, e.g. Gemini)', async () => {
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
      baseUrl: 'https://generativelanguage.googleapis.com',
      endpointUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      providerName: 'gemini',
      fetchImpl,
    })
    await provider.complete({
      modelId: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
    })
    // endpointUrl wins; baseUrl-derived /v1/chat/completions is not used.
    expect(captured?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    )
    expect(provider.name).toBe('gemini')
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

  it('populates cachedTokens from DeepSeek-style prompt_cache_hit_tokens and normalizes inputTokens', async () => {
    // DeepSeek returns prompt_tokens as the TOTAL (cached + uncached).
    // The provider normalizes inputTokens to uncached only.
    const fetchImpl = mockFetch(() =>
      jsonResponse({
        id: 'cmpl-deepseek',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 2000,
          completion_tokens: 100,
          total_tokens: 2100,
          prompt_cache_hit_tokens: 1800,
        },
      }),
    )
    const provider = new OpenAIProvider({
      apiKey: 'sk',
      fetchImpl,
      providerName: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
    })
    const result = await provider.complete({
      modelId: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(result.costMetrics).toEqual({
      inputTokens: 200, // 2000 total - 1800 cached = 200 uncached
      outputTokens: 100,
      cachedTokens: 1800,
    })
  })

  it('populates cachedTokens from OpenAI-style prompt_tokens_details.cached_tokens', async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({
        id: 'cmpl-openai',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 50,
          total_tokens: 1050,
          prompt_tokens_details: { cached_tokens: 800 },
        },
      }),
    )
    const provider = new OpenAIProvider({ apiKey: 'sk', fetchImpl })
    const result = await provider.complete({
      modelId: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(result.costMetrics).toEqual({
      inputTokens: 200,
      outputTokens: 50,
      cachedTokens: 800,
    })
  })

  it('leaves cachedTokens absent when the vendor reports no cache stats', async () => {
    // Kimi-style: vanilla usage with no cache fields.
    const fetchImpl = mockFetch(() =>
      jsonResponse({
        id: 'cmpl-kimi',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 500, completion_tokens: 25, total_tokens: 525 },
      }),
    )
    const provider = new OpenAIProvider({ apiKey: 'sk', fetchImpl, providerName: 'kimi' })
    const result = await provider.complete({
      modelId: 'moonshot-v1-128k',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(result.costMetrics).toEqual({ inputTokens: 500, outputTokens: 25 })
    expect('cachedTokens' in result.costMetrics).toBe(false)
  })

  it('clamps inputTokens to non-negative when cached count exceeds prompt_tokens (paranoid edge)', async () => {
    // Vendor bug guard: if a provider reports cached > prompt, normalize to 0
    // rather than emit a negative number.
    const fetchImpl = mockFetch(() =>
      jsonResponse({
        id: 'cmpl-bug',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          total_tokens: 105,
          prompt_cache_hit_tokens: 200, // wonky vendor data
        },
      }),
    )
    const provider = new OpenAIProvider({ apiKey: 'sk', fetchImpl, providerName: 'deepseek' })
    const result = await provider.complete({
      modelId: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(result.costMetrics.inputTokens).toBe(0)
    expect(result.costMetrics.cachedTokens).toBe(200)
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
