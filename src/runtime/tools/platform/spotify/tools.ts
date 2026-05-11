/**
 * Spotify tool surface (passthrough + server-side-only helpers).
 *
 * Two tools shipped:
 *   - spotify_api               thin HTTP passthrough to the Spotify Web API
 *   - spotify_set_playlist_cover upload a custom cover image (sharp re-encode + base64)
 *
 * This file used to host twelve per-endpoint wrappers (search, get_playback_state,
 * get_my_playlists, create_playlist, add_to_playlist, ...). Those were collapsed
 * into `spotify_api` per the 2026-05-11 platform-integration decision record.
 * Reasons in short:
 *   - Provider SDKs lag the actual API by months; every endpoint we wrapped became
 *     a maintenance liability the moment Spotify migrated. The Feb 2026 migration
 *     broke createPlaylist, addItemsToPlaylist, and (discovered live) more.
 *   - Per-endpoint wrappers self-collide: our own create-tool returned a URI shape
 *     our own add-tool rejected via a Zod regex. Agents fell into this multiple
 *     times in one session.
 *   - 12 typed wrappers × N future endpoints is a quadratic surface.
 *
 * `spotify_api` bypasses the SDK's URL construction entirely. It still relies on
 * the SDK's `makeRequest` for bearer-auth + body serialization + refresh handling,
 * keeping the OAuth + vault + TokenRefreshService machinery unchanged.
 *
 * The endpoint catalog (paths, methods, scopes, gotchas) lives in the shared
 * brain note `spotify-api-reference`, seeded by starter-pack. Agents read the
 * note, then call `spotify_api`.
 *
 * Token refresh: handled by the supervisor's TokenRefreshService. The tool builds
 * a fresh SpotifyApi per call (cheap, no network) and reads the current access
 * token from the calling Agent's vault, so refreshed tokens are picked up on the
 * very next call.
 */
import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../../../mcp/tool.js'
import type { SpotifyApi } from '@spotify/web-api-ts-sdk'
import { buildSpotifyApi, SpotifyCredentialError } from './client.js'

const SPOTIFY_COVER_MAX_BYTES = 256_000

const SpotifyApiArgsSchema = z.object({
  method: z
    .enum(['GET', 'POST', 'PUT', 'DELETE'])
    .describe('HTTP method. Use GET for reads, POST to create, PUT to update, DELETE to remove.'),
  path: z
    .string()
    .min(1)
    .max(500)
    .describe(
      "Spotify Web API path under /v1. Leading '/' or '/v1/' is stripped if present. " +
        "Examples: 'me/playlists', 'search', 'playlists/{id}/items', 'me/player/play'. " +
        'See brain note `spotify-api-reference` for the endpoint catalog.',
    ),
  query: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe(
      "URL query parameters as key->value (e.g. { q: 'taylor swift', type: 'track', limit: 20 }). " +
        'Numbers and booleans are coerced to strings. Omit for paths that take no query.',
    ),
  body: z
    .unknown()
    .optional()
    .describe(
      'JSON request body for POST/PUT. Pass as a structured object; will be JSON-serialized. ' +
        'Omit for GET/DELETE.',
    ),
})

const SetPlaylistCoverArgsSchema = z.object({
  playlist_id: z
    .string()
    .min(1)
    .describe(
      "Spotify playlist id. Accepts either the bare id ('2awL1BisIAY385gneFdhJM') or the full " +
        "URI ('spotify:playlist:2awL1BisIAY385gneFdhJM'); the URI prefix is stripped automatically.",
    ),
  image_path: z
    .string()
    .min(1)
    .describe(
      "Virtual path to the cover image (e.g. '/project/covers/today.jpg'). " +
        "PNG / WebP / JPEG accepted; we re-encode to JPEG and resize to fit Spotify's 256KB cap.",
    ),
})

interface SpotifyApiError {
  message?: string
  status?: number
  reason?: string
  body?: { error?: { reason?: string; message?: string; status?: number } }
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
        'or GET /me/player/devices and pass `device_id` in the body when starting playback.',
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
      `Spotify forbade the action (403): ${e.body?.error?.message ?? e.message ?? 'forbidden'}. ` +
        'Common causes: missing OAuth scope for this endpoint, or attempting to modify a resource you do not own.',
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

function normalizePath(raw: string): string {
  let p = raw.trim()
  if (p.startsWith('/')) p = p.slice(1)
  if (p.startsWith('v1/')) p = p.slice(3)
  return p
}

function buildQueryString(query: Record<string, string | number | boolean> | undefined): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    params.append(k, String(v))
  }
  const s = params.toString()
  return s ? `?${s}` : ''
}

