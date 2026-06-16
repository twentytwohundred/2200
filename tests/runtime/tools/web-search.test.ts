/**
 * Tests for the web_search backend.
 *
 * Why this matters: web_search was a stub that returned nothing, so no Agent
 * could research. It's now backed by Brave (default), Gemini grounding, and
 * Google. These pin: results parse into the tool's shape (ranked), a missing
 * key yields an actionable status (not a silent empty), HTTP/network failures
 * surface as status (never throw), provider resolution follows the documented
 * order, and maxResults is honored. The Gemini cases also pin the grounding
 * source→result mapping that OpenClaw parity depends on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseBraveResults,
  parseGeminiResults,
  parseGoogleResults,
  resolveSearchProvider,
  searchWeb,
} from '../../../src/runtime/tools/web-search'

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

// A representative Gemini google_search grounding response: the answer lives
// in content.parts[].text; the SOURCES we surface live in groundingMetadata,
// with groundingSupports linking answer spans back to chunk indices.
const geminiBody = {
  candidates: [
    {
      content: {
        role: 'model',
        parts: [{ text: 'Node.js 22 is the latest LTS. Node 20 is in maintenance.' }],
      },
      groundingMetadata: {
        groundingChunks: [
          { web: { uri: 'https://r/chunk0', title: 'nodejs.org' } },
          { web: { uri: 'https://r/chunk1', title: 'endoflife.date' } },
          { web: { uri: 'https://r/chunk2', title: 'github.com' } },
          { web: { title: 'no uri, dropped' } },
        ],
        groundingSupports: [
          { segment: { text: 'Node.js 22 is the latest LTS.' }, groundingChunkIndices: [0, 2] },
          { segment: { text: 'Node 20 is in maintenance.' }, groundingChunkIndices: [1] },
        ],
        webSearchQueries: ['latest node lts'],
      },
    },
  ],
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

  it('uses Google when only Google keys are configured', async () => {
    const googleBody = {
      items: [
        { link: 'https://g1.com', title: 'G1', snippet: 's1' },
        { link: 'https://g2.com', title: 'G2', snippet: 's2' },
      ],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn((url: unknown): Promise<Response> => {
        expect(String(url)).toContain('customsearch')
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(googleBody),
          text: () => Promise.resolve(''),
        } as unknown as Response)
      }),
    )
    const out = await searchWeb('q', 5, {
      GOOGLE_SEARCH_API_KEY: 'gk',
      GOOGLE_SEARCH_CX: 'cx123',
    })
    expect(out.provider).toBe('google')
    expect(out.results.map((r) => r.url)).toEqual(['https://g1.com', 'https://g2.com'])
  })

  it('uses Gemini grounding when a Gemini key is configured', async () => {
    const fetchMock = vi.fn((url: unknown, init: unknown): Promise<Response> => {
      expect(String(url)).toContain('generativelanguage.googleapis.com')
      expect(String(url)).toContain('key=gk')
      const i = init as { method: string; body: string }
      expect(i.method).toBe('POST')
      expect(i.body).toContain('google_search')
      expect(i.body).toContain('node lts')
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(geminiBody),
        text: () => Promise.resolve(''),
      } as unknown as Response)
    })
    vi.stubGlobal('fetch', fetchMock)
    const out = await searchWeb('node lts', 5, { GEMINI_SEARCH_API_KEY: 'gk' })
    expect(out.provider).toBe('gemini')
    expect(out.results.map((r) => r.url)).toEqual([
      'https://r/chunk0',
      'https://r/chunk1',
      'https://r/chunk2',
    ])
    expect(out.results[0]?.snippet).toBe('Node.js 22 is the latest LTS.')
    expect(out.status).toMatch(/ok \(3 results via gemini/)
  })

  it('surfaces a Gemini API error message (e.g. API disabled) as status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (): Promise<Response> =>
          Promise.resolve({
            ok: false,
            status: 403,
            text: () =>
              Promise.resolve(
                JSON.stringify({
                  error: { code: 403, message: 'Generative Language API has not been used' },
                }),
              ),
            json: () => Promise.resolve({}),
          } as unknown as Response),
      ),
    )
    const out = await searchWeb('q', 5, { GEMINI_SEARCH_API_KEY: 'gk' })
    expect(out.provider).toBe('gemini')
    expect(out.results).toEqual([])
    expect(out.status).toMatch(/HTTP 403/)
    expect(out.status).toMatch(/Generative Language API/)
  })
})

describe('resolveSearchProvider', () => {
  it('prefers Brave by default, then Google, then null', () => {
    expect(resolveSearchProvider({ BRAVE_API_KEY: 'b' })).toBe('brave')
    expect(resolveSearchProvider({ GOOGLE_SEARCH_API_KEY: 'g', GOOGLE_SEARCH_CX: 'c' })).toBe(
      'google',
    )
    expect(
      resolveSearchProvider({
        BRAVE_API_KEY: 'b',
        GOOGLE_SEARCH_API_KEY: 'g',
        GOOGLE_SEARCH_CX: 'c',
      }),
    ).toBe('brave')
    expect(resolveSearchProvider({})).toBeNull()
  })

  it('honors a pinned provider when its key is present, else falls through', () => {
    expect(
      resolveSearchProvider({
        WEB_SEARCH_PROVIDER: 'google',
        BRAVE_API_KEY: 'b',
        GOOGLE_SEARCH_API_KEY: 'g',
        GOOGLE_SEARCH_CX: 'c',
      }),
    ).toBe('google')
    // pinned google but no google keys -> fall through to brave
    expect(resolveSearchProvider({ WEB_SEARCH_PROVIDER: 'google', BRAVE_API_KEY: 'b' })).toBe(
      'brave',
    )
    // google needs BOTH key and cx
    expect(resolveSearchProvider({ GOOGLE_SEARCH_API_KEY: 'g' })).toBeNull()
  })

  it('places Gemini between Brave and Google in the fallback order', () => {
    expect(resolveSearchProvider({ GEMINI_SEARCH_API_KEY: 'gk' })).toBe('gemini')
    // Brave still wins over Gemini when both present
    expect(resolveSearchProvider({ BRAVE_API_KEY: 'b', GEMINI_SEARCH_API_KEY: 'gk' })).toBe('brave')
    // Gemini wins over Google when both present (no Brave)
    expect(
      resolveSearchProvider({
        GEMINI_SEARCH_API_KEY: 'gk',
        GOOGLE_SEARCH_API_KEY: 'g',
        GOOGLE_SEARCH_CX: 'c',
      }),
    ).toBe('gemini')
    // pinned gemini with its key wins
    expect(
      resolveSearchProvider({
        WEB_SEARCH_PROVIDER: 'gemini',
        BRAVE_API_KEY: 'b',
        GEMINI_SEARCH_API_KEY: 'gk',
      }),
    ).toBe('gemini')
    // pinned gemini but no gemini key -> falls through to brave
    expect(resolveSearchProvider({ WEB_SEARCH_PROVIDER: 'gemini', BRAVE_API_KEY: 'b' })).toBe(
      'brave',
    )
  })
})

describe('parseGeminiResults', () => {
  it('maps grounding chunks to ranked results, snippet from the citing support', () => {
    const got = parseGeminiResults(geminiBody, 10)
    expect(got).toEqual([
      {
        url: 'https://r/chunk0',
        title: 'nodejs.org',
        snippet: 'Node.js 22 is the latest LTS.',
        rank: 1,
      },
      {
        url: 'https://r/chunk1',
        title: 'endoflife.date',
        snippet: 'Node 20 is in maintenance.',
        rank: 2,
      },
      // chunk2 is cited by the same support as chunk0 (indices [0,2])
      {
        url: 'https://r/chunk2',
        title: 'github.com',
        snippet: 'Node.js 22 is the latest LTS.',
        rank: 3,
      },
    ])
  })

  it('honors maxResults', () => {
    expect(parseGeminiResults(geminiBody, 1)).toHaveLength(1)
  })

  it('returns [] when there is no grounding metadata or it is malformed', () => {
    expect(parseGeminiResults(null, 5)).toEqual([])
    expect(parseGeminiResults({ candidates: [] }, 5)).toEqual([])
    expect(parseGeminiResults({ candidates: [{ content: { parts: [] } }] }, 5)).toEqual([])
    expect(
      parseGeminiResults({ candidates: [{ groundingMetadata: { groundingChunks: 'nope' } }] }, 5),
    ).toEqual([])
  })

  it('keys snippets by RAW chunk index, not output position (dropped chunk before a cited one)', () => {
    // chunk0 has no uri (dropped from output); the support cites raw index 1.
    // If snippets were keyed by output position the surviving result would get
    // the wrong (or empty) snippet ... pin that they follow the raw index.
    const body = {
      candidates: [
        {
          groundingMetadata: {
            groundingChunks: [
              { web: { title: 'no uri, dropped' } },
              { web: { uri: 'https://kept', title: 'Kept' } },
            ],
            groundingSupports: [
              { segment: { text: 'cites the second chunk' }, groundingChunkIndices: [1] },
            ],
          },
        },
      ],
    }
    expect(parseGeminiResults(body, 10)).toEqual([
      { url: 'https://kept', title: 'Kept', snippet: 'cites the second chunk', rank: 1 },
    ])
  })

  it('leaves snippet empty when no support cites a chunk', () => {
    const body = {
      candidates: [
        { groundingMetadata: { groundingChunks: [{ web: { uri: 'https://u', title: 'T' } }] } },
      ],
    }
    expect(parseGeminiResults(body, 5)).toEqual([
      { url: 'https://u', title: 'T', snippet: '', rank: 1 },
    ])
  })
})

describe('parseGoogleResults', () => {
  it('maps Google items into ranked {url,title,snippet}', () => {
    const got = parseGoogleResults(
      { items: [{ link: 'https://x.com', title: 'X', snippet: 'sx' }, { title: 'no link' }] },
      10,
    )
    expect(got).toEqual([{ url: 'https://x.com', title: 'X', snippet: 'sx', rank: 1 }])
  })

  it('returns [] for malformed shapes', () => {
    expect(parseGoogleResults(null, 5)).toEqual([])
    expect(parseGoogleResults({ items: 'nope' }, 5)).toEqual([])
  })
})
