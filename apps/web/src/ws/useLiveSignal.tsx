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
import type { Agent, ListEnvelope, Pulse } from '../lib/api'

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
        case 'agent.task_errored': {
          void queryClient.invalidateQueries({ queryKey: ['agents'] })
          // Also invalidate the per-Agent tasks list when the runtime
          // signals a task state change. The task list is keyed on
          // ['tasks', name]; invalidate the whole 'tasks' prefix so
          // any open AgentDetail view refreshes immediately.
          const agentName = 'agent' in ev.payload ? (ev.payload as { agent?: unknown }).agent : null
          if (typeof agentName === 'string') {
            void queryClient.invalidateQueries({ queryKey: ['tasks', agentName] })
          } else {
            void queryClient.invalidateQueries({ queryKey: ['tasks'] })
          }
          break
        }
        case 'pulse.changed': {
          // Pulse events arrive frequently (one per pulse.json update,
          // ~1/s when an agent is active). Invalidating the agents
          // query on every event would re-fetch the full list at the
          // same cadence; instead surgically patch the affected
          // agent's `pulse` field in the cache so the PulseDot
          // re-renders without a network round trip.
          patchAgentPulseInCache(queryClient, ev.payload)
          // Soft-invalidate the per-Agent tasks list at the pulse
          // cadence so a working Agent's tasks panel keeps up with
          // state transitions even when no explicit task event fires
          // (the runtime doesn't yet emit task lifecycle events).
          // Pulse fires only when the agent is active, so this is
          // self-throttling.
          const agentName = 'agent' in ev.payload ? (ev.payload as { agent?: unknown }).agent : null
          if (typeof agentName === 'string') {
            void queryClient.invalidateQueries({
              queryKey: ['tasks', agentName],
              refetchType: 'active',
            })
          }
          break
        }
        case 'notification.created':
        case 'notification.answered':
        case 'notification.dismissed':
          void queryClient.invalidateQueries({ queryKey: ['notifications'] })
          break
        case 'budget.threshold_crossed':
          void queryClient.invalidateQueries({ queryKey: ['budget'] })
          break
        case 'chat.message':
        case 'chat.created':
        case 'chat.renamed':
        case 'chat.archived':
        case 'chat.read': {
          const agent = typeof ev.payload.agent === 'string' ? ev.payload.agent : null
          const chatId = typeof ev.payload.chat_id === 'string' ? ev.payload.chat_id : null
          if (agent !== null) {
            void queryClient.invalidateQueries({ queryKey: ['agentChats', agent] })
            if (chatId !== null) {
              void queryClient.invalidateQueries({
                queryKey: ['agentChatMessages', agent, chatId],
              })
            }
          }
          break
        }
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

/**
 * Patch one agent's `pulse` field across every active `agents`
 * query in the TanStack Query cache. Skips updates when the payload
 * shape is wrong or when the named agent is not in the cached list
 * (no-op until the next list query lands).
 *
 * Surgical update beats a full invalidate for pulse events because
 * the cadence is high (~1/s during activity) and the payload size
 * is modest; refetching the full agents list on every pulse tick
 * would multiply API traffic for no UX gain.
 */
function patchAgentPulseInCache(
  queryClient: ReturnType<typeof useQueryClient>,
  payload: Record<string, unknown>,
): void {
  const agentName = typeof payload.agent === 'string' ? payload.agent : null
  const pulseRaw = payload.pulse
  if (!agentName || !isPulse(pulseRaw)) return
  // List cache: `['agents']` exact. The fleet view consumes this.
  // Use exact:true so the partial-prefix match does NOT also fire
  // against `['agents', <name>]` (the detail cache, different shape).
  queryClient.setQueriesData<ListEnvelope<Agent>>(
    { queryKey: ['agents'], exact: true },
    (current) => {
      if (!current) return current
      const idx = current.items.findIndex((a) => a.name === agentName)
      if (idx === -1) return current
      const items = current.items.slice()
      const target = items[idx]
      if (!target) return current
      items[idx] = { ...target, pulse: pulseRaw }
      return { ...current, items }
    },
  )
  // Single-agent cache: `['agents', name]` exact. The AgentDetail
  // screen consumes this, so patching keeps the hero / status section
  // live without a round-trip.
  queryClient.setQueriesData<Agent>({ queryKey: ['agents', agentName], exact: true }, (current) => {
    if (!current) return current
    return { ...current, pulse: pulseRaw }
  })
}

function isPulse(value: unknown): value is Pulse {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<Pulse>
  return (
    typeof v.state === 'string' &&
    typeof v.intensity === 'number' &&
    typeof v.updated_at === 'string'
  )
}