function stripPlaylistUriPrefix(raw: string): string {
  const m = /^spotify:playlist:([A-Za-z0-9]+)$/.exec(raw.trim())
  if (m?.[1]) return m[1]
  return raw.trim()
}

export interface SpotifyToolDeps {
  /** Inject a pre-built SpotifyApi (test seam). Default: build per call. */
  apiBuilder?: (home: string, agentName: string) => Promise<SpotifyApi>
}

export function makeSpotifyTools(deps: SpotifyToolDeps = {}): ToolDefinition[] {
  const buildApi =
    deps.apiBuilder ?? ((home: string, agentName: string) => buildSpotifyApi({ home, agentName }))

  const apiPassthrough = defineTool({
    name: 'spotify_api',
    description:
      'Call the Spotify Web API directly. Takes (method, path, query?, body?) and returns the JSON response. ' +
      "Uses the calling Agent's vault token for auth. Read `spotify-api-reference` in the shared brain for the " +
      'endpoint catalog, required scopes, and request/response shapes. Use this for: search, playlists, ' +
      'playback state, library reads/writes, user profile, anything Spotify exposes. ' +
      'The one exception is uploading a custom playlist cover image: use `spotify_set_playlist_cover` for ' +
      'that (server-side re-encoding required).',
    idempotency: 'destructive',
    argsSchema: SpotifyApiArgsSchema,
    execute: async (args, ctx) => {
      const api = await buildApi(ctx.home, ctx.callingAgent)
      const fullPath = normalizePath(args.path) + buildQueryString(args.query)
      try {
        // makeRequest signature: (method, url, body?, contentType?)
        // The SDK handles bearer-auth header, body JSON-serialization when
        // contentType is omitted (default application/json), and parses the
        // JSON response. We pass `body` through unchanged.
        const result = await api.makeRequest(args.method, fullPath, args.body)
        return result
      } catch (err) {
        mapSpotifyError(err)
      }
    },
  })

  const setPlaylistCover = defineTool({
    name: 'spotify_set_playlist_cover',
    description:
      'Upload a custom cover image for a Spotify playlist. Reads a virtual path (PNG/WebP/JPEG), ' +
      "re-encodes to JPEG, resizes if needed to fit Spotify's 256KB cap, and PUTs to /playlists/{id}/images. " +
      'Requires the `ugc-image-upload` OAuth scope. Why a dedicated tool: the binary base64 body and sharp ' +
      "re-encoding pipeline can't be done from the model side.",
    idempotency: 'destructive',
    argsSchema: SetPlaylistCoverArgsSchema,
    pathArgs: [{ argName: 'image_path', operation: 'read' }],
    execute: async (args, ctx) => {
      const playlistId = stripPlaylistUriPrefix(args.playlist_id)
      const raw = await readFile(args.image_path)
      let quality = 85
      let maxEdge = 1000
      let jpeg = await sharp(raw)
        .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer()
      let attempts = 0
      while (jpeg.byteLength > SPOTIFY_COVER_MAX_BYTES && attempts < 5) {
        attempts += 1
        quality = Math.max(50, quality - 10)
        if (attempts >= 3) maxEdge = Math.max(500, Math.floor(maxEdge * 0.85))
        jpeg = await sharp(raw)
          .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality, mozjpeg: true })
          .toBuffer()
      }
      if (jpeg.byteLength > SPOTIFY_COVER_MAX_BYTES) {
        throw new Error(
          `unable to compress image under Spotify's 256KB cover cap after ${String(attempts)} attempts; final size ${String(jpeg.byteLength)} bytes`,
        )
      }
      const base64 = jpeg.toString('base64')
      const api = await buildApi(ctx.home, ctx.callingAgent)
      try {
        await api.makeRequest('PUT', `playlists/${playlistId}/images`, base64, 'image/jpeg')
        return {
          ok: true,
          bytes_uploaded: jpeg.byteLength,
          recompressed: attempts > 0,
          final_quality: quality,
          final_max_edge: maxEdge,
        }
      } catch (err) {
        mapSpotifyError(err)
      }
    },
  })

  return [apiPassthrough, setPlaylistCover]
}

export const SPOTIFY_TOOL_NAMES = ['spotify_api', 'spotify_set_playlist_cover'] as const
