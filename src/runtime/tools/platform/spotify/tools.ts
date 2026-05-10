/**
 * Spotify tool definitions.
 *
 * Eleven tools in v1, sized for Jodin's music-pipeline use case:
 *   - spotify_search_tracks         find tracks by query
 *   - spotify_get_playback_state    current track / device / progress
 *   - spotify_get_devices           list available playback devices
 *   - spotify_play_track            start playback (specific URI or resume)
 *   - spotify_pause                 pause active playback
 *   - spotify_skip_next             skip to next in queue
 *   - spotify_add_to_queue          queue a track on the active device
 *   - spotify_get_my_playlists      list the current user's playlists
 *   - spotify_get_playlist_tracks   page through a playlist's items
 *   - spotify_add_to_playlist       append tracks to a playlist
 *   - spotify_create_playlist       create a new playlist
 *
 * Premium gating: every `/me/player/*` write endpoint (play, pause,
 * skip, queue, transfer) requires the *end user* (whoever authorized
 * the OAuth flow) to have a Spotify Premium subscription. Spotify
 * returns HTTP 403 with `reason: "PREMIUM_REQUIRED"` for non-Premium
 * users; we map that to a clean error message so the model gets
 * actionable feedback.
 *
 * Token refresh: handled by the supervisor's TokenRefreshService.
 * The tool builds a fresh SpotifyApi per call (cheap, no network) and
 * reads the current access_token from the calling Agent's vault, so
 * refreshed tokens are picked up on the very next call.
 */
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../../../mcp/tool.js'
import type { SpotifyApi } from '@spotify/web-api-ts-sdk'
import { buildSpotifyApi, SpotifyCredentialError } from './client.js'

const TrackUriSchema = z.string().regex(/^spotify:track:[A-Za-z0-9]+$/, {
  message: 'Spotify track URI must look like "spotify:track:6rqhFgbbKwnb9MLmUQDhG6"',
})

const PlaylistIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9]+$/, { message: 'Spotify playlist id is alphanumeric' })

const SearchTracksArgsSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(50).default(20),
})

const GetPlaybackStateArgsSchema = z.object({})

const GetDevicesArgsSchema = z.object({})

const PlayTrackArgsSchema = z.object({
  track_uri: TrackUriSchema.optional().describe(
    'A specific track URI to play. If omitted, resumes whatever is currently paused.',
  ),
  device_id: z
    .string()
    .optional()
    .describe('Spotify device id to target. If omitted, the currently-active device is used.'),
})

const PauseArgsSchema = z.object({
  device_id: z.string().optional(),
})

const SkipNextArgsSchema = z.object({
  device_id: z.string().optional(),
})

const AddToQueueArgsSchema = z.object({
  track_uri: TrackUriSchema,
  device_id: z.string().optional(),
})

const GetMyPlaylistsArgsSchema = z.object({
  limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().min(0).default(0),
})

const GetPlaylistTracksArgsSchema = z.object({
  playlist_id: PlaylistIdSchema,
  limit: z.number().int().min(1).max(50).default(50),
  offset: z.number().int().min(0).default(0),
})

const AddToPlaylistArgsSchema = z.object({
  playlist_id: PlaylistIdSchema,
  track_uris: z.array(TrackUriSchema).min(1).max(100),
  position: z.number().int().min(0).optional(),
})

const CreatePlaylistArgsSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(300).optional(),
  public: z.boolean().default(false),
  collaborative: z.boolean().default(false),
})

interface SpotifyApiError {
  message?: string
  status?: number
  reason?: string
  body?: { error?: { reason?: string; message?: string } }
}

