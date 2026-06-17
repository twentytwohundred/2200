/**
 * Token refresh service (Epic 9 Phase B-3).
 *
 * Lives in the supervisor process. On a periodic tick, scans every
 * Agent's vault for OAuth credentials whose `expires_at` is within
 * `refreshWindowMs` of now. For each, looks up the companion
 * `<name>-refresh` entry, calls the provider's token endpoint, and
 * replaces the access-token entry (rotating the refresh-token entry
 * if the provider rotates).
 *
 * Failure handling:
 *   - Missing client credentials: log warn, skip the entry. The user
 *     unset the env vars; we don't crash the supervisor.
 *   - Network / provider error: log warn, mark a per-credential cooldown
 *     so we don't hammer the provider every tick.
 *   - Cooldown after failure: 60s (kept short for v1; tune later).
 *
 * Catch-up policy: if `expires_at` is already in the past, refresh
 * immediately on the next tick. We do NOT pre-emptively race the wall
 * clock; expiry-driven is enough.
 */
import { readdir } from 'node:fs/promises'
import { CredentialVault } from '../credentials/vault.js'
import { homePaths } from '../storage/layout.js'
import { createLogger, type Logger } from '../util/logger.js'
import { findProvider, readClientCredentials } from './providers.js'
import { refreshAccessToken } from './refresh.js'
import { OAuthError, type OAuthTokenResponse } from './types.js'

export interface TokenRefreshOptions {
  home: string
  /** Tick period. Default 60s. */
  intervalMs?: number
  /** Refresh anything expiring within this window. Default 5 min. */
  refreshWindowMs?: number
  /** Cooldown after a failure before retrying that credential. Default 60s. */
  failureCooldownMs?: number
  /** Inject for tests. Default Date. */
  now?: () => Date
  /** Inject for tests. Default setInterval. */
  setTimer?: (cb: () => void, ms: number) => NodeJS.Timeout
  /** Inject for tests. Default clearInterval. */
  clearTimer?: (h: NodeJS.Timeout) => void
  /** Inject fetch for tests. */
  fetchImpl?: typeof fetch
  logger?: Logger
}

export interface TokenRefreshTickStats {
  scanned: number
  refreshed: number
  failed: number
  skipped: number
}

export class TokenRefreshService {
  private readonly home: string
  private readonly intervalMs: number
  private readonly refreshWindowMs: number
  private readonly failureCooldownMs: number
  private readonly nowFn: () => Date
  private readonly setTimer: (cb: () => void, ms: number) => NodeJS.Timeout
  private readonly clearTimer: (h: NodeJS.Timeout) => void
  private readonly fetchImpl: typeof fetch | undefined
  private readonly log: Logger

  /** key = `<agent>:<credential>` -> earliest time we may retry. */
  private readonly cooldowns = new Map<string, number>()
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(opts: TokenRefreshOptions) {
    this.home = opts.home
    this.intervalMs = opts.intervalMs ?? 60_000
    this.refreshWindowMs = opts.refreshWindowMs ?? 5 * 60_000
    this.failureCooldownMs = opts.failureCooldownMs ?? 60_000
    this.nowFn = opts.now ?? (() => new Date())
    this.setTimer = opts.setTimer ?? ((cb, ms) => setInterval(cb, ms))
    this.clearTimer =
      opts.clearTimer ??
      ((h) => {
        clearInterval(h)
      })
    this.fetchImpl = opts.fetchImpl
    this.log = opts.logger ?? createLogger('oauth-refresh')
  }

  start(): void {
    if (this.timer) return
    this.timer = this.setTimer(() => {
      void this.tick()
    }, this.intervalMs)
  }

  stop(): void {
    if (!this.timer) return
    this.clearTimer(this.timer)
    this.timer = null
  }

