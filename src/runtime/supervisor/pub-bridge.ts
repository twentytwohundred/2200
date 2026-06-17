/**
 * Supervisor-side PubClient bridge.
 *
 * The web app needs a way to read pub messages and to post
 * messages + reactions. OpenPub's HTTP surface only exposes `/info`
 * and `/health`; the conversation stream is WebSocket-only. Each
 * Agent process holds its own `PubClient` for its own pub
 * memberships, but those clients are not addressable from outside
 * the agent process.
 *
 * This bridge gives the supervisor a long-lived `PubClient` per pub,
 * authenticated as the local user (per `<home>/config/user.md`).
 * The web app's `/api/v1/pubs/...` routes read the bridge's rolling
 * buffer; POSTs (send + react) route through the same client so the
 * pub server attributes them to the operator's own handle.
 *
 * Lifecycle:
 *   - Bridges are lazy: the first call to `getMessages(pub)` (or
 *     `getRoomState`, etc.) triggers the connect handshake. Failures
 *     surface to the API as `pub_unavailable`.
 *   - Bridges stay alive for the supervisor's process lifetime and
 *     reuse the rolling cache. `close()` tears them all down on
 *     shutdown.
 *   - One bridge per pub; same pub-name → same client. The bridge
 *     does not currently rebuild on pub-server restart; in practice
 *     the daemon restarts both, so v1 doesn't need that fancy.
 */
import { type HomePaths, pubPaths } from '../storage/layout.js'
import { loadUserIdentityIfExists } from '../user/loader.js'
import {
  credForPub,
  readCredentialFile,
  writeCredentialFile,
  type PubCredential,
} from '../pub/keypair.js'
import { createIdentityClient, ensureRegistered } from '../pub/identity-client.js'
import { readPubSecrets } from '../pub/secrets.js'
import { PubClient, type PubMessage, type PubReaction, type RoomState } from '../pub/client.js'
import { createLogger, type Logger } from '../util/logger.js'
import type { Supervisor } from './supervisor.js'

/** Cap reactions tracked per pub. Older entries get dropped FIFO. */
const REACTIONS_CAP = 500

export interface SupervisorPubBridgeOptions {
  home: string
  paths: HomePaths
  supervisor: Supervisor
  logger?: Logger
}

interface PubBridgeEntry {
  client: PubClient
  /** Connect promise; resolved once the handshake completes. */
  ready: Promise<void>
  /**
   * Per-pub reaction store keyed by message_id. The pub-server upserts
   * (agent_id, message_id) → emoji, so newer events replace older ones
   * with the same agent. We mirror that semantic here.
   */
  reactions: Map<string, PubReaction[]>
  /** Insertion order of message_ids in `reactions`, used for FIFO eviction. */
  reactionOrder: string[]
}

export class SupervisorPubBridge {
  private readonly paths: HomePaths
  private readonly supervisor: Supervisor
  private readonly log: Logger
  private readonly entries = new Map<string, PubBridgeEntry>()
  private cred: PubCredential | null = null

  constructor(opts: SupervisorPubBridgeOptions) {
    this.paths = opts.paths
    this.supervisor = opts.supervisor
    this.log = opts.logger ?? createLogger('supervisor/pub-bridge')
  }

  /**
   * Read recent messages from the pub's rolling buffer. Connects on
   * first call. Returns `null` when the pub is unknown to the
   * supervisor; throws `PubBridgeError` for connect/auth failures.
   */
  async getMessages(
    pubName: string,
    opts: { limit?: number; since?: string | null } = {},
  ): Promise<PubMessage[] | null> {
    const entry = await this.acquire(pubName)
    if (!entry) return null
    return entry.client.readCached({
      limit: opts.limit ?? 50,
      since_message_id: opts.since ?? null,
    })
  }

  /**
   * Latest known room state (members list + conversation window).
   * Same lifecycle as `getMessages`.
   */
  async getRoomState(pubName: string): Promise<RoomState | null> {
    const entry = await this.acquire(pubName)
    if (!entry) return null
    return entry.client.roomState()
  }

