/**
 * SCUT identity provisioning pipeline (Epic 4 Phase A v0.4).
 *
 * Three-state checkpointed orchestrator that takes a freshly created
 * Agent and produces a registered SCUT identity by POSTing the
 * Agent's public keys to OpenSCUT's hosted register service. The
 * on-chain mint+update happens server-side at OpenSCUT; 2200 sees
 * one HTTPS round-trip per provisioning.
 *
 * State machine:
 *
 *   pending → keys_generated → registered
 *
 * Plus an `errored` sink that any state can transition to.
 *
 * Each state checkpoints atomically before the next runs, so a
 * crash mid-provision is recoverable. Resume from `keys_generated`
 * re-POSTs the same public keys; OpenSCUT's response is
 * deterministic given the inputs (modulo the per-displayName daily
 * rate limit, which is reported as an explicit operator-visible
 * failure rather than retried).
 *
 * Notifications fire on:
 *   - registered: passive ("X provisioned")
 *   - errored:    important ("X provisioning failed at <state>")
 *                 with rate-limit failures specifically called out
 *                 because the remediation (rename or wait) is
 *                 user-actionable.
 */
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { stringify } from 'yaml'
import { atomicWriteFile, atomicWriteJson } from '../util/atomic-write.js'
import { agentIdentityPaths, homePaths } from '../storage/layout.js'
import { newNotificationId } from '../util/id.js'
import { createLogger, type Logger } from '../util/logger.js'
import {
  RegisterRateLimitError,
  RegisterOnChainError,
  RegisterServiceUnavailableError,
  type RegisterClient,
  type RegisterRequest,
  type RegisterResponse,
} from './register-client.js'

export const PROVISION_STATE_SCHEMA_VERSION = 1

const FRONTMATTER_DELIM = '---'

export type ProvisionStateName = 'pending' | 'keys_generated' | 'registered' | 'errored'

export interface ProvisionState {
  schema_version: 1
  agent_name: string
  state: ProvisionStateName
  /** When the state was last updated. */
  updated_at: string
  /** Set on transition to `keys_generated`. Base64-encoded 32-byte public keys. */
  public_keys_b64?: { ed25519: string; x25519: string }
  /** Set on transition to `registered`. Decimal string. */
  token_id?: string
  /** Set on transition to `registered`. Canonical scut:// URI from OpenSCUT. */
  scut_uri?: string
  /** Set on transition to `registered`. Numeric chain id. */
  chain_id?: number
  /** Set on transition to `registered`. SII contract address. */
  contract?: string
  /** Set on transition to `registered`. Mint tx (TX1) hash from OpenSCUT. */
  mint_tx_hash?: string
  /** Set on transition to `registered`. Update tx (TX2) hash from OpenSCUT. */
  update_tx_hash?: string
  /** Set on transition to `errored`. */
  error?: { class: string; message: string; at_state: ProvisionStateName }
}

export interface KeyStoreFns {
  generate(): {
    ed25519: { publicKeyRaw: Buffer; privateKeyRaw: Buffer }
    x25519: { publicKeyRaw: Buffer; privateKeyRaw: Buffer }
  }
  write(args: {
    home: string
    agentName: string
    keypairs: ReturnType<KeyStoreFns['generate']>
    masterKey: Buffer
  }): Promise<{ ed25519: string; x25519: string }>
}

/**
 * Hook the pipeline calls to write the `scut` block into the Agent's
 * Identity file. Decoupled so the pipeline does not have to know
 * the Identity loader's internals.
 */
export type IdentityWriter = (args: {
  home: string
  agentName: string
  scut: {
    uri: string
    chain_id: number
    contract: string
    token_id: string
    identity_doc_uri: string
    public_keys: { ed25519: string; x25519: string }
    registered_at: string
    mint_tx: string
    update_tx: string
  }
}) => Promise<void>

export interface ProvisioningPipelineOptions {
  home: string
  agentName: string
  /** Display name posted to OpenSCUT. Defaults to agentName. */
  displayName?: string
  masterKey: Buffer
  registerClient: RegisterClient
  keyStore: KeyStoreFns
  writeIdentity: IdentityWriter
  /** Injected for tests. */
  now?: () => Date
  logger?: Logger
}

export class ProvisioningPipeline {
  private readonly opts: ProvisioningPipelineOptions
  private readonly nowFn: () => Date
  private readonly log: Logger

  constructor(opts: ProvisioningPipelineOptions) {
    this.opts = opts
    this.nowFn = opts.now ?? (() => new Date())
    this.log = opts.logger ?? createLogger(`identity/provision/${opts.agentName}`)
  }