function mapSpotifyError(err: unknown): never {
  if (err instanceof SpotifyCredentialError) throw err
  const e = err as SpotifyApiError
  const reason = e.reason ?? e.body?.error?.reason ?? extractReasonFromMessage(e.message)
  if (reason === 'PREMIUM_REQUIRED') {
    throw new Error(
      'Spotify rejected the request: this action requires the authorizing user to have Spotify Premium.',
    )
  }
  if (reason === 'NO_ACTIVE_DEVICE') {
    throw new Error(
      'Spotify has no active device. Open the Spotify app on a phone, desktop, or web player first, ' +
        'or call `spotify_get_devices` and pass the desired `device_id` explicitly.',
    )
  }
  if (e.status === 401) {
    throw new Error(
      'Spotify rejected the access token (401). The supervisor refresh service will attempt a refresh on the next tick; retry shortly. ' +
        'If this persists, re-run the OAuth login.',
    )
  }
  if (e.status === 403) {
    throw new Error(
      `Spotify forbade the action (403): ${e.body?.error?.message ?? e.message ?? 'forbidden'}.`,
    )
  }
  if (e.status === 404) {
    throw new Error(
      `Spotify could not find the requested resource (404): ${e.body?.error?.message ?? e.message ?? 'not found'}.`,
    )
  }
  if (e.status === 429) {
    throw new Error('Spotify rate-limited the request (429). Retry after the indicated delay.')
  }
  throw new Error(
    `Spotify API error${e.status ? ` (${String(e.status)})` : ''}: ${e.body?.error?.message ?? e.message ?? String(err)}`,
  )
}

function extractReasonFromMessage(msg?: string): string | undefined {
  if (!msg) return undefined
  const m = /PREMIUM_REQUIRED|NO_ACTIVE_DEVICE/.exec(msg)
  return m?.[0]
}

export interface SpotifyToolDeps {
  /** Inject a pre-built SpotifyApi (test seam). Default: build per call. */
  apiBuilder?: (home: string, agentName: string) => Promise<SpotifyApi>
}

