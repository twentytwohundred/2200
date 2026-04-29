/**
 * WebSocket subscription to /api/v1/ws.
 *
 * The connection sends bearer auth via a query param (browsers do not
 * let JS set Authorization headers on WebSocket upgrades). The runtime
 * accepts both `Authorization: Bearer ...` and `?token=...` for the WS
 * route specifically; the URL form is the practical one for browsers.
 *
 * Phase A: emits the events we care about into the TanStack Query
 * cache by invalidating affected queries. The pulse on the Fleet view
 * is driven by `agent.status_changed`. PR F-H subscribe more events.
 *
 * Reconnect: on close, retry with a small backoff (250ms -> 1s -> 5s
 * cap). Heartbeat from the server arrives every 30s; we treat any
 * inbound message (including heartbeat) as liveness.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { getToken } from '../lib/auth'

export interface WsEvent {
  event: string
  occurred_at?: string
  payload: Record<string, unknown>
}

interface LiveSignalContextValue {
  /** "connecting" | "open" | "closed" */
  status: 'connecting' | 'open' | 'closed'
  /** Last error message, or null. */
  lastError: string | null
}

const LiveSignalContext = createContext<LiveSignalContextValue | undefined>(undefined)

interface LiveSignalProviderProps {
  children: ReactNode
  /** Override the WS URL (testing). Default: same-origin /api/v1/ws. */
  url?: string
  /** Skip the connection entirely (testing or SSR). */
  disabled?: boolean
}

function buildWsUrl(override?: string): string {
  if (override) return override
  if (typeof window === 'undefined') return ''
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/api/v1/ws`
}

const RECONNECT_DELAYS = [250, 1_000, 5_000] as const

export function LiveSignalProvider({ children, url, disabled = false }: LiveSignalProviderProps) {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed'>('closed')
  const [lastError, setLastError] = useState<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const attemptRef = useRef(0)
  const cancelledRef = useRef(false)

  const handleEvent = useCallback(
    (ev: WsEvent) => {
      switch (ev.event) {
        case 'agent.status_changed':
        case 'agent.task_started':
        case 'agent.task_finished':
        case 'agent.task_errored':
          void queryClient.invalidateQueries({ queryKey: ['agents'] })
          break
        case 'notification.created':
        case 'notification.answered':
        case 'notification.dismissed':
          void queryClient.invalidateQueries({ queryKey: ['notifications'] })
          break
        case 'budget.threshold_crossed':
          void queryClient.invalidateQueries({ queryKey: ['budget'] })
          break
        case 'hello':
        case 'heartbeat':
        case 'goodbye':
          /* heartbeat ... no cache invalidation */
          break
        default:
          /* unknown event, leave it for now */
          break
      }
    },
    [queryClient],
  )

  useEffect(() => {
    if (disabled) return
    if (typeof window === 'undefined') return

    cancelledRef.current = false

    const connect = () => {
      const token = getToken()
      const base = buildWsUrl(url)
      const fullUrl = token ? `${base}?token=${encodeURIComponent(token)}` : base
      setStatus('connecting')
      let socket: WebSocket
      try {
        socket = new WebSocket(fullUrl)
      } catch (err) {
        setStatus('closed')
        setLastError(err instanceof Error ? err.message : String(err))
        scheduleReconnect()
        return
      }
      wsRef.current = socket
      socket.addEventListener('open', () => {
        if (cancelledRef.current) return
        setStatus('open')
        setLastError(null)
        attemptRef.current = 0
      })
      socket.addEventListener('message', (e) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(typeof e.data === 'string' ? e.data : '')
        } catch {
          return
        }
        if (parsed && typeof parsed === 'object' && 'event' in parsed) {
          handleEvent(parsed as WsEvent)
        }
      })
      socket.addEventListener('close', () => {
        if (cancelledRef.current) return
        setStatus('closed')
        scheduleReconnect()
      })
      socket.addEventListener('error', () => {
        setLastError('WebSocket error')
      })
    }

    const scheduleReconnect = () => {
      if (cancelledRef.current) return
      const idx = Math.min(attemptRef.current, RECONNECT_DELAYS.length - 1)
      const delay = RECONNECT_DELAYS[idx] ?? 5_000
      attemptRef.current += 1
      setTimeout(() => {
        if (!cancelledRef.current) connect()
      }, delay)
    }

    connect()

    return () => {
      cancelledRef.current = true
      const socket = wsRef.current
      if (socket?.readyState === WebSocket.OPEN) {
        socket.close()
      }
      wsRef.current = null
    }
  }, [url, disabled, handleEvent])

  const value = useMemo<LiveSignalContextValue>(() => ({ status, lastError }), [status, lastError])

  return <LiveSignalContext.Provider value={value}>{children}</LiveSignalContext.Provider>
}

export function useLiveSignal(): LiveSignalContextValue {
  const ctx = useContext(LiveSignalContext)
  if (!ctx) throw new Error('useLiveSignal must be used inside a <LiveSignalProvider>')
  return ctx
}
