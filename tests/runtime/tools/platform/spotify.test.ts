/**
 * Spotify tool defs ... unit-level coverage.
 *
 * Two tools now: `spotify_api` (passthrough) and `spotify_set_playlist_cover`
 * (server-side cover-upload helper). The SpotifyApi SDK is mocked at the
 * buildApi seam; the `makeRequest` method is what both tools actually call.
 *
 * Verifies:
 *   - argsSchema rejects malformed shapes
 *   - spotify_api passes through (method, normalized path, query string, body)
 *   - error mapping: PREMIUM_REQUIRED, NO_ACTIVE_DEVICE, 401, 403, 429
 *   - cover helper strips URI prefix from playlist_id and PUTs base64 JPEG
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeSpotifyTools } from '../../../../src/runtime/tools/platform/spotify/tools.js'
import type { ToolContext, ToolDefinition } from '../../../../src/runtime/mcp/tool.js'
import type { SpotifyApi } from '@spotify/web-api-ts-sdk'

const ctx = (): ToolContext => ({
  callingAgent: 'jodin',
  home: '/h',
  brainDir: '/h/agents/jodin/brain',
  projectDir: '/h/agents/jodin/project',
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

interface MockApi {
  makeRequest: MockedFn
}

function makeMockApi(): MockApi {
  return { makeRequest: mockFn() }
}

function withMock(mock: MockApi): {
  byName: (name: string) => ToolDefinition
} {
  const tools = makeSpotifyTools({
    apiBuilder: () => Promise.resolve(mock as unknown as SpotifyApi),
  })
  return {
    byName: (name) => {
      const t = tools.find((tt) => tt.name === name)
      if (!t) throw new Error(`tool not found: ${name}`)
      return t
    },
  }
}

describe('makeSpotifyTools', () => {
  it('exposes exactly two tools: spotify_api and spotify_set_playlist_cover', () => {
    const mock = makeMockApi()
    const tools = makeSpotifyTools({
      apiBuilder: () => Promise.resolve(mock as unknown as SpotifyApi),
    })
    expect(tools.map((t) => t.name).sort()).toEqual(['spotify_api', 'spotify_set_playlist_cover'])
  })
})

describe('spotify_api: argsSchema', () => {
  function tool(): ToolDefinition {
    const mock = makeMockApi()
    const { byName } = withMock(mock)
    return byName('spotify_api')
  }

  it('rejects unknown HTTP method', () => {
    expect(() => tool().argsSchema.parse({ method: 'PATCH', path: 'me/playlists' })).toThrow()
  })

  it('rejects empty path', () => {
    expect(() => tool().argsSchema.parse({ method: 'GET', path: '' })).toThrow()
  })

  it('rejects path longer than 500 chars', () => {
    expect(() => tool().argsSchema.parse({ method: 'GET', path: 'x'.repeat(501) })).toThrow()
  })

  it('accepts query with mixed string/number/boolean values', () => {
    expect(() =>
      tool().argsSchema.parse({
        method: 'GET',
        path: 'search',
        query: { q: 'taylor', type: 'track', limit: 20, market: 'US', include_explicit: true },
      }),
    ).not.toThrow()
  })

  it('rejects non-primitive query values', () => {
    expect(() =>
      tool().argsSchema.parse({
        method: 'GET',
        path: 'search',
        query: { q: { nested: 'no' } },
      }),
    ).toThrow()
  })

  it('accepts arbitrary unknown body shape', () => {
    expect(() =>
      tool().argsSchema.parse({
        method: 'POST',
        path: 'me/playlists',
        body: { name: 'x', description: 'y', public: false },
      }),
    ).not.toThrow()
  })
})

describe('spotify_api: path normalization', () => {
  it('passes a bare path through unchanged', async () => {
    const mock = makeMockApi()
    mock.makeRequest.setResult({ items: [] })
    const { byName } = withMock(mock)
    const t = byName('spotify_api')
    await t.execute({ method: 'GET', path: 'me/playlists' }, ctx())
    expect(mock.makeRequest.calls[0]!.args[1]).toBe('me/playlists')
  })

  it('strips a leading slash', async () => {
    const mock = makeMockApi()
    mock.makeRequest.setResult({})
    const { byName } = withMock(mock)
    const t = byName('spotify_api')
    await t.execute({ method: 'GET', path: '/me/playlists' }, ctx())
    expect(mock.makeRequest.calls[0]!.args[1]).toBe('me/playlists')
  })

  it('strips a leading /v1/', async () => {
    const mock = makeMockApi()
    mock.makeRequest.setResult({})
    const { byName } = withMock(mock)
    const t = byName('spotify_api')
    await t.execute({ method: 'GET', path: '/v1/me/playlists' }, ctx())
    expect(mock.makeRequest.calls[0]!.args[1]).toBe('me/playlists')
  })

  it('preserves path segments past the prefix', async () => {
    const mock = makeMockApi()
    mock.makeRequest.setResult({})
    const { byName } = withMock(mock)
    const t = byName('spotify_api')
    await t.execute({ method: 'POST', path: 'playlists/abc123/items' }, ctx())
    expect(mock.makeRequest.calls[0]!.args[1]).toBe('playlists/abc123/items')
  })

  it('lowercases a capitalized first segment (e.g. "Me/" -> "me/")', async () => {
    const mock = makeMockApi()
    mock.makeRequest.setResult({})
    const { byName } = withMock(mock)
    const t = byName('spotify_api')
    await t.execute({ method: 'GET', path: 'Me/playlists' }, ctx())
    expect(mock.makeRequest.calls[0]!.args[1]).toBe('me/playlists')
  })

  it('lowercases the first segment without touching downstream IDs (case-mixed)', async () => {
    const mock = makeMockApi()
    mock.makeRequest.setResult({})
    const { byName } = withMock(mock)
    const t = byName('spotify_api')
    // Spotify IDs are mixed-case base62; the second segment must be preserved verbatim.
    await t.execute({ method: 'GET', path: 'Playlists/2nH7uZhjnAnDAURGVnuG14' }, ctx())
    expect(mock.makeRequest.calls[0]!.args[1]).toBe('playlists/2nH7uZhjnAnDAURGVnuG14')
  })

  it('lowercases a single-segment path', async () => {
    const mock = makeMockApi()
    mock.makeRequest.setResult({})
    const { byName } = withMock(mock)
    const t = byName('spotify_api')
    await t.execute({ method: 'GET', path: 'Search' }, ctx())
    expect(mock.makeRequest.calls[0]!.args[1]).toBe('search')
  })
})

describe('spotify_api: query serialization', () => {
  it('appends string/number/boolean query params', async () => {
    const mock = makeMockApi()
    mock.makeRequest.setResult({})
    const { byName } = withMock(mock)
    const t = byName('spotify_api')
    await t.execute(
      {
        method: 'GET',
        path: 'search',
        query: { q: 'taylor swift', type: 'track', limit: 20, include_explicit: false },
      },
      ctx(),
    )
    const url = mock.makeRequest.calls[0]!.args[1] as string
    expect(url.startsWith('search?')).toBe(true)
    const qs = new URLSearchParams(url.split('?')[1] ?? '')
    expect(qs.get('q')).toBe('taylor swift')
    expect(qs.get('type')).toBe('track')
    expect(qs.get('limit')).toBe('20')
    expect(qs.get('include_explicit')).toBe('false')
  })

  it('omits the query string when query is undefined', async () => {
    const mock = makeMockApi()
    mock.makeRequest.setResult({})
    const { byName } = withMock(mock)
    const t = byName('spotify_api')
    await t.execute({ method: 'GET', path: 'me/playlists' }, ctx())
    expect(mock.makeRequest.calls[0]!.args[1]).toBe('me/playlists')
  })
})

describe('spotify_api: body passthrough', () => {
  it('passes the body through unchanged to makeRequest', async () => {
    const mock = makeMockApi()
    mock.makeRequest.setResult({ id: 'pl_new', uri: 'spotify:playlist:pl_new' })
    const { byName } = withMock(mock)
    const t = byName('spotify_api')
    const body = { name: 'Sunday', description: 'mellow', public: false }
    await t.execute({ method: 'POST', path: 'me/playlists', body }, ctx())
    expect(mock.makeRequest.calls[0]!.args[0]).toBe('POST')
    expect(mock.makeRequest.calls[0]!.args[1]).toBe('me/playlists')
    expect(mock.makeRequest.calls[0]!.args[2]).toBe(body)
  })

  it('returns the JSON response unchanged', async () => {
    const mock = makeMockApi()
    const response = { items: [{ id: 'pl1' }, { id: 'pl2' }] }
    mock.makeRequest.setResult(response)
    const { byName } = withMock(mock)
    const t = byName('spotify_api')
    const result = await t.execute({ method: 'GET', path: 'me/playlists' }, ctx())
    expect(result).toEqual(response)
  })
})

describe('spotify_api: error mapping', () => {
  function build(): { tool: ToolDefinition; setError: (e: unknown) => void } {
    const mock = makeMockApi()
    const { byName } = withMock(mock)
    return { tool: byName('spotify_api'), setError: mock.makeRequest.setError }
  }

  it('maps 401 to a token-refresh hint', async () => {
    const { tool, setError } = build()
    setError({ status: 401, message: 'Unauthorized' })
    await expect(tool.execute({ method: 'GET', path: 'me' }, ctx())).rejects.toThrow(/401/)
  })

  it('maps 403 to a forbidden hint with the original message', async () => {
    const { tool, setError } = build()
    setError({ status: 403, body: { error: { message: 'Insufficient client scope' } } })
    await expect(tool.execute({ method: 'POST', path: 'me/player/play' }, ctx())).rejects.toThrow(
      /Insufficient client scope/,
    )
  })

  it('maps 429 to a rate-limit hint', async () => {
    const { tool, setError } = build()
    setError({ status: 429, message: 'Too Many Requests' })
    await expect(tool.execute({ method: 'GET', path: 'me' }, ctx())).rejects.toThrow(/429/)
  })

  it('maps PREMIUM_REQUIRED to an actionable message', async () => {
    const { tool, setError } = build()
    setError({
      status: 403,
      body: { error: { reason: 'PREMIUM_REQUIRED', message: 'Player command failed' } },
    })
    await expect(tool.execute({ method: 'PUT', path: 'me/player/play' }, ctx())).rejects.toThrow(
      /Premium/,
    )
  })

  it('maps NO_ACTIVE_DEVICE to a device-required message', async () => {
    const { tool, setError } = build()
    setError({
      status: 404,
      body: { error: { reason: 'NO_ACTIVE_DEVICE', message: 'Player command failed' } },
    })
    await expect(tool.execute({ method: 'PUT', path: 'me/player/play' }, ctx())).rejects.toThrow(
      /no active device/i,
    )
  })

  it('maps 404 "Service not found" to a case-sensitivity hint', async () => {
    const { tool, setError } = build()
    setError({ status: 404, body: { error: { message: 'Service not found' } } })
    await expect(
      // Path is pre-normalized; this test asserts the error mapping fires for
      // any future regression where the SDK propagates "Service not found"
      // (e.g. an unknown endpoint path).
      tool.execute({ method: 'GET', path: 'unknown-endpoint' }, ctx()),
    ).rejects.toThrow(/case-sensitive lowercase/i)
  })

  it('maps 400 "Invalid limit" to a search-query hint', async () => {
    const { tool, setError } = build()
    setError({ status: 400, body: { error: { message: 'Invalid limit' } } })
    await expect(
      tool.execute(
        { method: 'GET', path: 'search', query: { q: 'foo OR bar', type: 'track', limit: 20 } },
        ctx(),
      ),
    ).rejects.toThrow(/boolean operators/i)
  })

  it('maps the SDK\'s legacy "Bad OAuth request" 403 message to a /tracks-vs-/items hint', async () => {
    const { tool, setError } = build()
    // Reproduce the exact JS Error shape the SDK's DefaultResponseValidator
    // throws for any 403 (no `status` field; just a `.message` string).
    setError(
      new Error(
        'Bad OAuth request (wrong consumer key, bad nonce, expired timestamp...). ' +
          'Unfortunately, re-authenticating the user won\'t help here. Body: {"error":{"status":403,"message":"Forbidden"}}',
      ),
    )
    await expect(
      tool.execute({ method: 'GET', path: 'playlists/2nH7uZhjnAnDAURGVnuG14/tracks' }, ctx()),
    ).rejects.toThrow(/deprecated endpoint.*\/items/i)
  })

  it('maps a generic 400 with a fallback message', async () => {
    const { tool, setError } = build()
    setError({ status: 400, body: { error: { message: 'Invalid parameter foo' } } })
    await expect(tool.execute({ method: 'GET', path: 'me' }, ctx())).rejects.toThrow(
      /Invalid parameter foo/,
    )
  })
})

describe('spotify_set_playlist_cover', () => {
  let tmp: string
  let imagePath: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'spotify-cover-'))
    imagePath = join(tmp, 'cover.png')
    // 800x800 solid-color PNG ... well under 256KB once re-encoded as JPEG.
    const png = await sharp({
      create: { width: 800, height: 800, channels: 3, background: { r: 200, g: 50, b: 100 } },
    })
      .png()
      .toBuffer()
    await writeFile(imagePath, png)
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  function tool(): ToolDefinition {
    const mock = makeMockApi()
    const { byName } = withMock(mock)
    return byName('spotify_set_playlist_cover')
  }

  it('rejects empty playlist_id', () => {
    expect(() => tool().argsSchema.parse({ playlist_id: '', image_path: imagePath })).toThrow()
  })

  it('rejects empty image_path', () => {
    expect(() => tool().argsSchema.parse({ playlist_id: 'pl1', image_path: '' })).toThrow()
  })

  it('strips the spotify:playlist: URI prefix from the playlist_id', async () => {
    const mock = makeMockApi()
    mock.makeRequest.setResult(undefined)
    const { byName } = withMock(mock)
    const t = byName('spotify_set_playlist_cover')
    await t.execute({ playlist_id: 'spotify:playlist:abc123XYZ', image_path: imagePath }, ctx())
    expect(mock.makeRequest.calls[0]!.args[0]).toBe('PUT')
    expect(mock.makeRequest.calls[0]!.args[1]).toBe('playlists/abc123XYZ/images')
    expect(mock.makeRequest.calls[0]!.args[3]).toBe('image/jpeg')
  })

  it('uploads a base64 JPEG body', async () => {
    const mock = makeMockApi()
    mock.makeRequest.setResult(undefined)
    const { byName } = withMock(mock)
    const t = byName('spotify_set_playlist_cover')
    const result = (await t.execute({ playlist_id: 'abc123', image_path: imagePath }, ctx())) as {
      ok: boolean
      bytes_uploaded: number
    }
    expect(result.ok).toBe(true)
    expect(result.bytes_uploaded).toBeGreaterThan(0)
    const body = mock.makeRequest.calls[0]!.args[2] as string
    expect(typeof body).toBe('string')
    // base64 payload should decode to a JPEG (starts with FF D8 FF)
    const decoded = Buffer.from(body, 'base64')
    expect(decoded[0]).toBe(0xff)
    expect(decoded[1]).toBe(0xd8)
    expect(decoded[2]).toBe(0xff)
  })

  it('recompresses when initial JPEG exceeds the 256KB cap', async () => {
    // Create a large noisy PNG that does not compress well. Random noise so
    // sharp can't trivially deflate it. 2400x2400 RGB random ~ several MB.
    const noisyPath = join(tmp, 'noisy.png')
    const w = 2400
    const h = 2400
    const buf = Buffer.alloc(w * h * 3)
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 1103515245 + 12345) & 0xff
    const noisyPng = await sharp(buf, { raw: { width: w, height: h, channels: 3 } })
      .png()
      .toBuffer()
    await writeFile(noisyPath, noisyPng)

    const mock = makeMockApi()
    mock.makeRequest.setResult(undefined)
    const { byName } = withMock(mock)
    const t = byName('spotify_set_playlist_cover')
    const result = (await t.execute({ playlist_id: 'abc123', image_path: noisyPath }, ctx())) as {
      ok: boolean
      bytes_uploaded: number
      recompressed: boolean
    }
    expect(result.ok).toBe(true)
    expect(result.bytes_uploaded).toBeLessThanOrEqual(256_000)
  })
})
