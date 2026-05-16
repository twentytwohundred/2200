/**
 * Live favicon driver.
 *
 * Mounts once in the app shell. Pulls fleet snapshot from existing
 * sources (agents list, pending notifications, live signal), resolves
 * to a four-state color, and drives a 32×32 canvas → data URL → the
 * <link rel="icon" id="dyn-favicon"> element in index.html.
 *
 * See wiki/design/live-favicon.md for the brief.
 */
import { useEffect, useMemo, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type Agent } from '../lib/api'
import { useLiveSignal } from '../ws/useLiveSignal'
import { drawFavicon } from './draw'
import { faviconStateFor, type FaviconState, type FleetSnapshot } from './state'

const FAVICON_SIZE = 32
const ACTIVE_FRAME_MS = 42 // ~24 fps
const HIDDEN_FRAME_MS = 250 // ~4 fps when the tab is backgrounded
const HIDDEN_GRACE_MS = 1_000

/** Agent statuses that count as "idle / waiting" rather than running or error. */
const IDLE_STATUSES = new Set(['blocked_on_agent', 'blocked_on_detector', 'stopped'])
/** Agent statuses that demand operator attention (raise to `err`). */
const ERROR_STATUSES = new Set(['errored', 'blocked_on_user'])

interface AgentCounts {
  errorCount: number
  idleCount: number
}

function countAgents(agents: Agent[] | undefined): AgentCounts {
  if (!agents) return { errorCount: 0, idleCount: 0 }
  let errorCount = 0
  let idleCount = 0
  for (const a of agents) {
    if (a.archived !== null) continue
    if (ERROR_STATUSES.has(a.status)) errorCount += 1
    else if (IDLE_STATUSES.has(a.status)) idleCount += 1
  }
  return { errorCount, idleCount }
}

interface FleetFaviconState {
  state: FaviconState
  inboxCount: number
}

function useFleetFaviconState(): FleetFaviconState {
  const liveSignal = useLiveSignal()

  // Both queries are already in use elsewhere; reusing the same keys
  // means the favicon piggybacks on the cache without firing extra
  // requests. The 30s refetch interval is a defensive backstop for the
  // case where the WS misses an event (the WS already invalidates
  // these keys on the relevant events).
  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.agents(),
    refetchInterval: 30_000,
  })
  const inboxQuery = useQuery({
    queryKey: ['notifications', { state: 'pending' }],
    queryFn: () => api.notifications({ state: 'pending' }),
    refetchInterval: 30_000,
  })

  return useMemo<FleetFaviconState>(() => {
    const { errorCount, idleCount } = countAgents(agentsQuery.data?.items)
    const inboxCount = inboxQuery.data?.items.length ?? 0
    const snapshot: FleetSnapshot = {
      connected: liveSignal.status === 'open',
      errorCount,
      inboxCount,
      idleCount,
    }
    return {
      state: faviconStateFor(snapshot),
      inboxCount,
    }
  }, [agentsQuery.data, inboxQuery.data, liveSignal.status])
}

/**
 * Mount this once inside the providers in main.tsx. Renders nothing;
 * owns the canvas and the rAF loop for the duration of the page.
 */
export function LiveFavicon(): null {
  const { state, inboxCount } = useFleetFaviconState()

  // Refs so the rAF callback always reads the latest values without
  // tearing down the loop on every state flip.
  const stateRef = useRef(state)
  const inboxRef = useRef(inboxCount)
  useEffect(() => {
    stateRef.current = state
    inboxRef.current = inboxCount
  }, [state, inboxCount])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    const link = ensureFaviconLink()
    if (!link) return undefined

    const canvas = document.createElement('canvas')
    canvas.width = FAVICON_SIZE
    canvas.height = FAVICON_SIZE
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let rafId: number | null = null
    let hiddenAt: number | null = null
    let lastDraw = 0

    const renderOnce = (t: number): void => {
      drawFavicon(ctx, t, {
        state: stateRef.current,
        pulseOn: !reducedMotion,
        inboxCount: inboxRef.current,
        size: FAVICON_SIZE,
      })
      try {
        link.href = canvas.toDataURL('image/png')
      } catch {
        // toDataURL only throws on tainted canvases; this canvas has no
        // foreign images, so the catch is purely defensive. The PNG
        // already in <link rel="apple-touch-icon"> is the fallback.
      }
    }

    const tick = (t: number): void => {
      const hidden = document.visibilityState === 'hidden'
      if (hidden && hiddenAt === null) hiddenAt = t
      if (!hidden) hiddenAt = null

      const inHiddenGrace = hidden && hiddenAt !== null && t - hiddenAt < HIDDEN_GRACE_MS
      const interval = hidden && !inHiddenGrace ? HIDDEN_FRAME_MS : ACTIVE_FRAME_MS

      if (reducedMotion) {
        // Static frame: only redraw when the state or count changes.
        // Cheapest way to detect that here is to compare cached values
        // against the refs; if equal, skip the draw entirely.
        if (
          lastDraw === 0 ||
          cachedState !== stateRef.current ||
          cachedInbox !== inboxRef.current
        ) {
          renderOnce(t)
          cachedState = stateRef.current
          cachedInbox = inboxRef.current
          lastDraw = t
        }
      } else if (t - lastDraw >= interval) {
        renderOnce(t)
        lastDraw = t
      }
      rafId = window.requestAnimationFrame(tick)
    }

    let cachedState: FaviconState | null = null
    let cachedInbox: number | null = null
    rafId = window.requestAnimationFrame(tick)

    const onVisibilityChange = (): void => {
      // Force an immediate redraw on visibility change so a backgrounded
      // tab catching up shows the current state on its next foreground.
      lastDraw = 0
      if (document.visibilityState === 'visible') {
        hiddenAt = null
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  return null
}

function ensureFaviconLink(): HTMLLinkElement | null {
  // Prefer the explicit slot in index.html; fall back to creating one
  // so the component still works in dev or in standalone embeddings.
  const existing = document.getElementById('dyn-favicon')
  if (existing instanceof HTMLLinkElement) return existing
  const link = document.createElement('link')
  link.id = 'dyn-favicon'
  link.rel = 'icon'
  document.head.appendChild(link)
  return link
}
