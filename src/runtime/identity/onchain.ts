/**
 * On-chain client for the SCUT Identity Interface (SII) contract on
 * Base mainnet (Epic 4 Phase A PR D).
 *
 * Wraps ethers.js around the two transactions of the data-URI mint
 * pipeline locked in the Phase A v0.3 spec:
 *
 *   TX1: mint(seedTeamWallet, "data:application/json;base64,e30=")
 *   --- parse tokenId from the SCUTIdentityRegistered event ---
 *   --- poll ownerOf(tokenId) until a backend has the new state ---
 *   TX2: updateIdentityURI(tokenId, finalDataUri)
 *
 * The `ownerOf` poll handles the RPC-consistency window Garfield
 * flagged on the public mainnet.base.org endpoint (load-balanced;
 * reads after a write can hit stale backends for ~1-2 blocks).
 * Operators with a dedicated RPC (Alchemy / QuickNode / own Base
 * node) can configure `pollMaxAttempts: 1` to skip the poll.
 *
 * The client never logs private key material. The Wallet is
 * constructed once and held by the instance; callers pass keys
 * once into the factory and use only the typed API after.
 */
import { Contract, JsonRpcProvider, Wallet, Interface, type Provider } from 'ethers'

/**
 * Minimal SII v1 ABI fragment: only the methods + events the
 * provisioning pipeline uses. Keeping this in-source rather than
 * loading a JSON ABI lets the typecheck catch shape drift if
 * Garfield ever ships a v2 contract with renamed signatures.
 */
const SII_ABI = [
  'function mint(address to, string calldata identityURI) external returns (uint256 tokenId)',
  'function updateIdentityURI(uint256 tokenId, string calldata newURI) external',
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'event SCUTIdentityRegistered(uint256 indexed tokenId, address indexed owner, string uri)',
] as const

const SII_INTERFACE = new Interface(SII_ABI)

const DEFAULT_OWNEROF_POLL_INTERVAL_MS = 200
const DEFAULT_OWNEROF_POLL_MAX_ATTEMPTS = 30 // ~6 seconds at 200ms; well past the typical ~1-2 block window
const DEFAULT_TX_CONFIRMATIONS = 1

export interface OnChainOptions {
  rpcUrl: string
  /** Hex-encoded private key for the seed-team wallet. Never logged. */
  privateKey: string
  /** SII contract address on Base mainnet. */
  contractAddress: string
  /** Override poll interval between ownerOf calls in the consistency loop. */
  ownerOfPollIntervalMs?: number
  /** Cap on ownerOf attempts before giving up. */
  ownerOfPollMaxAttempts?: number
  /** Confirmations to wait on each tx. Defaults to 1 (Base finality). */
  confirmations?: number
}

export interface MintResult {
  tokenId: bigint
  txHash: string
}

export interface UpdateUriResult {
  txHash: string
}

export class ScutOnChainClient {
  private readonly provider: Provider
  private readonly wallet: Wallet
  private readonly contract: Contract
  private readonly contractAddress: string
  private readonly pollIntervalMs: number
  private readonly pollMaxAttempts: number
  private readonly confirmations: number

  /**
   * Internal constructor. Tests inject a Provider + Wallet directly
   * to avoid network I/O. Production callers use {@link createScutOnChain}.
   */
  constructor(args: {
    provider: Provider
    wallet: Wallet
    contractAddress: string
    pollIntervalMs?: number
    pollMaxAttempts?: number
    confirmations?: number
  }) {
    this.provider = args.provider
    this.wallet = args.wallet
    this.contractAddress = args.contractAddress
    this.contract = new Contract(args.contractAddress, SII_ABI, args.wallet)
    this.pollIntervalMs = args.pollIntervalMs ?? DEFAULT_OWNEROF_POLL_INTERVAL_MS
    this.pollMaxAttempts = args.pollMaxAttempts ?? DEFAULT_OWNEROF_POLL_MAX_ATTEMPTS
    this.confirmations = args.confirmations ?? DEFAULT_TX_CONFIRMATIONS
  }

  /** The wallet's public address. Used for funding-alert math. */
  get walletAddress(): string {
    return this.wallet.address
  }

  /**
   * TX1: mint a new SCUT identity for the seed-team wallet with the
   * given placeholder URI. Returns the minted tokenId (parsed from
   * the SCUTIdentityRegistered event log) and the tx hash. Throws
   * on tx revert or on a confirmed receipt that omits the expected
   * event.
   */
  async mintWithPlaceholder(placeholderUri: string): Promise<MintResult> {
    const tx = await this.callMint(placeholderUri)
    const receipt = await tx.wait(this.confirmations)
    if (!receipt) {
      throw new Error(`mint tx ${tx.hash} returned a null receipt`)
    }
    const tokenId = this.parseTokenIdFromReceipt(receipt)
    return { tokenId, txHash: tx.hash }
  }