  /**
   * Run (or resume) the pipeline. Returns the final state on
   * success. Throws after persisting `errored` if any step fails.
   * Re-running a `registered` agent is a no-op.
   */
  async run(): Promise<ProvisionState> {
    let state = await this.loadOrInit()
    this.log.info('starting provision', { state: state.state })

    while (state.state !== 'registered' && state.state !== 'errored') {
      try {
        state = await this.step(state)
      } catch (err) {
        const errored: ProvisionState = {
          ...state,
          state: 'errored',
          updated_at: this.nowFn().toISOString(),
          error: {
            class: err instanceof Error ? err.constructor.name : 'Error',
            message: err instanceof Error ? err.message : String(err),
            at_state: state.state,
          },
        }
        await this.persist(errored)
        await this.fireNotification('error', errored, err)
        this.log.error('provision failed', {
          at_state: state.state,
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    }

    if (state.state === 'registered') {
      await this.fireNotification('success', state, null)
    }
    return state
  }

  private async step(state: ProvisionState): Promise<ProvisionState> {
    switch (state.state) {
      case 'pending':
        return this.advanceToKeysGenerated(state)
      case 'keys_generated':
        return this.advanceToRegistered(state)
      case 'registered':
      case 'errored':
        return state
    }
  }

  /** Generate Ed25519 + X25519 keypairs, write encrypted-at-rest, persist public keys to state. */
  private async advanceToKeysGenerated(state: ProvisionState): Promise<ProvisionState> {
    const keypairs = this.opts.keyStore.generate()
    const publicKeys = await this.opts.keyStore.write({
      home: this.opts.home,
      agentName: this.opts.agentName,
      keypairs,
      masterKey: this.opts.masterKey,
    })
    const next: ProvisionState = {
      ...state,
      state: 'keys_generated',
      updated_at: this.nowFn().toISOString(),
      public_keys_b64: publicKeys,
    }
    await this.persist(next)
    return next
  }

  /**
   * POST to OpenSCUT's `/scut/v1/register` with our public keys, get
   * back the minted token + mint/update tx hashes + the SII document
   * the service composed. Write the resulting `scut` block into the
   * Agent's Identity file.
   */
  private async advanceToRegistered(state: ProvisionState): Promise<ProvisionState> {
    if (!state.public_keys_b64) {
      throw new Error(
        'cannot complete provisioning from state keys_generated: public_keys_b64 missing',
      )
    }
    const req: RegisterRequest = {
      keys: {
        signing: { algorithm: 'ed25519', publicKey: state.public_keys_b64.ed25519 },
        encryption: { algorithm: 'x25519', publicKey: state.public_keys_b64.x25519 },
      },
      displayName: this.opts.displayName ?? this.opts.agentName,
    }
    const response: RegisterResponse = await this.opts.registerClient.register(req)

    const registeredAt = this.nowFn().toISOString()
    const next: ProvisionState = {
      ...state,
      state: 'registered',
      updated_at: registeredAt,
      token_id: response.agentRef.tokenId,
      scut_uri: response.ref,
      chain_id: response.agentRef.chainId,
      contract: response.agentRef.contract,
      mint_tx_hash: response.txHashes.mint,
      update_tx_hash: response.txHashes.update,
    }
    await this.persist(next)

    const docDataUri = encodeDocumentAsDataUri(response.document)
    await this.opts.writeIdentity({
      home: this.opts.home,
      agentName: this.opts.agentName,
      scut: {
        uri: response.ref,
        chain_id: response.agentRef.chainId,
        contract: response.agentRef.contract,
        token_id: response.agentRef.tokenId,
        identity_doc_uri: docDataUri,
        public_keys: state.public_keys_b64,
        registered_at: registeredAt,
        mint_tx: response.txHashes.mint,
        update_tx: response.txHashes.update,
      },
    })

    return next
  }

  // --- persistence -----------------------------------------------------------

  private async loadOrInit(): Promise<ProvisionState> {
    const existing = await this.tryLoadState()
    if (existing) return existing
    const fresh: ProvisionState = {
      schema_version: PROVISION_STATE_SCHEMA_VERSION,
      agent_name: this.opts.agentName,
      state: 'pending',
      updated_at: this.nowFn().toISOString(),
    }
    await this.persist(fresh)
    return fresh
  }

  private async tryLoadState(): Promise<ProvisionState | null> {
    const path = agentIdentityPaths(this.opts.home, this.opts.agentName).provisionState
    try {
      const raw = await readFile(path, 'utf8')
      return JSON.parse(raw) as ProvisionState
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  private async persist(state: ProvisionState): Promise<void> {
    const paths = agentIdentityPaths(this.opts.home, this.opts.agentName)
    await mkdir(paths.root, { recursive: true })
    await atomicWriteJson(paths.provisionState, state)
  }

  private async fireNotification(
    kind: 'success' | 'error',
    state: ProvisionState,
    err: unknown,
  ): Promise<void> {
    const ts = this.nowFn().toISOString()
    const id = newNotificationId()
    const tier = kind === 'success' ? 'passive' : tierForError(err)
    const notifKind = kind === 'success' ? 'identity_provisioned' : 'identity_provision_failed'
    const fm: Record<string, unknown> = {
      schema_version: 1,
      id,
      ts,
      tier,
      agent: this.opts.agentName,
      kind: notifKind,
      state: 'pending',
    }
    if (state.token_id) fm['token_id'] = state.token_id
    if (state.error) {
      fm['error_class'] = state.error.class
      fm['error_message'] = state.error.message
      fm['at_state'] = state.error.at_state
    }
    const body = kind === 'success' ? this.buildSuccessBody(state) : this.buildErrorBody(state, err)
    const content = `${FRONTMATTER_DELIM}\n${stringify(fm, { lineWidth: 0 }).trimEnd()}\n${FRONTMATTER_DELIM}\n${body}`
    const path = join(homePaths(this.opts.home).stateNotifications, `${id}.md`)
    await mkdir(dirname(path), { recursive: true })
    await atomicWriteFile(path, content)
  }

  private buildSuccessBody(state: ProvisionState): string {
    return [
      `Agent **${this.opts.agentName}** provisioned a SCUT identity.`,
      ``,
      `Token: ${state.token_id ?? '(unknown)'}`,
      `Mint tx: ${state.mint_tx_hash ?? '(unknown)'}`,
      `Update tx: ${state.update_tx_hash ?? '(unknown)'}`,
      ``,
    ].join('\n')
  }

  private buildErrorBody(state: ProvisionState, err: unknown): string {
    const lines: string[] = [
      `Agent **${this.opts.agentName}** SCUT provisioning failed.`,
      ``,
      `At state: ${state.error?.at_state ?? state.state}`,
      `Error: ${state.error?.message ?? '(unknown)'}`,
      ``,
    ]
    // Specific operator hints for the most actionable failure modes.
    if (err instanceof RegisterRateLimitError) {
      lines.push(
        `OpenSCUT rate-limited this registration. The likely cause is re-creating an Agent with the same display name within 24 UTC hours. Either rename the Agent or wait until the next UTC midnight before retrying.`,
        ``,
      )
    } else if (err instanceof RegisterServiceUnavailableError) {
      lines.push(
        `OpenSCUT's register service is currently unavailable (global daily cap reached, or the upstream RPC is down). Retry later, or check \`2200 agent identity wallet-status\` for service health.`,
        ``,
      )
    } else if (err instanceof RegisterOnChainError) {
      lines.push(
        `OpenSCUT's on-chain mint or update failed. This is rare and usually indicates an upstream Base RPC problem. Retry the provisioning, and if it persists check the OpenSCUT service status.`,
        ``,
      )
    }
    lines.push(
      `Inspect with: \`2200 agent identity status ${this.opts.agentName}\``,
      `Retry with: \`2200 agent identity retry ${this.opts.agentName}\``,
      ``,
    )
    return lines.join('\n')
  }
}

/**
 * Encode the SII document returned by OpenSCUT as a `data:` URI.
 * Stored in the Identity file's `scut.identity_doc_uri` slot for
 * resolver-free local verification: anyone who reads the Identity
 * file sees the document inline.
 *
 * The on-chain URI at `agentRef.contract` already holds the same
 * value (OpenSCUT's update step put it there); this is a local
 * convenience copy.
 */
function encodeDocumentAsDataUri(doc: unknown): string {
  return `data:application/json;base64,${Buffer.from(JSON.stringify(doc)).toString('base64')}`
}

/**
 * Map a register-client error class to a notification tier. Rate-
 * limit and service-unavailable failures are user-actionable
 * (rename, wait, top up the wallet) so they get `important`.
 * On-chain failures and unknown errors get `important` too. Auth /
 * validation errors should never happen in the production flow
 * (they indicate a 2200-side bug); flag them as `important` so
 * Doug sees them.
 */
function tierForError(err: unknown): 'passive' | 'important' | 'critical' {
  if (err instanceof RegisterServiceUnavailableError) return 'important'
  if (err instanceof RegisterOnChainError) return 'important'
  if (err instanceof RegisterRateLimitError) return 'important'
  return 'important'
}
