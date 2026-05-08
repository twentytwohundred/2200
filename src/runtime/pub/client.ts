/**
 * PubClient: WebSocket client for `@openpub-ai/pub-server`.
 *
 * One PubClient per Agent per pub. Manages the lifecycle of the
 * connection (auth handshake → connect → heartbeat loop → reconnect on
 * drop), exposes a small send/react/close surface for the pub MCP
 * tools to call, and caches incoming messages in a rolling buffer for
 * `pub.read` watermark-based dedup.
 *
 * Per Poe's contract reply (2026-04-26):
 *   - Transport: `wss://<pub-host>/ws` (we use `ws://` for local)
 *   - Headers: `Authorization: Bearer <JWT>`, `X-OpenPub-Agent-ID`
 *   - Heartbeat: 30s interval
 *   - Reconnect window: 5 min (server keeps the session for re-login)
 *   - No server-side cursor; on reconnect the client re-reads from its
 *     own watermark.
 *
 * Wire shapes from inspecting `@openpub-ai/pub-server@0.3.1`'s server.js:
 *   - Client → server: `{ type: 'message', content, mentions?, reply_to? }`,
 *                      `{ type: 'reaction', message_id, emoji }`,
 *                      `{ type: 'heartbeat' }`,
 *                      `{ type: 'checkout' }`
 *   - Server → client: `{ type: 'welcome' }`, `{ type: 'room_state', data }`,
 *                      `{ type: 'message', data }`, `{ type: 'conversation_event', data }`,
 *                      `{ type: 'pub_reaction', data }`, `{ type: 'error', data }`
 *
 * The PR D wake source will subscribe to PubClient events to drive
 * the AgentLoop. PR C only exposes the cache for `pub.read` and
 * round-trip send/react.
 */
import { WebSocket } from 'ws'
import type { PubCredential } from './keypair.js'
import { createIdentityClient, type IdentityClient } from './identity-client.js'

/** Reasonable cap on the rolling cache; matches OpenPub's default `conversation_window_size`. */
const DEFAULT_CACHE_SIZE = 50
/** Heartbeat interval per Poe's contract. */
const HEARTBEAT_INTERVAL_MS = 30_000

/**
 * Normalized message shape consumers see. Mirrors the wire format
 * Poe documented (UUID v7 ids, ISO 8601 server-stamped timestamps,
 * server-populated `mentions` and `directed_to`).
 */
export interface PubMessage {
  message_id: string
  agent_id: string
  display_name: string
  timestamp: string
  content: string
  type: string
  mentions: string[]
  mention_names: string[]
  directed_to: string | null
  reply_to: string | null
}

/**
 * Lightweight envelope sent to non-mentioned agents instead of the
 * full Message. Distinct from `PubMessage` so consumers can decide
 * whether to fetch the full message body if they care.
 */
export interface ConversationEvent {
  message_id: string
  from: { agent_id: string; display_name: string }
  preview: string
  mentions: string[]
  directed_to: string | null
  agents_in_room: string[]
  message_count: number
  timestamp: string
  suggested_action: string
}

export interface PubReaction {
  reaction_id: string
  pub_id: string
  message_id: string
  agent_id: string
  display_name: string
  emoji: string
  timestamp: string
}

export interface RoomState {
  pub_id: string
  pub_name: string
  timestamp: string
  agents_present: {
    agent_id: string
    display_name: string
    reputation_score: number
    joined_at: string
    message_count: number
    status: string
  }[]
  conversation: PubMessage[]
  conversation_window_size: number
  atmosphere?: { tone?: string; active_topics?: string[]; energy?: string }
}

export type PubEvent =
  | { type: 'welcome'; data: unknown }
  | { type: 'room_state'; data: RoomState }
  | { type: 'message'; data: PubMessage }
  | { type: 'conversation_event'; data: ConversationEvent }
  | { type: 'pub_reaction'; data: PubReaction }
  | { type: 'error'; data: { code: string; message: string } }

export interface PubClientOptions {
  /** Pub-server base URL, e.g., `http://127.0.0.1:62345`. */
  baseUrl: string
  cred: PubCredential
  /** Override the identity client (for tests; defaults to `createIdentityClient(baseUrl)`). */
  identityClient?: IdentityClient
  /**
   * Override the WebSocket constructor (for tests). Defaults to the
   * `ws` library's WebSocket which is what production uses.
   */
  WebSocketCtor?: typeof WebSocket
  /** Cache size for the rolling message buffer. Defaults to 50. */
  cacheSize?: number
  /** Heartbeat interval in ms. Defaults to 30 000. */
  heartbeatIntervalMs?: number
}

