/**
 * Unit tests for `validateProviderKey`.
 *
 * Hits `GET /v1/models` via an injected fetch and classifies the
 * response. The first-run wizard depends on this classification to
 * decide whether to reject (auth_failed), soft-yes (network_error /
 * unexpected), or save (ok). Each branch is exercised here so a
 * provider returning an unusual response doesn't change the wizard's
 * UX silently.
 */
import { describe, expect, it } from 'vitest'
import {
  validateProviderKey,
  validateLocalEndpoint,
} from '../../../src/runtime/llm/validate-key.js'
import type { ProviderCatalogEntry } from '../../../src/runtime/llm/registry.js'

function capturingFetch(status: number): {
  fetchImpl: typeof fetch
  captured: { url: string | null; init: RequestInit | null }
} {
  const captured: { url: string | null; init: RequestInit | null } = { url: null, init: null }
  const fetchImpl = ((url: string, init?: RequestInit) => {
    captured.url = url
    captured.init = init ?? null
    return Promise.resolve(new Response('{"data":[]}', { status }))
  }) as unknown as typeof fetch
  return { fetchImpl, captured }
}

function anthropic(): ProviderCatalogEntry {
  return {
    name: 'anthropic',
    label: 'Anthropic',
    defaultEnvKey: 'ANTHROPIC_API_KEY',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    baseUrlEditable: false,
    baseUrlEnvKey: '',
    keyOptional: false,
    category: 'api-key',
  }
}

function openai(): ProviderCatalogEntry {
  return {
    name: 'openai',
    label: 'OpenAI',
    defaultEnvKey: 'OPENAI_API_KEY',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com',
    baseUrlEditable: false,
    baseUrlEnvKey: '',
    keyOptional: false,
    category: 'api-key',
  }
}

describe('validateProviderKey', () => {
  it('returns ok on 2xx', async () => {
    const captured: { url: string | null; init: RequestInit | null } = {
      url: null,
      init: null,
    }
    const fakeFetch: typeof fetch = ((url: string, init?: RequestInit) => {
      captured.url = url
      captured.init = init ?? null
      return Promise.resolve(new Response('{"data":[]}', { status: 200 }))
    }) as unknown as typeof fetch
    const result = await validateProviderKey({
      provider: openai(),
      apiKey: 'sk-test',
      fetchImpl: fakeFetch,
    })
    expect(result.ok).toBe(true)
    expect(captured.url).toBe('https://api.openai.com/v1/models')
    const headers = (captured.init?.headers ?? {}) as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sk-test')
  })

  it('uses x-api-key + anthropic-version for anthropic', async () => {
    const captured: { init: RequestInit | null } = { init: null }
    const fakeFetch: typeof fetch = ((_url: string, init?: RequestInit) => {
      captured.init = init ?? null
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch
    await validateProviderKey({
      provider: anthropic(),
      apiKey: 'sk-ant-foo',
      fetchImpl: fakeFetch,
    })
    const headers = (captured.init?.headers ?? {}) as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-ant-foo')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['Authorization']).toBeUndefined()
  })

  it('classifies 401 as auth_failed', async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(new Response('{"error":"bad key"}', { status: 401 }))
    const result = await validateProviderKey({
      provider: openai(),
      apiKey: 'sk-bad',
      fetchImpl: fakeFetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('auth_failed')
      if (result.reason === 'auth_failed') {
        expect(result.status).toBe(401)
        expect(result.message).toContain('bad key')
      }
    }
  })

  it('classifies 403 as auth_failed', async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(new Response('forbidden', { status: 403 }))
    const result = await validateProviderKey({
      provider: openai(),
      apiKey: 'sk-forbidden',
      fetchImpl: fakeFetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('auth_failed')
  })

  it('classifies thrown fetch as network_error', async () => {
    const fakeFetch: typeof fetch = () => Promise.reject(new Error('ENOTFOUND api.example.com'))
    const result = await validateProviderKey({
      provider: openai(),
      apiKey: 'sk-anything',
      fetchImpl: fakeFetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('network_error')
      if (result.reason === 'network_error') {
        expect(result.message).toContain('ENOTFOUND')
      }
    }
  })

  it('classifies 5xx as unexpected', async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(new Response('upstream error', { status: 502 }))
    const result = await validateProviderKey({
      provider: openai(),
      apiKey: 'sk-x',
      fetchImpl: fakeFetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('unexpected')
      if (result.reason === 'unexpected') expect(result.status).toBe(502)
    }
  })

  it('rejects empty keys without making a request', async () => {
    let called = false
    const fakeFetch: typeof fetch = () => {
      called = true
      return Promise.resolve(new Response('{}', { status: 200 }))
    }
    const result = await validateProviderKey({
      provider: openai(),
      apiKey: '   ',
      fetchImpl: fakeFetch,
    })
    expect(called).toBe(false)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('auth_failed')
  })

  it('truncates long error bodies to 400 chars', async () => {
    const longBody = 'x'.repeat(1000)
    const fakeFetch: typeof fetch = () => Promise.resolve(new Response(longBody, { status: 401 }))
    const result = await validateProviderKey({
      provider: openai(),
      apiKey: 'sk-x',
      fetchImpl: fakeFetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok && result.reason === 'auth_failed') {
      // 400 chars + the '...' suffix.
      expect(result.message.length).toBeLessThanOrEqual(403)
      expect(result.message.endsWith('...')).toBe(true)
    }
  })
})

describe('validateLocalEndpoint', () => {
  it('keyless: sends NO Authorization header and hits <base>/models when base ends in /v1', async () => {
    const { fetchImpl, captured } = capturingFetch(200)
    const result = await validateLocalEndpoint({
      baseUrl: 'http://100.64.0.5:11434/v1',
      fetchImpl,
    })
    expect(result.ok).toBe(true)
    expect(captured.url).toBe('http://100.64.0.5:11434/v1/models') // not /v1/v1/models
    const headers = (captured.init?.headers ?? {}) as Record<string, string>
    expect(headers['Authorization']).toBeUndefined() // keyless ... the tailnet is the auth
  })

  it('appends /v1/models when the base URL has no /v1 suffix', async () => {
    const { fetchImpl, captured } = capturingFetch(200)
    await validateLocalEndpoint({ baseUrl: 'http://localhost:8000', fetchImpl })
    expect(captured.url).toBe('http://localhost:8000/v1/models')
  })

  it('sends a Bearer token when a key IS provided', async () => {
    const { fetchImpl, captured } = capturingFetch(200)
    await validateLocalEndpoint({ baseUrl: 'http://host:11434/v1', apiKey: 'sk-local', fetchImpl })
    const headers = (captured.init?.headers ?? {}) as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sk-local')
  })

  it('classifies 401 as auth_failed (the server wants a key)', async () => {
    const { fetchImpl } = capturingFetch(401)
    const result = await validateLocalEndpoint({ baseUrl: 'http://host:11434/v1', fetchImpl })
    expect(result).toMatchObject({ ok: false, reason: 'auth_failed', status: 401 })
  })

  it('classifies a fetch throw as network_error (server not up)', async () => {
    const fetchImpl = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch
    const result = await validateLocalEndpoint({ baseUrl: 'http://host:11434/v1', fetchImpl })
    expect(result).toMatchObject({ ok: false, reason: 'network_error' })
  })
})