  /**
   * Wait for the read side of the RPC to see the just-minted token.
   * Polls `ownerOf(tokenId)` until a successful response. Returns
   * once a backend with the new state answers. Throws if the poll
   * exhausts its budget.
   */
  async waitForOwnerOfReadable(tokenId: bigint): Promise<void> {
    let lastErr: unknown = null
    for (let attempt = 0; attempt < this.pollMaxAttempts; attempt += 1) {
      try {
        await this.contract['ownerOf']?.(tokenId)
        return
      } catch (err) {
        lastErr = err
        await sleep(this.pollIntervalMs)
      }
    }
    throw new Error(
      `ownerOf(${tokenId.toString()}) not readable after ${String(this.pollMaxAttempts)} attempts: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
    )
  }

  /**
   * TX2: rewrite the tokenId's on-chain URI to the final encoded
   * SII document. Only the token owner can call (the seed-team
   * wallet, in v1's custodial model). Returns the tx hash.
   */
  async updateIdentityUri(tokenId: bigint, uri: string): Promise<UpdateUriResult> {
    const fn = this.contract['updateIdentityURI']
    if (typeof fn !== 'function') {
      throw new Error('contract is missing updateIdentityURI in its ABI')
    }
    const tx = (await fn.call(this.contract, tokenId, uri)) as Awaited<
      ReturnType<typeof callMintFn>
    >
    const receipt = await tx.wait(this.confirmations)
    if (!receipt) {
      throw new Error(`updateIdentityURI tx ${tx.hash} returned a null receipt`)
    }
    return { txHash: tx.hash }
  }

  /**
   * Wallet balance in wei. Caller divides by current gas-cost-per-spawn
   * estimate to compute "registrations remaining" for funding alerts.
   */
  async getWalletBalance(): Promise<bigint> {
    const balance = await this.provider.getBalance(this.wallet.address)
    return balance
  }

  /**
   * EIP-165 supportsInterface check. The Phase A spec asserts the
   * SII v1 interface id `0x6fe513d9` on first connect to catch a
   * misconfigured contract address before any state is touched.
   *
   * Returns true when the contract advertises the SII v1 interface.
   * Throws on RPC error.
   */
  async supportsScutIdentityV1(): Promise<boolean> {
    // Use a low-level eth_call rather than typing supportsInterface
    // into the ABI, since the contract may or may not implement
    // EIP-165's selector and we want a soft "no" rather than a
    // hard revert in that case.
    const supportsInterfaceSelector = '0x01ffc9a7'
    const siiV1InterfaceId = '6fe513d9'
    const callData = `${supportsInterfaceSelector}${siiV1InterfaceId.padEnd(64, '0')}`
    try {
      const result = await this.provider.call({ to: this.contractAddress, data: callData })
      return /^0x0+1$/.test(result.replace(/^0x0*/, '0x0'))
        ? true
        : Number.parseInt(result, 16) === 1
    } catch {
      return false
    }
  }

  private async callMint(uri: string): Promise<Awaited<ReturnType<typeof callMintFn>>> {
    return callMintFn(this.contract, this.wallet.address, uri)
  }

  private parseTokenIdFromReceipt(receipt: {
    logs: readonly { topics: readonly string[]; data: string }[]
  }): bigint {
    for (const log of receipt.logs) {
      try {
        const parsed = SII_INTERFACE.parseLog({ topics: [...log.topics], data: log.data })
        if (parsed?.name === 'SCUTIdentityRegistered') {
          const tokenIdArg = parsed.args[0] as bigint
          return tokenIdArg
        }
      } catch {
        // Not our event; ignore.
      }
    }
    throw new Error('mint receipt did not include a SCUTIdentityRegistered event')
  }
}

/**
 * Production factory: constructs a JsonRpcProvider against the
 * configured Base RPC URL and a Wallet from the configured private
 * key, then wires up the ScutOnChainClient. Tests bypass this and
 * use the constructor directly with mock provider/signer.
 */
export function createScutOnChain(opts: OnChainOptions): ScutOnChainClient {
  const provider = new JsonRpcProvider(opts.rpcUrl)
  const wallet = new Wallet(opts.privateKey, provider)
  const constructorArgs: ConstructorParameters<typeof ScutOnChainClient>[0] = {
    provider,
    wallet,
    contractAddress: opts.contractAddress,
  }
  if (opts.ownerOfPollIntervalMs !== undefined) {
    constructorArgs.pollIntervalMs = opts.ownerOfPollIntervalMs
  }
  if (opts.ownerOfPollMaxAttempts !== undefined) {
    constructorArgs.pollMaxAttempts = opts.ownerOfPollMaxAttempts
  }
  if (opts.confirmations !== undefined) {
    constructorArgs.confirmations = opts.confirmations
  }
  return new ScutOnChainClient(constructorArgs)
}

// --- internals -----------------------------------------------------------

async function callMintFn(
  contract: Contract,
  owner: string,
  uri: string,
): Promise<{
  hash: string
  wait: (confirmations?: number) => Promise<{ logs: { topics: string[]; data: string }[] } | null>
}> {
  const fn = contract['mint']
  if (typeof fn !== 'function') {
    throw new Error('contract is missing mint in its ABI')
  }
  const tx = (await fn.call(contract, owner, uri)) as {
    hash: string
    wait: (confirmations?: number) => Promise<{ logs: { topics: string[]; data: string }[] } | null>
  }
  return tx
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