  /**
   * Run one scan cycle. Public so tests (and a future
   * `2200 oauth refresh-now` admin command) can trigger one tick.
   */
  async tick(): Promise<TokenRefreshTickStats> {
    if (this.running) {
      return { scanned: 0, refreshed: 0, failed: 0, skipped: 0 }
    }
    this.running = true
    const stats: TokenRefreshTickStats = { scanned: 0, refreshed: 0, failed: 0, skipped: 0 }
    try {
      const agents = await this.listAgents()
      for (const agent of agents) {
        const vault = new CredentialVault(this.home, agent)
        let entries
        try {
          entries = await vault.list()
        } catch (err) {
          this.log.warn('vault list failed', {
            agent,
            error: err instanceof Error ? err.message : String(err),
          })
          continue
        }
        const refreshNames = new Set(
          entries.filter((e) => e.name.endsWith('-refresh')).map((e) => e.name),
        )
        for (const entry of entries) {
          if (entry.name.endsWith('-refresh')) continue
          if (!entry.metadata.provider) continue
          if (!entry.metadata.expires_at) continue
          stats.scanned++
          const refreshName = `${entry.name}-refresh`
          if (!refreshNames.has(refreshName)) {
            stats.skipped++
            continue
          }
          const cdKey = `${agent}:${entry.name}`
          const cd = this.cooldowns.get(cdKey)
          if (cd !== undefined && cd > this.nowFn().getTime()) {
            stats.skipped++
            continue
          }
          const expiresMs = Date.parse(entry.metadata.expires_at)
          if (Number.isNaN(expiresMs)) {
            stats.skipped++
            continue
          }
          if (expiresMs - this.nowFn().getTime() > this.refreshWindowMs) {
            stats.skipped++
            continue
          }
          try {
            await this.refreshOne(agent, vault, entry.name, refreshName)
            stats.refreshed++
            this.cooldowns.delete(cdKey)
          } catch (err) {
            stats.failed++
            this.cooldowns.set(cdKey, this.nowFn().getTime() + this.failureCooldownMs)
            this.log.warn('oauth refresh failed', {
              agent,
              name: entry.name,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
      }
      // Fleet-scoped OAuth tokens (currently: xAI subscription). These
      // live at <home>/state/oauth-tokens/ and refresh independently
      // of any per-Agent vault. One refresh, every Agent sees the new
      // bearer because resolveProvider re-reads on each Agent start.
      await this.refreshFleetTokensInto(stats)
      this.log.info('oauth refresh tick', {
        scanned: stats.scanned,
        refreshed: stats.refreshed,
        failed: stats.failed,
        skipped: stats.skipped,
      })
      return stats
    } finally {
      this.running = false
    }
  }

  /**
   * Refresh fleet-scoped OAuth tokens (xAI subscription, etc.) that
   * are within `refreshWindowMs` of expiry. Unlike per-Agent OAuth,
   * these use a public-client refresh grant (no client_secret) and
   * land back in the home-level token store.
   */
  private async refreshFleetTokensInto(stats: TokenRefreshTickStats): Promise<void> {
    const { readOAuthToken, saveOAuthToken } = await import('./token-store.js')
    const { refreshDeviceFlowToken } = await import('./device-flow.js')
    const { fetchXaiDiscovery, xaiDeviceFlowProvider, XAI_OAUTH_REFRESH_SKEW_SECONDS } =
      await import('./xai-config.js')

    // For now only xAI is fleet-scoped; extend the if-chain when a
    // second fleet OAuth provider lands.
    const xai = await readOAuthToken(this.home, 'xai-oauth').catch(() => null)
    if (!xai) return
    stats.scanned++

    const cdKey = 'fleet:xai-oauth'
    const cd = this.cooldowns.get(cdKey)
    if (cd !== undefined && cd > this.nowFn().getTime()) {
      stats.skipped++
      return
    }

    const expiresMs = xai.metadata.expires_at_ms
    const skewMs = XAI_OAUTH_REFRESH_SKEW_SECONDS * 1000
    const remaining = expiresMs - this.nowFn().getTime()
    if (remaining > Math.max(this.refreshWindowMs, skewMs)) {
      stats.skipped++
      return
    }

    try {
      const fetchImpl = this.fetchImpl ?? fetch
      const discovery = await fetchXaiDiscovery({ fetchImpl })
      const provider = xaiDeviceFlowProvider(discovery)
      const refreshArgs: Parameters<typeof refreshDeviceFlowToken>[0] = {
        provider: { tokenUrl: provider.tokenUrl, clientId: provider.clientId },
        refreshToken: xai.refreshToken,
      }
      if (this.fetchImpl) refreshArgs.fetchImpl = this.fetchImpl
      const tokens = await refreshDeviceFlowToken(refreshArgs)
      const now = this.nowFn().getTime()
      await saveOAuthToken(this.home, {
        provider: 'xai-oauth',
        bearer: tokens.access_token,
        refreshToken: tokens.refresh_token ?? xai.refreshToken,
        metadata: {
          ...xai.metadata,
          granted_scopes: tokens.scope ? tokens.scope.split(/\s+/) : xai.metadata.granted_scopes,
          expires_at_ms:
            tokens.expires_in !== undefined ? now + tokens.expires_in * 1000 : now + 3600_000,
          refreshed_at: new Date(now).toISOString(),
        },
      })
      stats.refreshed++
      this.cooldowns.delete(cdKey)
      this.log.info('refreshed fleet xai-oauth token', {
        new_expires_at: new Date(
          tokens.expires_in !== undefined ? now + tokens.expires_in * 1000 : now + 3600_000,
        ).toISOString(),
      })
    } catch (err) {
      stats.failed++
      this.cooldowns.set(cdKey, this.nowFn().getTime() + this.failureCooldownMs)
      this.log.warn('fleet xai-oauth refresh failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private async refreshOne(
    agent: string,
    vault: CredentialVault,
    accessName: string,
    refreshName: string,
  ): Promise<OAuthTokenResponse> {
    const refreshEntry = await vault.get(refreshName)
    const providerName = refreshEntry.metadata.provider
    if (!providerName) {
      throw new OAuthError(`${agent}:${refreshName} has no provider tag`, 'INVALID_RESPONSE')
    }
    const provider = findProvider(providerName)
    if (!provider) {
      throw new OAuthError(`provider "${providerName}" not in registry`, 'INVALID_RESPONSE')
    }
    const creds = readClientCredentials(providerName)
    if (!creds.clientId || !creds.clientSecret) {
      throw new OAuthError(
        `client credentials missing for ${providerName} (set ${creds.envVarHints.id} / ${creds.envVarHints.secret})`,
        'PROVIDER_MISSING_CLIENT_ID',
      )
    }
    const refreshArgs: Parameters<typeof refreshAccessToken>[0] = {
      provider,
      refreshToken: refreshEntry.value,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
    }
    if (this.fetchImpl) refreshArgs.fetchImpl = this.fetchImpl
    const tokens = await refreshAccessToken(refreshArgs)

    const accessExisting = await vault.get(accessName).catch(() => null)
    const expiresAt =
      tokens.expires_in !== undefined
        ? new Date(this.nowFn().getTime() + tokens.expires_in * 1000).toISOString()
        : undefined
    await vault.set(accessName, {
      value: tokens.access_token,
      metadata: {
        created_at: this.nowFn().toISOString(),
        provider: providerName,
        scopes: accessExisting?.metadata.scopes ?? refreshEntry.metadata.scopes ?? [],
        ...(expiresAt ? { expires_at: expiresAt } : {}),
        notes: 'oauth access_token (auto-refreshed)',
      },
    })
    if (tokens.refresh_token && tokens.refresh_token !== refreshEntry.value) {
      await vault.set(refreshName, {
        value: tokens.refresh_token,
        metadata: {
          ...refreshEntry.metadata,
          created_at: this.nowFn().toISOString(),
          notes: `oauth refresh_token (auto-rotated; companion to "${accessName}")`,
        },
      })
    }
    return tokens
  }

  private async listAgents(): Promise<string[]> {
    const root = homePaths(this.home).agents
    try {
      const entries = await readdir(root, { withFileTypes: true })
      const out: string[] = []
      for (const e of entries) {
        if (e.isDirectory()) out.push(e.name)
      }
      return out
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      this.log.warn('agents dir scan failed', {
        path: root,
        error: err instanceof Error ? err.message : String(err),
      })
      return []
    }
  }
}
