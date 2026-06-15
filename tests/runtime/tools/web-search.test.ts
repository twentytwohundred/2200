/**
 * Tests for the web_search backend.
 *
 * Why this matters: web_search was a stub that returned nothing, so no Agent
 * could research. It's now backed by Brave. These pin: results parse into
 * the tool's shape (ranked), a missing key yields an actionable status (not
 * a silent empty), HTTP/network failures surface as status (never throw),
 * and maxResults is honored.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseBraveResults, searchWeb } from '../../../src/runtime/tools/web-search'

afterEach(() => {
  vi.unstubAllGlobals()
})

const braveBody = {
  web: {
    results: [
      { url: 'https://a.com', title: 'A', description: 'about a' },
      { url: 'https://b.com', title: 'B', description: 'about b' },
      { title: 'no url, dropped' },
      { url: 'https://c.com' }, // missing title/desc -> empty strings
    ],
  },
}

describe('parseBraveResults', () => {
  it('maps Brave results into ranked {url,title,snippet}, dropping urlless rows', () => {
    const got = parseBraveResults(braveBody, 10)
    expect(got).toEqual([
      { url: 'https://a.com', title: 'A', snippet: 'about a', rank: 1 },
      { url: 'https://b.com', title: 'B', snippet: 'about b', rank: 2 },
      { url: 'https://c.com', title: '', snippet: '', rank: 3 },
    ])
  })

  it('honors maxResults', () => {
    expect(parseBraveResults(braveBody, 1)).toHaveLength(1)
  })

  it('returns [] for malformed shapes', () => {
    expect(parseBraveResults(null, 5)).toEqual([])
    expect(parseBraveResults({}, 5)).toEqual([])
    expect(parseBraveResults({ web: { results: 'nope' } }, 5)).toEqual([])
  })
})

describe('searchWeb', () => {
  it('returns an actionable not-configured status when no key is set', async () => {
    const out = await searchWeb('anything', 5, {})
    expect(out.provider).toBeNull()
    expect(out.results).toEqual([])
    expect(out.status).toMatch(/BRAVE_API_KEY/)
    expect(out.status).toMatch(/brave\.com\/search\/api/)
  })

  it('queries Brave with the key and returns parsed results', async () => {
    const fetchMock = vi.fn((url: unknown, init: unknown): Promise<Response> => {
      // assert the key header + query are sent
      const headers = (init as { headers: Record<string, string> }).headers
      expect(headers['x-subscription-token']).toBe('test-key')
      expect(String(url)).toContain('q=ai+agents')
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(braveBody),
        text: () => Promise.resolve(''),
      } as unknown as Response)
    })
    vi.stubGlobal('fetch', fetchMock)
    const out = await searchWeb('ai agents', 5, { BRAVE_API_KEY: 'test-key' })
    expect(out.provider).toBe('brave')
    expect(out.results.map((r) => r.url)).toEqual([
      'https://a.com',
      'https://b.com',
      'https://c.com',
    ])
    expect(out.status).toMatch(/ok \(3 results/)
  })

  it('surfaces an HTTP error as status, never throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (): Promise<Response> =>
          Promise.resolve({
            ok: false,
            status: 429,
            text: () => Promise.resolve('rate limited'),
            json: () => Promise.resolve({}),
          } as unknown as Response),
      ),
    )
    const out = await searchWeb('q', 5, { BRAVE_API_KEY: 'k' })
    expect(out.results).toEqual([])
    expect(out.status).toMatch(/HTTP 429/)
  })

  it('surfaces a network failure as status, never throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
    )
    const out = await searchWeb('q', 5, { BRAVE_API_KEY: 'k' })
    expect(out.results).toEqual([])
    expect(out.status).toMatch(/request failed: ECONNREFUSED/)
  })
})