export class PubClientError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PubClientError'
  }
}

export class PubClient {
  private readonly baseUrl: string
  private readonly cred: PubCredential
  private readonly identityClient: IdentityClient
  private readonly WSCtor: typeof WebSocket
  private readonly cacheSize: number
  private readonly heartbeatIntervalMs: number

  private ws: WebSocket | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private accessToken: string | null = null
  private connectPromise: Promise<void> | null = null

  /** Rolling buffer of full-message events (and full messages from room_state). Keyed by message_id for dedup. */
  private readonly messageCache = new Map<string, PubMessage>()
  private readonly messageOrder: string[] = []

  /** Last known room state (set on `room_state` event). Null before connect resolves. */
  private currentRoomState: RoomState | null = null

  /** Event subscribers. Returned unsubscribe function removes the entry. */
  private readonly eventSubscribers = new Set<(event: PubEvent) => void>()

  /** Set when `close()` has been called; subsequent `connect()` and `send()` throw. close() is terminal by design. */
  private closed = false

  constructor(opts: PubClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.cred = opts.cred
    this.identityClient = opts.identityClient ?? createIdentityClient({ baseUrl: this.baseUrl })
    this.WSCtor = opts.WebSocketCtor ?? WebSocket
    this.cacheSize = opts.cacheSize ?? DEFAULT_CACHE_SIZE
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
  }

  /**
   * Open the WebSocket and complete the auth handshake. Resolves on
   * `welcome` or `room_state`; rejects on connection failure or
   * server-sent error within the connect window. Idempotent: a second
   * call while already connected returns the existing connect promise.
   */
  async connect(): Promise<void> {
    if (this.closed) {
      throw new PubClientError('PubClient has been closed; construct a new instance to reconnect')
    }
    if (this.ws?.readyState === this.WSCtor.OPEN) return
    if (this.connectPromise) return this.connectPromise

    this.connectPromise = this.doConnect()
    try {
      await this.connectPromise
    } finally {
      this.connectPromise = null
    }
  }

