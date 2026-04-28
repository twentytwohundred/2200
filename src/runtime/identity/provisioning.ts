/**
 * SCUT identity provisioning pipeline (Epic 4 Phase A PR E).
 *
 * Five-state checkpointed orchestrator that takes a freshly created
 * Agent and produces a registered SCUT identity, persisting each
 * transition atomically so a crash mid-run is recoverable.
 *
 * State machine:
 *
 *   pending → keys_generated → token_minted → registered
 *
 * Plus an `errored` sink that any state can transition to.
 *
 * The spec v0.3 sketches an eight-state machine (`mint_submitted`,
 * `doc_encoded`, `update_submitted` between the persistent points
 * above). v1 of the implementation collapses those into the
 * adjacent persistent states because:
 *   - encode is pure compute; no I/O to checkpoint between.
 *   - submit-and-confirm runs as a single ethers `wait()` call;
 *     splitting it would require restructuring the on-chain client
 *     and adds little safety. A crash between submit and confirm
 *     re-runs from `keys_generated` and either succeeds or surfaces
 *     a manual-recovery notification (v1 doesn't auto-detect an
 *     orphaned mint).
 *
 * The pipeline is dependency-injected: keystore generators,
 * on-chain client, and Identity-file writer are passed in so tests
 * can swap fakes without touching the network or the disk.
 *
 * Notifications fire on:
 *   - registered: passive ("X provisioned")
 *   - errored:    important ("X provisioning failed at <state>")
 */
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { stringify } from 'yaml'
import { atomicWriteFile, atomicWriteJson } from '../util/atomic-write.js'
import { agentIdentityPaths, homePaths } from '../storage/layout.js'
import { newNotificationId } from '../util/id.js'
import { createLogger, type Logger } from '../util/logger.js'
import {
  buildSiiDocument,
  composeScutUri,
  encodeAsDataUri,
  SII_PLACEHOLDER_DATA_URI,
} from './sii-document.js'

export const PROVISION_STATE_SCHEMA_VERSION = 1

const FRONTMATTER_DELIM = '---'

export type ProvisionStateName =
  | 'pending'
  | 'keys_generated'
  | 'token_minted'
  | 'registered'
  | 'errored'

export interface ProvisionState {
  schema_version: 1
  agent_name: string
  state: ProvisionStateName
  /** When the state was last updated. */
  updated_at: string
  /** Set on transition to `keys_generated`. */
  public_keys_b64?: { ed25519: string; x25519: string }
  /** Set on transition to `token_minted` (TX1 confirmed). Decimal string. */
  token_id?: string
  /** Set on transition to `token_minted`. */
  mint_tx_hash?: string
  /** Set on transition to `registered` (TX2 confirmed). */
  update_tx_hash?: string
  /** Set on transition to `errored`. */
  error?: { class: string; message: string; at_state: ProvisionStateName }
}

export interface OnChainClient {
  walletAddress: string
  mintWithPlaceholder(uri: string): Promise<{ tokenId: bigint; txHash: string }>
  waitForOwnerOfReadable(tokenId: bigint): Promise<void>
  updateIdentityUri(tokenId: bigint, uri: string): Promise<{ txHash: string }>
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
  chainId: number
  contractAddress: string
  masterKey: Buffer
  onChain: OnChainClient
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
        await this.fireNotification('error', errored)
        this.log.error('provision failed', {
          at_state: state.state,
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    }

    if (state.state === 'registered') {
      await this.fireNotification('success', state)
    }
    return state
  }

  private async step(state: ProvisionState): Promise<ProvisionState> {
    switch (state.state) {
      case 'pending':
        return this.advanceToKeysGenerated(state)
      case 'keys_generated':
        return this.advanceToTokenMinted(state)
      case 'token_minted':
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

  /** TX1: mint with placeholder URI; wait for ownerOf consistency; persist tokenId + tx hash. */
  private async advanceToTokenMinted(state: ProvisionState): Promise<ProvisionState> {
    const result = await this.opts.onChain.mintWithPlaceholder(SII_PLACEHOLDER_DATA_URI)
    await this.opts.onChain.waitForOwnerOfReadable(result.tokenId)
    const next: ProvisionState = {
      ...state,
      state: 'token_minted',
      updated_at: this.nowFn().toISOString(),
      token_id: result.tokenId.toString(),
      mint_tx_hash: result.txHash,
    }
    await this.persist(next)
    return next
  }

  /** Encode SII document with real tokenId; TX2 (updateIdentityURI); write scut block to Identity. */
  private async advanceToRegistered(state: ProvisionState): Promise<ProvisionState> {
    if (!state.token_id || !state.mint_tx_hash || !state.public_keys_b64) {
      throw new Error(
        `cannot complete provisioning from state token_minted: missing required fields (token_id=${
          state.token_id ?? 'null'
        }, mint_tx_hash=${state.mint_tx_hash ?? 'null'}, public_keys_b64=${
          state.public_keys_b64 ? 'present' : 'null'
        })`,
      )
    }

    const tokenIdBigInt = BigInt(state.token_id)
    const doc = buildSiiDocument({
      chainId: this.opts.chainId,
      contract: this.opts.contractAddress,
      tokenId: tokenIdBigInt,
      ed25519PublicKeyB64: state.public_keys_b64.ed25519,
      x25519PublicKeyB64: state.public_keys_b64.x25519,
    })
    const dataUri = encodeAsDataUri(doc)

    const updateResult = await this.opts.onChain.updateIdentityUri(tokenIdBigInt, dataUri)

    const registeredAt = this.nowFn().toISOString()
    const next: ProvisionState = {
      ...state,
      state: 'registered',
      updated_at: registeredAt,
      update_tx_hash: updateResult.txHash,
    }
    await this.persist(next)

    await this.opts.writeIdentity({
      home: this.opts.home,
      agentName: this.opts.agentName,
      scut: {
        uri: composeScutUri(this.opts.chainId, this.opts.contractAddress, tokenIdBigInt),
        chain_id: this.opts.chainId,
        contract: this.opts.contractAddress,
        token_id: state.token_id,
        identity_doc_uri: dataUri,
        public_keys: state.public_keys_b64,
        registered_at: registeredAt,
        mint_tx: state.mint_tx_hash,
        update_tx: updateResult.txHash,
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

  private async fireNotification(kind: 'success' | 'error', state: ProvisionState): Promise<void> {
    const ts = this.nowFn().toISOString()
    const id = newNotificationId()
    const tier = kind === 'success' ? 'passive' : 'important'
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
    const body = kind === 'success' ? this.buildSuccessBody(state) : this.buildErrorBody(state)
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

  private buildErrorBody(state: ProvisionState): string {
    return [
      `Agent **${this.opts.agentName}** SCUT provisioning failed.`,
      ``,
      `At state: ${state.error?.at_state ?? state.state}`,
      `Error: ${state.error?.message ?? '(unknown)'}`,
      ``,
      `Inspect with: \`2200 agent identity status ${this.opts.agentName}\``,
      `Retry with: \`2200 agent identity retry ${this.opts.agentName}\``,
      ``,
    ].join('\n')
  }
}