  /**
   * Reactions tracked per message in this pub since the bridge connected.
   * Returns an empty map for unknown / unreached pubs.
   */
  async getReactions(pubName: string): Promise<ReadonlyMap<string, PubReaction[]>> {
    const entry = await this.acquire(pubName)
    if (!entry) return new Map()
    return entry.reactions
  }

  /**
   * Send a message to the pub on behalf of the local user. The
   * pub-server stamps the sender with whatever handle the user
   * identity declares and broadcasts to all members.
   */
  async send(
    pubName: string,
    input: { content: string; mentions?: string[]; reply_to?: string | null },
  ): Promise<{ message_id: string; timestamp: string }> {
    const entry = await this.acquire(pubName)
    if (!entry) {
      throw new PubBridgeError('pub_not_running', `pub "${pubName}" is not running`)
    }
    const sendInput: Parameters<PubClient['send']>[0] = { content: input.content }
    if (input.mentions !== undefined) sendInput.mentions = input.mentions
    if (input.reply_to !== undefined) sendInput.in_reply_to = input.reply_to
    return entry.client.send(sendInput)
  }

  /**
   * React to a message. The pub-server upserts (agent_id, message_id)
   * → emoji; re-reacting with the same emoji is a no-op, with a
   * different emoji replaces the existing entry.
   *
   * Side effect: we also mirror the reaction into our local map.
   * OpenPub does not consistently echo `pub_reaction` events back to
   * the sender, so without this mirror the web UI would not see its
   * own reactions until another reactor caused a refresh.
   */
  async react(pubName: string, messageId: string, emoji: string): Promise<void> {
    const entry = await this.acquire(pubName)
    if (!entry) {
      throw new PubBridgeError('pub_not_running', `pub "${pubName}" is not running`)
    }
    await entry.client.react(messageId, emoji)
    if (this.cred) {
      const synthetic: PubReaction = {
        reaction_id: `local:${Date.now().toString()}`,
        pub_id: '',
        message_id: messageId,
        agent_id: this.cred.agent_id ?? 'self',
        display_name: this.cred.display_name,
        emoji,
        timestamp: new Date().toISOString(),
      }
      mirrorReaction(entry, synthetic)
    }
  }

  /**
   * Drop the cached connection for one pub so the next request reconnects
   * with a freshly-read cred. Used after the operator's identity is renamed +
   * re-registered (setUserDisplayName): the live WS is authenticated as the
   * OLD identity, so without this the operator keeps appearing + posting under
   * the old name until the daemon restarts. No-op if not currently connected.
   */
  async reconnect(pubName: string): Promise<void> {
    const entry = this.entries.get(pubName)
    if (!entry) return
    this.entries.delete(pubName)
    try {
      await entry.client.close()
    } catch {
      // best-effort; a failed close still drops the entry so the next
      // acquire() rebuilds the connection with the new cred.
    }
  }

  /**
   * Close all bridge connections. Called from the supervisor's
   * shutdown path so the WS clients exit cleanly.
   */
  async close(): Promise<void> {
    const all = Array.from(this.entries.values())
    this.entries.clear()
    await Promise.all(
      all.map(async (e) => {
        try {
          await e.client.close()
        } catch {
          // best-effort; the supervisor is going down anyway
        }
      }),
    )
  }

