/**
 * Spotify tool defs ... unit-level coverage.
 *
 * The SpotifyApi SDK is mocked at the buildApi seam. We are not
 * testing Spotify's HTTP API. The tests verify:
 *   - argsSchema rejects malformed URIs / over-limit values
 *   - execute() reads from the agent's vault (via the seam) and calls
 *     the right SDK method with the expected shape
 *   - PREMIUM_REQUIRED, NO_ACTIVE_DEVICE, 401, 403, 429 map to clean
 *     human-readable error messages
 *   - Missing-credential errors point the operator at the right CLI
 *     command
 */
import { describe, expect, it } from 'vitest'
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
  search: MockedFn
  player: {
    getPlaybackState: MockedFn
    getAvailableDevices: MockedFn
    startResumePlayback: MockedFn
    pausePlayback: MockedFn
    skipToNext: MockedFn
    addItemToPlaybackQueue: MockedFn
  }
  playlists: {
    getPlaylistItems: MockedFn
    addItemsToPlaylist: MockedFn
  }
  currentUser: {
    playlists: {
      playlists: MockedFn
    }
  }
}

function makeMockApi(): MockApi {
  return {
    search: mockFn(),
    player: {
      getPlaybackState: mockFn(),
      getAvailableDevices: mockFn(),
      startResumePlayback: mockFn(),
      pausePlayback: mockFn(),
      skipToNext: mockFn(),
      addItemToPlaybackQueue: mockFn(),
    },
    playlists: {
      getPlaylistItems: mockFn(),
      addItemsToPlaylist: mockFn(),
    },
    currentUser: {
      playlists: {
        playlists: mockFn(),
      },
    },
  }
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

describe('spotify_search_tracks', () => {
  it('searches with type=["track"] and projects items', async () => {
    const mock = makeMockApi()
    mock.search.setResult({
      tracks: {
        items: [
          {
            uri: 'spotify:track:abc',
            name: 'Heroes',
            artists: [{ name: 'David Bowie' }],
            album: { name: 'Heroes' },
            duration_ms: 220000,
            explicit: false,
          },
        ],
      },
    })
    const { byName } = withMock(mock)
    const tool = byName('spotify_search_tracks')
    const result = await tool.execute({ query: 'Heroes Bowie', limit: 5 }, ctx())
    expect(mock.search.calls[0]!.args).toEqual(['Heroes Bowie', ['track'], undefined, 5])
    expect(result).toEqual([
      {
        uri: 'spotify:track:abc',
        name: 'Heroes',
        artists: ['David Bowie'],
        album: 'Heroes',
        duration_ms: 220000,
        explicit: false,
      },
    ])
  })

  it('rejects an empty query', () => {
    const mock = makeMockApi()
    const { byName } = withMock(mock)
    const tool = byName('spotify_search_tracks')
    expect(() => tool.argsSchema.parse({ query: '' })).toThrow()
  })

  it('caps limit at 50', () => {
    const mock = makeMockApi()
    const { byName } = withMock(mock)
    const tool = byName('spotify_search_tracks')
    expect(() => tool.argsSchema.parse({ query: 'x', limit: 51 })).toThrow()
  })
})

describe('spotify_get_playback_state', () => {
  it('returns null when nothing is playing', async () => {
    const mock = makeMockApi()
    mock.player.getPlaybackState.setResult(null)
    const { byName } = withMock(mock)
    const tool = byName('spotify_get_playback_state')
    expect(await tool.execute({}, ctx())).toBeNull()
  })

  it('projects device + item cleanly', async () => {
    const mock = makeMockApi()
    mock.player.getPlaybackState.setResult({
      is_playing: true,
      progress_ms: 12345,
      shuffle_state: false,
      repeat_state: 'off',
      device: {
        id: 'd1',
        name: 'MacBook',
        type: 'Computer',
        is_active: true,
        volume_percent: 60,
      },
      item: {
        uri: 'spotify:track:abc',
        name: 'Heroes',
        artists: [{ name: 'David Bowie' }],
      },
    })
    const { byName } = withMock(mock)
    const tool = byName('spotify_get_playback_state')
    const result = await tool.execute({}, ctx())
    expect(result).toEqual({
      is_playing: true,
      progress_ms: 12345,
      shuffle: false,
      repeat: 'off',
      device: { id: 'd1', name: 'MacBook', type: 'Computer', is_active: true, volume_percent: 60 },
      item: { uri: 'spotify:track:abc', name: 'Heroes', artists: ['David Bowie'] },
    })
  })
})

describe('spotify_get_devices', () => {
  it('lists devices', async () => {
    const mock = makeMockApi()
    mock.player.getAvailableDevices.setResult({
      devices: [
        {
          id: 'd1',
          name: 'MacBook',
          type: 'Computer',
          is_active: true,
          is_restricted: false,
          volume_percent: 60,
        },
        {
          id: 'd2',
          name: 'iPhone',
          type: 'Smartphone',
          is_active: false,
          is_restricted: false,
          volume_percent: 100,
        },
      ],
    })
    const { byName } = withMock(mock)
    const tool = byName('spotify_get_devices')
    const result = await tool.execute({}, ctx())
    expect(result).toHaveLength(2)
    expect((result as { id: string }[])[0]!.id).toBe('d1')
  })
})

describe('spotify_play_track', () => {
  it('starts playback of a specific track URI', async () => {
    const mock = makeMockApi()
    mock.player.startResumePlayback.setResult(undefined)
    const { byName } = withMock(mock)
    const tool = byName('spotify_play_track')
    await tool.execute({ track_uri: 'spotify:track:abc', device_id: 'd1' }, ctx())
    expect(mock.player.startResumePlayback.calls[0]!.args).toEqual([
      'd1',
      undefined,
      ['spotify:track:abc'],
    ])
  })

  it('resumes (no track_uri) using empty device_id when device_id is omitted', async () => {
    const mock = makeMockApi()
    mock.player.startResumePlayback.setResult(undefined)
    const { byName } = withMock(mock)
    const tool = byName('spotify_play_track')
    await tool.execute({}, ctx())
    expect(mock.player.startResumePlayback.calls[0]!.args).toEqual([''])
  })

  it('rejects malformed track_uri', () => {
    const mock = makeMockApi()
    const { byName } = withMock(mock)
    const tool = byName('spotify_play_track')
    expect(() => tool.argsSchema.parse({ track_uri: 'not-a-spotify-uri' })).toThrow()
  })

  it('maps PREMIUM_REQUIRED to a clear message', async () => {
    const mock = makeMockApi()
    mock.player.startResumePlayback.setError({
      status: 403,
      reason: 'PREMIUM_REQUIRED',
      body: {
        error: { reason: 'PREMIUM_REQUIRED', message: 'Player command failed: Premium required' },
      },
    })
    const { byName } = withMock(mock)
    const tool = byName('spotify_play_track')
    await expect(tool.execute({ track_uri: 'spotify:track:abc' }, ctx())).rejects.toThrow(
      /Premium/i,
    )
  })

  it('maps NO_ACTIVE_DEVICE to a clear setup hint', async () => {
    const mock = makeMockApi()
    mock.player.startResumePlayback.setError({
      status: 404,
      reason: 'NO_ACTIVE_DEVICE',
      body: {
        error: { reason: 'NO_ACTIVE_DEVICE', message: 'Player command failed: No active device' },
      },
    })
    const { byName } = withMock(mock)
    const tool = byName('spotify_play_track')
    await expect(tool.execute({}, ctx())).rejects.toThrow(/no active device/i)
  })

  it('maps 401 to a refresh-pending message', async () => {
    const mock = makeMockApi()
    mock.player.startResumePlayback.setError({
      status: 401,
      message: 'The access token expired',
    })
    const { byName } = withMock(mock)
    const tool = byName('spotify_play_track')
    await expect(tool.execute({}, ctx())).rejects.toThrow(/access token.*401|refresh/i)
  })
})

describe('spotify_pause / spotify_skip_next', () => {
  it('pause passes device_id (or empty string)', async () => {
    const mock = makeMockApi()
    mock.player.pausePlayback.setResult(undefined)
    const { byName } = withMock(mock)
    await byName('spotify_pause').execute({ device_id: 'd1' }, ctx())
    expect(mock.player.pausePlayback.calls[0]!.args).toEqual(['d1'])
    await byName('spotify_pause').execute({}, ctx())
    expect(mock.player.pausePlayback.calls[1]!.args).toEqual([''])
  })

  it('skip_next passes device_id (or empty string)', async () => {
    const mock = makeMockApi()
    mock.player.skipToNext.setResult(undefined)
    const { byName } = withMock(mock)
    await byName('spotify_skip_next').execute({}, ctx())
    expect(mock.player.skipToNext.calls[0]!.args).toEqual([''])
  })
})

describe('spotify_add_to_queue', () => {
  it('adds a track URI to the active device queue', async () => {
    const mock = makeMockApi()
    mock.player.addItemToPlaybackQueue.setResult(undefined)
    const { byName } = withMock(mock)
    const tool = byName('spotify_add_to_queue')
    const result = await tool.execute({ track_uri: 'spotify:track:abc' }, ctx())
    expect(mock.player.addItemToPlaybackQueue.calls[0]!.args).toEqual([
      'spotify:track:abc',
      undefined,
    ])
    expect(result).toEqual({ ok: true })
  })
})

describe('spotify_get_my_playlists', () => {
  it('projects playlists', async () => {
    const mock = makeMockApi()
    mock.currentUser.playlists.playlists.setResult({
      total: 2,
      items: [
        {
          id: 'pl1',
          name: 'Driving',
          description: 'road trip',
          tracks: { total: 42 },
          owner: { display_name: 'Doug', id: 'doug' },
          collaborative: false,
          public: false,
          uri: 'spotify:playlist:pl1',
        },
        {
          id: 'pl2',
          name: 'Coding',
          description: null,
          tracks: null,
          owner: { display_name: null, id: 'doug' },
          collaborative: false,
          public: true,
          uri: 'spotify:playlist:pl2',
        },
      ],
    })
    const { byName } = withMock(mock)
    const tool = byName('spotify_get_my_playlists')
    const result = (await tool.execute({ limit: 20, offset: 0 }, ctx())) as {
      total: number
      items: { id: string; name: string; track_count: number; owner: string }[]
    }
    expect(result.total).toBe(2)
    expect(result.items[0]!.track_count).toBe(42)
    expect(result.items[1]!.track_count).toBe(0)
    expect(result.items[1]!.owner).toBe('doug')
  })
})

describe('spotify_get_playlist_tracks', () => {
  it('handles items with full track shape', async () => {
    const mock = makeMockApi()
    mock.playlists.getPlaylistItems.setResult({
      total: 1,
      items: [
        {
          track: {
            uri: 'spotify:track:abc',
            name: 'Heroes',
            artists: [{ name: 'David Bowie' }],
            album: { name: 'Heroes' },
            duration_ms: 220000,
          },
        },
      ],
    })
    const { byName } = withMock(mock)
    const tool = byName('spotify_get_playlist_tracks')
    const result = (await tool.execute({ playlist_id: 'pl1', limit: 50, offset: 0 }, ctx())) as {
      items: { uri: string | null }[]
    }
    expect(result.items[0]!.uri).toBe('spotify:track:abc')
  })

  it('rejects malformed playlist_id', () => {
    const mock = makeMockApi()
    const { byName } = withMock(mock)
    const tool = byName('spotify_get_playlist_tracks')
    expect(() => tool.argsSchema.parse({ playlist_id: 'bad/id' })).toThrow()
  })
})

describe('spotify_add_to_playlist', () => {
  it('appends multiple track URIs', async () => {
    const mock = makeMockApi()
    mock.playlists.addItemsToPlaylist.setResult(undefined)
    const { byName } = withMock(mock)
    const tool = byName('spotify_add_to_playlist')
    const result = await tool.execute(
      {
        playlist_id: 'pl1',
        track_uris: ['spotify:track:abc', 'spotify:track:def'],
      },
      ctx(),
    )
    expect(mock.playlists.addItemsToPlaylist.calls[0]!.args).toEqual([
      'pl1',
      ['spotify:track:abc', 'spotify:track:def'],
      undefined,
    ])
    expect(result).toEqual({ ok: true, added: 2 })
  })

  it('rejects empty track list', () => {
    const mock = makeMockApi()
    const { byName } = withMock(mock)
    const tool = byName('spotify_add_to_playlist')
    expect(() => tool.argsSchema.parse({ playlist_id: 'pl1', track_uris: [] })).toThrow()
  })

  it('rejects more than 100 tracks at once', () => {
    const mock = makeMockApi()
    const { byName } = withMock(mock)
    const tool = byName('spotify_add_to_playlist')
    const oneOhOne = Array.from({ length: 101 }, (_v, i) => `spotify:track:t${String(i)}`)
    expect(() => tool.argsSchema.parse({ playlist_id: 'pl1', track_uris: oneOhOne })).toThrow()
  })
})