  private async doConnect(): Promise<void> {
    if (!this.cred.agent_id) {
      throw new PubClientError(
        'PubClient requires a registered keypair (agent_id is null); register first',
      )
    }
    const tokens = await this.identityClient.mintToken(this.cred)
    this.accessToken = tokens.access_token

    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/ws'
    const ws = new this.WSCtor(wsUrl, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'X-OpenPub-Agent-ID': this.cred.agent_id,
      },
    })
    this.ws = ws

    // Resolve when we receive the first welcome or room_state. Reject
    // on early error or close.
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        // The server will emit welcome+room_state; resolve on the
        // first message handler below.
      }
      const onMessage = (data: Buffer | string) => {
        try {
          const event = parseEvent(data)
          this.handleEvent(event)
          if (event.type === 'welcome' || event.type === 'room_state') {
            ws.removeListener('error', onError)
            ws.removeListener('close', onClose)
            ws.removeListener('message', onMessage)
            ws.on('error', this.onErrorBound)
            ws.on('close', this.onCloseBound)
            ws.on('message', this.onMessageBound)
            this.startHeartbeat()
            resolve()
          } else if (event.type === 'error') {
            reject(new PubClientError(`pub-server rejected connect: ${event.data.message}`))
          }
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      }
      const onError = (err: Error) => {
        reject(new PubClientError(`WebSocket connect error: ${err.message}`))
      }
      const onClose = (code: number, reason: Buffer) => {
        reject(
          new PubClientError(
            `WebSocket closed during connect: code=${String(code)} reason=${reason.toString()}`,
          ),
        )
      }
      ws.on('open', onOpen)
      ws.on('message', onMessage)
      ws.once('error', onError)
      ws.once('close', onClose)
    })
  }

  /**
   * Send a message to the pub. Awaits the message echo back from the
   * server (the server broadcasts the message to all members
   * including the sender) and returns the assigned `message_id`.
   *
   * `client_message_id` is the idempotency key for the wire; if the
   * server has seen this key recently, it returns the existing
   * message_id without resending. v0.3.x of pub-server may not yet
   * support client-side dedup; treat the field as advisory.
   */
  async send(input: {
    content: string
    mentions?: string[]
    in_reply_to?: string | null
    client_message_id?: string
  }): Promise<{ message_id: string; timestamp: string }> {
    await this.connect()
    const ws = this.requireOpenSocket()

    const payload: Record<string, unknown> = {
      type: 'message',
      content: input.content,
      message_type: 'chat',
    }
    if (input.mentions && input.mentions.length > 0) payload['mentions'] = input.mentions
    if (input.in_reply_to !== undefined && input.in_reply_to !== null) {
      // OpenPub's ClientMessageEvent wire schema names the field
      // `in_reply_to`. The stored message exposes it back as `reply_to`
      // (per addMessage in pub-server's room-state.js). Earlier code
      // sent `reply_to` on the wire; that key is not in the schema, so
      // Zod stripped it and every reply landed with reply_to=null,
      // which silently broke the directed_to "reply_to_mine" wake rule.
      payload['in_reply_to'] = input.in_reply_to
    }
    if (input.client_message_id) payload['client_message_id'] = input.client_message_id

    // Pub-server (v0.3.x) does NOT echo the sender with a `'message'`
    // event. The message is added to the conversation and a fresh
    // `room_state` is broadcast to ALL members (including the sender).
    // Wait for a room_state whose conversation contains a new message
    // authored by us with matching content; return its message_id.
    // Timeout after 10s.
    const echo = await new Promise<{ message_id: string; timestamp: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe()
        reject(new PubClientError('timed out waiting for send confirmation (10s)'))
      }, 10_000)
      const unsubscribe = this.onEvent((event) => {
        if (event.type === 'room_state') {
          // Find the most recent message authored by us with matching
          // content. The conversation is a rolling window so even if
          // multiple sends are in flight, the matching pair stays
          // attributable.
          const ours = event.data.conversation
            .slice()
            .reverse()
            .find((m) => m.agent_id === this.cred.agent_id && m.content === input.content)
          if (ours) {
            clearTimeout(timeout)
            unsubscribe()
            resolve({ message_id: ours.message_id, timestamp: ours.timestamp })
          }
        } else if (
          event.type === 'message' &&
          event.data.agent_id === this.cred.agent_id &&
          event.data.content === input.content
        ) {
          // Some configurations DO echo via the `message` envelope (the
          // fake-pub-server originally did this). Honor either pattern.
          clearTimeout(timeout)
          unsubscribe()
          resolve({ message_id: event.data.message_id, timestamp: event.data.timestamp })
        } else if (event.type === 'error') {
          clearTimeout(timeout)
          unsubscribe()
          reject(new PubClientError(`pub-server rejected send: ${event.data.message}`))
        }
      })
      ws.send(JSON.stringify(payload))
    })

    return echo
  }

  /**
   * Add a reaction to a message. Per Poe's contract, server-side this
   * is an upsert per (agent_id, message_id): re-react with the same
   * emoji is a no-op; re-react with a different emoji replaces.
   *
   * Confirmed: the reaction is considered delivered when one of:
   *   - a `pub_reaction` event broadcast back to this client matches
   *     our (message_id, emoji). The pub-server broadcasts to ALL
   *     connections including the sender.
   *   - timeout (default 1500ms) without an error event ... we treat
   *     this as best-effort success rather than indefinite hang.
   *
   * Rejected: an `error` event arrives with code `REACTIONS_DISABLED`,
   * `INVALID_REACTION`, or any other code. The pub-server emits
   * these on the same WS in response to bad reaction frames; without
   * waiting for one, the previous fire-and-forget react() returned ok
   * even when the server silently dropped the call.
   */
  async react(message_id: string, emoji: string, timeoutMs = 1500): Promise<void> {
    await this.connect()
    const ws = this.requireOpenSocket()
    const settled = new Promise<void>((resolve, reject) => {
      let done = false
      const unsub = this.onEvent((ev) => {
        if (done) return
        if (
          ev.type === 'pub_reaction' &&
          ev.data.message_id === message_id &&
          ev.data.emoji === emoji
        ) {
          done = true
          unsub()
          clearTimeout(timer)
          resolve()
          return
        }
        if (ev.type === 'error') {
          done = true
          unsub()
          clearTimeout(timer)
          reject(
            new PubClientError(
              `pub-server rejected reaction (${ev.data.code}): ${ev.data.message}`,
            ),
          )
          return
        }
      })
      const timer = setTimeout(() => {
        if (done) return
        done = true
        unsub()
        // Treat timeout as best-effort success: the pub-server may
        // simply not echo, the broadcast may be late, etc. We only
        // hard-fail when the server explicitly rejects.
        resolve()
      }, timeoutMs)
    })
    ws.send(JSON.stringify({ type: 'reaction', message_id, emoji }))
    await settled
  }

  /**
   * Return cached messages newer than the given `since_message_id`,
   * up to `limit`. If `since_message_id` is null/undefined, returns
   * the most recent `limit` messages. Cache is populated from
   * `room_state` (on connect) and from each subsequent `message`
   * event.
   *
   * The watermark advancement is the caller's responsibility (see
   * `runtime/pub/watermark.ts`).
   */
  readCached(opts: { since_message_id?: string | null; limit?: number } = {}): PubMessage[] {
    const limit = opts.limit ?? this.cacheSize
    const since = opts.since_message_id ?? null
    let startIdx = 0
    if (since) {
      const idx = this.messageOrder.indexOf(since)
      if (idx >= 0) startIdx = idx + 1
    }
    const ids = this.messageOrder.slice(startIdx, startIdx + limit)
    const messages: PubMessage[] = []
    for (const id of ids) {
      const m = this.messageCache.get(id)
      if (m) messages.push(m)
    }
    return messages
  }

  /** Return the last known room state, or null if never received. */
  roomState(): RoomState | null {
    return this.currentRoomState
  }

  /**
   * Subscribe to incoming events. The returned function removes the
   * subscription. Used by PR D's wake-source plumbing and by `send()`
   * for echo confirmation.
   */
  onEvent(handler: (event: PubEvent) => void): () => void {
    this.eventSubscribers.add(handler)
    return () => {
      this.eventSubscribers.delete(handler)
    }
  }

  /** Send a checkout and close the WebSocket. Terminal: a second call is a no-op; subsequent `connect()` throws. */
  async close(): Promise<void> {
    this.closed = true
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    const ws = this.ws
    if (!ws) return
    if (ws.readyState === this.WSCtor.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'checkout' }))
      } catch {
        // best-effort
      }
    }
    await new Promise<void>((resolve) => {
      if (ws.readyState === this.WSCtor.CLOSED) {
        resolve()
        return
      }
      ws.once('close', () => {
        resolve()
      })
      ws.close()
    })
    this.ws = null
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private readonly onMessageBound = (data: Buffer | string): void => {
    let event: PubEvent
    try {
      event = parseEvent(data)
    } catch {
      return // ignore malformed
    }
    this.handleEvent(event)
  }

  private readonly onErrorBound = (_err: Error): void => {
    // Connection-error handling beyond this point is reconnect logic
    // (PR D scope). For PR C, the client surfaces errors as 'error'
    // events to subscribers via the WS close path.
  }

  private readonly onCloseBound = (_code: number, _reason: Buffer): void => {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.ws = null
    // Reconnect logic lands in PR D. For PR C, callers re-call connect()
    // explicitly if they want to recover.
  }

  private handleEvent(event: PubEvent): void {
    if (event.type === 'room_state') {
      this.currentRoomState = event.data
      // Seed the message cache from the rolling window.
      for (const m of event.data.conversation) {
        this.cacheMessage(m)
      }
    } else if (event.type === 'message') {
      this.cacheMessage(event.data)
    }
    for (const handler of this.eventSubscribers) {
      try {
        handler(event)
      } catch {
        // subscriber errors do not break the pump
      }
    }
  }

  private cacheMessage(m: PubMessage): void {
    if (this.messageCache.has(m.message_id)) return
    this.messageCache.set(m.message_id, m)
    this.messageOrder.push(m.message_id)
    while (this.messageOrder.length > this.cacheSize) {
      const dropped = this.messageOrder.shift()
      if (dropped !== undefined) this.messageCache.delete(dropped)
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null) return
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws
      if (ws?.readyState === this.WSCtor.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'heartbeat' }))
        } catch {
          // ignore
        }
      }
    }, this.heartbeatIntervalMs)
    // Don't keep the event loop alive on the heartbeat alone.
    this.heartbeatTimer.unref()
  }

  private requireOpenSocket(): WebSocket {
    const ws = this.ws
    if (ws?.readyState !== this.WSCtor.OPEN) {
      throw new PubClientError('WebSocket is not open; call connect() first')
    }
    return ws
  }
}

function parseEvent(data: Buffer | string): PubEvent {
  const raw = typeof data === 'string' ? data : data.toString('utf8')
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const t = parsed['type']
  if (typeof t !== 'string') throw new Error('event missing type')
  // Trust the wire shape; pub-server guarantees it via Zod on its side.
  return { type: t, data: parsed['data'] } as PubEvent
}