  private async acquire(pubName: string): Promise<PubBridgeEntry | null> {
    const existing = this.entries.get(pubName)
    if (existing) {
      await existing.ready
      return existing
    }
    const pub = this.supervisor.snapshot().pubs[pubName]
    if (pub?.state !== 'running') {
      return null
    }
    const cred = await this.ensureCred()
    if (!cred) {
      throw new PubBridgeError(
        'no_user_identity',
        `cannot connect supervisor pub bridge: ${this.paths.configUserMd} is missing or has no pub credentials`,
      )
    }
    const baseUrl = `http://127.0.0.1:${String(pub.port)}`
    // Auto-register the user on first contact with this pub. Rooms
    // created before the per-pub agent_id substrate landed do not
    // have a user entry in cred.pub_agent_ids, and the supervisor's
    // bridge cannot mint a token without one. ensureRegistered is
    // idempotent (getMe first; 404 -> register; matched id ->
    // return as-is), so the cost is one round-trip per pub
    // per supervisor lifetime when the entry is missing.
    let effectiveCred = cred
    if (!cred.pub_agent_ids?.[pub.name] && !cred.agent_id) {
      // No fallback either; nothing to authenticate with yet. Pass
      // through so the eventual mintToken returns a clean error.
    } else if (!cred.pub_agent_ids?.[pub.name]) {
      try {
        const adminSecret = await readAdminSecretForPub(this.paths.home, pub.name)
        const identityClient = createIdentityClient({ baseUrl })
        const updated = await ensureRegistered(identityClient, cred, adminSecret, pub.name)
        if (updated !== cred) {
          await persistUserCred(this.paths, updated)
          effectiveCred = updated
        }
      } catch (err) {
        this.log.warn('supervisor pub bridge: user auto-register failed; continuing', {
          pub: pub.name,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    const client = new PubClient({ baseUrl, cred: credForPub(effectiveCred, pub.name) })
    const reactions = new Map<string, PubReaction[]>()
    const reactionOrder: string[] = []
    // Track reactions in-band: every time the pub-server broadcasts
    // a `pub_reaction` event, we upsert (agent_id, message_id) → emoji
    // into the per-pub map. The pub-server treats this as the source
    // of truth, so we follow its semantic.
    client.onEvent((ev) => {
      if (ev.type !== 'pub_reaction') return
      mirrorReaction({ client, ready: Promise.resolve(), reactions, reactionOrder }, ev.data)
    })
    const ready = client
      .connect()
      .then(() => {
        this.log.info('supervisor pub bridge connected', { pub: pubName, port: pub.port })
      })
      .catch((err: unknown) => {
        // Drop the entry on failure so the next request retries.
        this.entries.delete(pubName)
        const message = err instanceof Error ? err.message : String(err)
        this.log.warn('supervisor pub bridge connect failed', { pub: pubName, error: message })
        throw new PubBridgeError('connect_failed', message)
      })
    const entry: PubBridgeEntry = { client, ready, reactions, reactionOrder }
    this.entries.set(pubName, entry)
    await ready
    return entry
  }

  private async ensureCred(): Promise<PubCredential | null> {
    // Re-read on every connect attempt. The supervisor's "create
    // room" flow appends new per-pub agent_ids to the cred file; a
    // long-lived cache would lock the bridge into the cred snapshot
    // it had at boot and reject every newly-created pub. The cost
    // is one file read per connect, which is negligible compared to
    // the network round-trip that follows.
    const user = await loadUserIdentityIfExists(this.paths.configUserMd)
    if (!user) {
      this.cred = null
      return null
    }
    this.cred = await readCredentialFile(user.frontmatter.pub.credentials.id)
    return this.cred
  }
}

function mirrorReaction(entry: PubBridgeEntry, r: PubReaction): void {
  const list = entry.reactions.get(r.message_id) ?? []
  const existing = list.findIndex((x) => x.agent_id === r.agent_id)
  if (existing >= 0) {
    list[existing] = r
  } else {
    list.push(r)
  }
  if (!entry.reactions.has(r.message_id)) {
    entry.reactionOrder.push(r.message_id)
  }
  entry.reactions.set(r.message_id, list)
  while (entry.reactionOrder.length > REACTIONS_CAP) {
    const drop = entry.reactionOrder.shift()
    if (drop) entry.reactions.delete(drop)
  }
}

export class PubBridgeError extends Error {
  constructor(
    readonly code: 'no_user_identity' | 'connect_failed' | 'pub_not_running',
    message: string,
  ) {
    super(message)
    this.name = 'PubBridgeError'
  }
}

async function readAdminSecretForPub(home: string, pubName: string): Promise<string> {
  const pp = pubPaths(home, pubName)
  const secrets = await readPubSecrets({
    adminSecret: pp.adminSecret,
    signingKey: pp.signingKey,
  })
  return secrets.adminSecret
}

async function persistUserCred(paths: HomePaths, cred: PubCredential): Promise<void> {
  const user = await loadUserIdentityIfExists(paths.configUserMd)
  if (!user) return
  await writeCredentialFile(user.frontmatter.pub.credentials.id, cred)
}
