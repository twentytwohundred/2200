/**
 * Tests for the Codex Responses adapter (`openai-subscription`).
 *
 * The upstream wire is interim/unverified (needs a live ChatGPT
 * subscription token to confirm); what these tests pin is OUR half of
 * the contract: the request the adapter emits (headers, scaffold,
 * store/include flags, input mapping) and how it normalizes the two
 * response encodings (SSE terminal event, plain JSON) back into a
 * CompletionResponse. A verification-day wire correction should only
 * move `CODEX_RESPONSES_WIRE` and these assertions.
 */
import { describe, expect, it } from 'vitest'
import {
  CODEX_RESPONSES_WIRE,
  CodexResponsesProvider,
} from '../../../src/runtime/llm/codex-responses.js'
import { LlmError } from '../../../src/runtime/llm/errors.js'

const CREDS = { bearer: 'bearer-abc', accountId: 'acct-42' }

/** Fetch bodies in these tests are always JSON strings. */
function bodyText(init: RequestInit | undefined): string {
  return typeof init?.body === 'string' ? init.body : '{}'
}

function provider(opts: {
  response: Response
  onRequest?: (url: string, init: RequestInit | undefined) => void
}): CodexResponsesProvider {
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    opts.onRequest?.(url, init)
    return Promise.resolve(opts.response)
  }
  return new CodexResponsesProvider({
    credentialProvider: () => Promise.resolve(CREDS),
    fetchImpl,
  })
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function sseResponse(events: { type: string; response?: unknown }[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}`).join('\n\n') + '\n\ndata: [DONE]\n'
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const TERMINAL = {
  id: 'resp_123',
  status: 'completed',
  output: [
    { type: 'reasoning', content: [] },
    { type: 'message', content: [{ type: 'output_text', text: 'Hello from Codex' }] },
  ],
  usage: {
    input_tokens: 120,
    output_tokens: 8,
    input_tokens_details: { cached_tokens: 100 },
  },
}

describe('CodexResponsesProvider request shape', () => {
  it('sends the wire-config headers, scaffold, and constraint flags', async () => {
    let seenUrl = ''
    let seenHeaders: Record<string, string> = {}
    let seenBody: Record<string, unknown> = {}
    const p = provider({
      response: sseResponse([{ type: 'response.completed', response: TERMINAL }]),
      onRequest: (url, init) => {
        seenUrl = url
        seenHeaders = Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>),
        )
        seenBody = JSON.parse(bodyText(init)) as Record<string, unknown>
      },
    })
    await p.complete({
      modelId: 'gpt-5.1-codex',
      systemPrompt: 'You are Hobby.',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 500,
    })
    expect(seenUrl).toBe(CODEX_RESPONSES_WIRE.url)
    expect(seenHeaders['authorization']).toBe('Bearer bearer-abc')
    expect(seenHeaders['chatgpt-account-id']).toBe('acct-42')
    expect(seenHeaders['originator']).toBe('codex_cli_rs')
    expect(seenBody['model']).toBe('gpt-5.1-codex')
    expect(seenBody['instructions']).toBe(CODEX_RESPONSES_WIRE.instructions)
    expect(seenBody['store']).toBe(false)
    expect(seenBody['stream']).toBe(true)
    expect(seenBody['include']).toEqual(['reasoning.encrypted_content'])
    expect(seenBody['max_output_tokens']).toBe(500)
  })

  it('maps 2200 messages onto Responses input (developer system, tagged tool results)', async () => {
    let input: { role: string; content: { type: string; text: string }[] }[] = []
    const p = provider({
      response: sseResponse([{ type: 'response.completed', response: TERMINAL }]),
      onRequest: (_url, init) => {
        const body = JSON.parse(bodyText(init)) as { input: typeof input }
        input = body.input
      },
    })
    await p.complete({
      modelId: 'gpt-5.1-codex',
      systemPrompt: 'system stuff',
      messages: [
        { role: 'user', content: 'run the tool' },
        { role: 'assistant', content: 'running' },
        { role: 'tool', content: '{"ok":true}' },
      ],
    })
    expect(input.map((m) => m.role)).toEqual(['developer', 'user', 'assistant', 'user'])
    expect(input[0]?.content[0]?.text).toBe('system stuff')
    expect(input[2]?.content[0]?.type).toBe('output_text')
    expect(input[3]?.content[0]?.text).toBe('tool_result:\n{"ok":true}')
  })

  it('ignores native tool specs (fenced-text protocol is the tool path)', async () => {
    let body: Record<string, unknown> = {}
    const p = provider({
      response: sseResponse([{ type: 'response.completed', response: TERMINAL }]),
      onRequest: (_url, init) => {
        body = JSON.parse(bodyText(init)) as Record<string, unknown>
      },
    })
    await p.complete({
      modelId: 'gpt-5.1-codex',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'fs_read', description: 'read', parametersJsonSchema: {} }],
    })
    expect(body['tools']).toBeUndefined()
    expect(body['tool_choice']).toBeUndefined()
  })
})

describe('CodexResponsesProvider response normalization', () => {
  it('aggregates the SSE stream terminal event', async () => {
    const p = provider({
      response: sseResponse([
        { type: 'response.created', response: { id: 'resp_123', status: 'in_progress' } },
        { type: 'response.output_text.delta' },
        { type: 'response.completed', response: TERMINAL },
      ]),
    })
    const res = await p.complete({
      modelId: 'gpt-5.1-codex',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.text).toBe('Hello from Codex')
    expect(res.finishReason).toBe('stop')
    expect(res.providerResponseId).toBe('resp_123')
    // input_tokens is the TOTAL upstream; we report uncached + cached
    // separately (same normalization as the chat-completions adapter).
    expect(res.costMetrics).toEqual({ inputTokens: 20, outputTokens: 8, cachedTokens: 100 })
  })

  it('accepts a plain JSON response body (non-streaming answer)', async () => {
    const p = provider({ response: jsonResponse(200, TERMINAL) })
    const res = await p.complete({
      modelId: 'gpt-5.1-codex',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.text).toBe('Hello from Codex')
    expect(res.costMetrics.cachedTokens).toBe(100)
  })

  it('maps max_output_tokens exhaustion to finishReason length', async () => {
    const incomplete = {
      ...TERMINAL,
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
    }
    const p = provider({
      response: sseResponse([{ type: 'response.incomplete', response: incomplete }]),
    })
    const res = await p.complete({
      modelId: 'gpt-5.1-codex',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.finishReason).toBe('length')
  })

  it('maps auth failures to AUTH_FAILED', async () => {
    const p = provider({ response: jsonResponse(401, { detail: 'Unauthorized' }) })
    const err = await p
      .complete({ modelId: 'gpt-5.1-codex', messages: [{ role: 'user', content: 'hi' }] })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).code).toBe('AUTH_FAILED')
  })

  it('maps rate limits to RATE_LIMITED', async () => {
    const p = provider({ response: jsonResponse(429, { detail: 'slow down' }) })
    const err = await p
      .complete({ modelId: 'gpt-5.1-codex', messages: [{ role: 'user', content: 'hi' }] })
      .catch((e: unknown) => e)
    expect((err as LlmError).code).toBe('RATE_LIMITED')
  })

  it('fails loud on a stream with no terminal event', async () => {
    const p = provider({
      response: sseResponse([{ type: 'response.created', response: { id: 'x' } }]),
    })
    const err = await p
      .complete({ modelId: 'gpt-5.1-codex', messages: [{ role: 'user', content: 'hi' }] })
      .catch((e: unknown) => e)
    expect((err as LlmError).code).toBe('INVALID_RESPONSE')
  })

  it('surfaces a terminal failed event with the provider message', async () => {
    const failed = { id: 'resp_9', status: 'failed', error: { message: 'scaffold rejected' } }
    const p = provider({
      response: sseResponse([{ type: 'response.failed', response: failed }]),
    })
    const err = await p
      .complete({ modelId: 'gpt-5.1-codex', messages: [{ role: 'user', content: 'hi' }] })
      .catch((e: unknown) => e)
    expect((err as LlmError).code).toBe('PROVIDER_ERROR')
    expect((err as LlmError).message).toContain('scaffold rejected')
  })

  it('resolves credentials fresh on every request (rotating bearer)', async () => {
    const bearers: string[] = []
    let call = 0
    const fetchImpl: typeof fetch = (_input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      bearers.push(headers['authorization'] ?? '')
      return Promise.resolve(sseResponse([{ type: 'response.completed', response: TERMINAL }]))
    }
    const p = new CodexResponsesProvider({
      credentialProvider: () => {
        call += 1
        return Promise.resolve({ bearer: `bearer-${String(call)}`, accountId: 'acct' })
      },
      fetchImpl,
    })
    const req = { modelId: 'gpt-5.1-codex', messages: [{ role: 'user' as const, content: 'x' }] }
    await p.complete(req)
    await p.complete(req)
    expect(bearers).toEqual(['Bearer bearer-1', 'Bearer bearer-2'])
  })
})
