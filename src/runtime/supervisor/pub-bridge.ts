/**
 * Supervisor-side PubClient bridge.
 *
 * The web app needs a way to read pub messages and (PR2/PR3) post
 * messages and reactions. OpenPub's HTTP surface only exposes
 * `/info` and `/health`; the conversation stream is WebSocket-only.
 * Each Agent process holds its own `PubClient` for its own pub
 * memberships, but those clients are not addressable from outside
 * the agent process.
 *
 * This bridge gives the supervisor a long-lived `PubClient` per pub,
 * authenticated as the local user (Doug, per `<home>/config/user.md`).
 * The web app's `/api/v1/pubs/...` routes read the bridge's rolling
 * buffer; future PRs route POSTs (send + react) through the same
 * client.
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
import type { HomePaths } from '../storage/layout.js'
import { loadUserIdentityIfExists } from '../user/loader.js'
import { readCredentialFile, type PubCredential } from '../pub/keypair.js'
import { PubClient, type PubMessage, type RoomState } from '../pub/client.js'
import { createLogger, type Logger } from '../util/logger.js'
import type { Supervisor } from './supervisor.js'

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
}

export class SupervisorPubBridge {
  private readonly paths: HomePaths
  private readonly supervisor: Supervisor
  private readonly log: Logger
  private readonly entries = new Map<string, PubBridgeEntry>()
  private cred: PubCredential | null = null
  private credLoaded = false

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
    const client = new PubClient({ baseUrl, cred })
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
    const entry: PubBridgeEntry = { client, ready }
    this.entries.set(pubName, entry)
    await ready
    return entry
  }

  private async ensureCred(): Promise<PubCredential | null> {
    if (this.credLoaded) return this.cred
    this.credLoaded = true
    const user = await loadUserIdentityIfExists(this.paths.configUserMd)
    if (!user) return null
    // The user identity schema requires `pub.credentials.source = 'file'`,
    // so the path is always usable directly.
    this.cred = await readCredentialFile(user.frontmatter.pub.credentials.id)
    return this.cred
  }
}

export class PubBridgeError extends Error {
  constructor(
    readonly code: 'no_user_identity' | 'connect_failed',
    message: string,
  ) {
    super(message)
    this.name = 'PubBridgeError'
  }
}