export function makeSpotifyTools(deps: SpotifyToolDeps = {}): ToolDefinition[] {
  const buildApi =
    deps.apiBuilder ?? ((home: string, agentName: string) => buildSpotifyApi({ home, agentName }))

  const search = defineTool({
    name: 'spotify_search_tracks',
    description: 'Search Spotify for tracks. Returns name, artists, album, duration, and uri.',
    idempotency: 'pure',
    argsSchema: SearchTracksArgsSchema,
    execute: async (args, ctx) => {
      const api = await buildApi(ctx.home, ctx.callingAgent)
      try {
        const limit = args.limit as Parameters<typeof api.search>[3]
        const result = await api.search(args.query, ['track'], undefined, limit)
        return result.tracks.items.map((t) => ({
          uri: t.uri,
          name: t.name,
          artists: t.artists.map((a) => a.name),
          album: t.album.name,
          duration_ms: t.duration_ms,
          explicit: t.explicit,
        }))
      } catch (err) {
        mapSpotifyError(err)
      }
    },
  })

  const getPlaybackState = defineTool({
    name: 'spotify_get_playback_state',
    description:
      "Get the user's current Spotify playback state: track, device, progress, shuffle/repeat. Returns null if nothing is active.",
    idempotency: 'pure',
    argsSchema: GetPlaybackStateArgsSchema,
    execute: async (_args, ctx) => {
      const api = await buildApi(ctx.home, ctx.callingAgent)
      try {
        // The SDK over-asserts non-null on getPlaybackState() and on
        // state.device / state.item. Spotify's REST API returns 204 No
        // Content (empty body) when nothing is playing, and individual
        // fields can be missing. Cast to a nullable shape so the
        // runtime guards survive the optimizer.
        type RawState = Awaited<ReturnType<typeof api.player.getPlaybackState>>
        const state = (await api.player.getPlaybackState()) as RawState | null
        if (!state) return null
        const device = state.device as RawState['device'] | null
        const item = state.item as RawState['item'] | null
        return {
          is_playing: state.is_playing,
          progress_ms: state.progress_ms,
          shuffle: state.shuffle_state,
          repeat: state.repeat_state,
          device: device
            ? {
                id: device.id,
                name: device.name,
                type: device.type,
                is_active: device.is_active,
                volume_percent: device.volume_percent,
              }
            : null,
          item: item
            ? {
                uri: item.uri,
                name: item.name,
                ...('artists' in item ? { artists: item.artists.map((a) => a.name) } : {}),
              }
            : null,
        }
      } catch (err) {
        mapSpotifyError(err)
      }
    },
  })

  const getDevices = defineTool({
    name: 'spotify_get_devices',
    description:
      'List Spotify devices currently available to the authorized user (phones, desktops, web players, speakers).',
    idempotency: 'pure',
    argsSchema: GetDevicesArgsSchema,
    execute: async (_args, ctx) => {
      const api = await buildApi(ctx.home, ctx.callingAgent)
      try {
        const result = await api.player.getAvailableDevices()
        return result.devices.map((d) => ({
          id: d.id,
          name: d.name,
          type: d.type,
          is_active: d.is_active,
          is_restricted: d.is_restricted,
          volume_percent: d.volume_percent,
        }))
      } catch (err) {
        mapSpotifyError(err)
      }
    },
  })

  const playTrack = defineTool({
    name: 'spotify_play_track',
    description:
      'Start or resume Spotify playback. If `track_uri` is set, plays that track; otherwise resumes the active device. Requires Premium.',
    idempotency: 'destructive',
    argsSchema: PlayTrackArgsSchema,
    execute: async (args, ctx) => {
      const api = await buildApi(ctx.home, ctx.callingAgent)
      try {
        // The SDK requires device_id as a string. An empty string
        // means "use the active device" per Spotify's REST contract.
        const deviceId = args.device_id ?? ''
        if (args.track_uri) {
          await api.player.startResumePlayback(deviceId, undefined, [args.track_uri])
        } else {
          await api.player.startResumePlayback(deviceId)
        }
        return { ok: true }
      } catch (err) {
        mapSpotifyError(err)
      }
    },
  })

  const pause = defineTool({
    name: 'spotify_pause',
    description:
      'Pause Spotify playback on the active device (or a specific device). Requires Premium.',
    idempotency: 'destructive',
    argsSchema: PauseArgsSchema,
    execute: async (args, ctx) => {
      const api = await buildApi(ctx.home, ctx.callingAgent)
      try {
        await api.player.pausePlayback(args.device_id ?? '')
        return { ok: true }
      } catch (err) {
        mapSpotifyError(err)
      }
    },
  })

  const skipNext = defineTool({
    name: 'spotify_skip_next',
    description: 'Skip to the next track on the active Spotify device. Requires Premium.',
    idempotency: 'destructive',
    argsSchema: SkipNextArgsSchema,
    execute: async (args, ctx) => {
      const api = await buildApi(ctx.home, ctx.callingAgent)
      try {
        await api.player.skipToNext(args.device_id ?? '')
        return { ok: true }
      } catch (err) {
        mapSpotifyError(err)
      }
    },
  })

  const addToQueue = defineTool({
    name: 'spotify_add_to_queue',
    description:
      'Add a track to the Spotify playback queue on the active device. Requires Premium.',
    idempotency: 'destructive',
    argsSchema: AddToQueueArgsSchema,
    execute: async (args, ctx) => {
      const api = await buildApi(ctx.home, ctx.callingAgent)
      try {
        await api.player.addItemToPlaybackQueue(args.track_uri, args.device_id)
        return { ok: true }
      } catch (err) {
        mapSpotifyError(err)
      }
    },
  })

  const getMyPlaylists = defineTool({
    name: 'spotify_get_my_playlists',
    description: "List the current user's Spotify playlists.",
    idempotency: 'pure',
    argsSchema: GetMyPlaylistsArgsSchema,
    execute: async (args, ctx) => {
      const api = await buildApi(ctx.home, ctx.callingAgent)
      try {
        const limit = args.limit as Parameters<typeof api.currentUser.playlists.playlists>[0]
        // The SDK types `tracks` as a non-nullable Page and `display_name`
        // as a non-nullable string, but Spotify's docs show both can be
        // null in real responses (tracks=null on unloaded references,
        // display_name=null for users who never set one). Cast to a
        // wider shape so the runtime guards survive lint.
        interface PlaylistRow {
          id: string
          name: string
          description: string | null
          tracks: { total: number } | null
          owner: { display_name: string | null; id: string }
          collaborative: boolean
          public: boolean | null
          uri: string
        }
        const page = await api.currentUser.playlists.playlists(limit, args.offset)
        return {
          total: page.total,
          items: (page.items as unknown as PlaylistRow[]).map((p) => ({
            id: p.id,
            name: p.name,
            description: p.description,
            track_count: p.tracks?.total ?? 0,
            owner: p.owner.display_name ?? p.owner.id,
            collaborative: p.collaborative,
            public: p.public,
            uri: p.uri,
          })),
        }
      } catch (err) {
        mapSpotifyError(err)
      }
    },
  })

  const getPlaylistTracks = defineTool({
    name: 'spotify_get_playlist_tracks',
    description:
      'Page through tracks in a Spotify playlist. Returns track uri, name, artists, album, duration.',
    idempotency: 'pure',
    argsSchema: GetPlaylistTracksArgsSchema,
    execute: async (args, ctx) => {
      const api = await buildApi(ctx.home, ctx.callingAgent)
      try {
        const limit = args.limit as Parameters<typeof api.playlists.getPlaylistItems>[3]
        const page = await api.playlists.getPlaylistItems(
          args.playlist_id,
          undefined,
          undefined,
          limit,
          args.offset,
        )
        // SDK over-asserts `track` non-null; Spotify returns null for
        // removed/local tracks. Cast for the runtime guard.
        type SafeTrackItem = {
          uri: string
          name: string
          duration_ms: number
          artists?: { name: string }[]
          album?: { name: string }
        } | null
        return {
          total: page.total,
          items: page.items.map((it) => {
            const track = it.track as unknown as SafeTrackItem
            if (!track) {
              return { uri: null, name: null, artists: [], album: null, duration_ms: 0 }
            }
            return {
              uri: track.uri,
              name: track.name,
              artists: track.artists ? track.artists.map((a) => a.name) : [],
              album: track.album ? track.album.name : null,
              duration_ms: track.duration_ms,
            }
          }),
        }
      } catch (err) {
        mapSpotifyError(err)
      }
    },
  })

  const addToPlaylist = defineTool({
    name: 'spotify_add_to_playlist',
    description:
      'Append one or more tracks (by URI) to a Spotify playlist. Caller must own the playlist or have collaboration access.',
    idempotency: 'destructive',
    argsSchema: AddToPlaylistArgsSchema,
    execute: async (args, ctx) => {
      const api = await buildApi(ctx.home, ctx.callingAgent)
      try {
        await api.playlists.addItemsToPlaylist(args.playlist_id, args.track_uris, args.position)
        return { ok: true, added: args.track_uris.length }
      } catch (err) {
        mapSpotifyError(err)
      }
    },
  })

  const createPlaylist = defineTool({
    name: 'spotify_create_playlist',
    description:
      'Create a new Spotify playlist owned by the authorized user. Returns the new playlist id, name, and uri. Use spotify_add_to_playlist afterward to populate it. ' +
      "Defaults: private (`public: false`), non-collaborative. The playlist is created in the authorizing user's account, so the caller does not need to know the user id.",
    idempotency: 'destructive',
    argsSchema: CreatePlaylistArgsSchema,
    execute: async (args, ctx) => {
      const api = await buildApi(ctx.home, ctx.callingAgent)
      try {
        const me = await api.currentUser.profile()
        const playlist = await api.playlists.createPlaylist(me.id, {
          name: args.name,
          ...(args.description ? { description: args.description } : {}),
          public: args.public,
          collaborative: args.collaborative,
        })
        return {
          id: playlist.id,
          name: playlist.name,
          uri: playlist.uri,
          owner: me.id,
        }
      } catch (err) {
        mapSpotifyError(err)
      }
    },
  })

  return [
    search,
    getPlaybackState,
    getDevices,
    playTrack,
    pause,
    skipNext,
    addToQueue,
    getMyPlaylists,
    getPlaylistTracks,
    addToPlaylist,
    createPlaylist,
  ]
}

export const SPOTIFY_TOOL_NAMES = [
  'spotify_search_tracks',
  'spotify_get_playback_state',
  'spotify_get_devices',
  'spotify_play_track',
  'spotify_pause',
  'spotify_skip_next',
  'spotify_add_to_queue',
  'spotify_get_my_playlists',
  'spotify_get_playlist_tracks',
  'spotify_add_to_playlist',
  'spotify_create_playlist',
] as const
