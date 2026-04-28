/**
 * Tests for the on-chain SCUT Identity client (Epic 4 Phase A PR D).
 *
 * Uses ethers.js's MockProvider-style construction via direct
 * contract method stubbing... we avoid spinning up a fake JSON-RPC
 * server by injecting a Provider + Wallet that the client wraps.
 *
 * These tests cover the API surface the provisioning pipeline (PR E)
 * relies on:
 *  - mintWithPlaceholder parses tokenId from the SCUTIdentityRegistered event
 *  - mintWithPlaceholder throws on a receipt missing the expected event
 *  - waitForOwnerOfReadable retries on transient ownerOf failures
 *    (the RPC consistency window) and resolves once a backend answers
 *  - waitForOwnerOfReadable gives up after pollMaxAttempts with a
 *    descriptive error
 *  - getWalletBalance returns the provider's balance for the wallet
 *
 * The full-flow integration (mint → poll → updateUri → write Identity)
 * is covered by the provisioning pipeline tests in PR E.
 */
import { describe, expect, it, vi } from 'vitest'
import { Interface, Wallet, ZeroAddress, type Provider } from 'ethers'
import { ScutOnChainClient } from '../../../src/runtime/identity/onchain.js'

const SII_ABI_FRAGMENT = [
  'event SCUTIdentityRegistered(uint256 indexed tokenId, address indexed owner, string uri)',
]
const iface = new Interface(SII_ABI_FRAGMENT)

const TEST_PRIVATE_KEY = '0x0123456789012345678901234567890123456789012345678901234567890123'
const TEST_CONTRACT = '0x199b48E27a28881502b251B0068F388Ce750feff'

interface MockReceipt {
  logs: { topics: string[]; data: string }[]
}

function makeRegisteredLog(
  tokenId: bigint,
  owner: string,
  uri: string,
): { topics: string[]; data: string } {
  // Build a SCUTIdentityRegistered log via the Interface; ethers will
  // emit the same shape from a real receipt.
  const fragment = iface.getEvent('SCUTIdentityRegistered')!
  const encoded = iface.encodeEventLog(fragment, [tokenId, owner, uri])
  return { topics: [...encoded.topics], data: encoded.data }
}

interface MintTxStub {
  hash: string
  wait: (c?: number) => Promise<MockReceipt | null>
}

interface UpdateTxStub {
  hash: string
  wait: (c?: number) => Promise<MockReceipt | null>
}

class MockProvider {
  balance = 0n
  // ethers.Provider has many methods; we only need getBalance + call here.
  getBalance = vi.fn((_address: string) => Promise.resolve(this.balance))
  call = vi.fn((_args: unknown) =>
    Promise.resolve('0x0000000000000000000000000000000000000000000000000000000000000001'),
  )
}

function makeWallet(provider: Provider): Wallet {
  return new Wallet(TEST_PRIVATE_KEY, provider)
}

function makeClient(opts: {
  provider: Provider
  wallet: Wallet
  mintTx?: MintTxStub | null
  mintErr?: Error
  updateTx?: UpdateTxStub | null
  updateErr?: Error
  ownerOfBehavior?: { failuresBeforeSuccess: number }
}): ScutOnChainClient {
  const client = new ScutOnChainClient({
    provider: opts.provider,
    wallet: opts.wallet,
    contractAddress: TEST_CONTRACT,
    pollIntervalMs: 1, // fast tests
    pollMaxAttempts: 5,
    confirmations: 1,
  })
  // Replace the internal Contract methods with stubs.
  // ethers.Contract is opaque enough that direct stubbing via cast
  // is cleaner than constructing a fake Contract.
  interface ContractStub {
    mint: (...args: unknown[]) => Promise<MintTxStub>
    updateIdentityURI: (...args: unknown[]) => Promise<UpdateTxStub>
    ownerOf: (id: bigint) => Promise<string>
  }
  const internal = client as unknown as { contract: ContractStub }
  let ownerOfCalls = 0
  internal.contract = {
    mint: () => {
      if (opts.mintErr) throw opts.mintErr
      if (!opts.mintTx) throw new Error('no mintTx provided')
      return Promise.resolve(opts.mintTx)
    },
    updateIdentityURI: () => {
      if (opts.updateErr) throw opts.updateErr
      if (!opts.updateTx) throw new Error('no updateTx provided')
      return Promise.resolve(opts.updateTx)
    },
    ownerOf: (_id: bigint) => {
      ownerOfCalls += 1
      const failuresBefore = opts.ownerOfBehavior?.failuresBeforeSuccess ?? 0
      if (ownerOfCalls <= failuresBefore) {
        return Promise.reject(new Error('ERC721NonexistentToken'))
      }
      return Promise.resolve(ZeroAddress)
    },
  }
  return client
}

describe('mintWithPlaceholder', () => {
  it('returns the tokenId parsed from the SCUTIdentityRegistered event log', async () => {
    const provider = new MockProvider() as unknown as Provider
    const wallet = makeWallet(provider)
    const tokenId = 12345n
    const tx: MintTxStub = {
      hash: '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      wait: () =>
        Promise.resolve({
          logs: [makeRegisteredLog(tokenId, wallet.address, 'data:application/json;base64,e30=')],
        }),
    }
    const client = makeClient({ provider, wallet, mintTx: tx })
    const result = await client.mintWithPlaceholder('data:application/json;base64,e30=')
    expect(result.tokenId).toBe(tokenId)
    expect(result.txHash).toBe(tx.hash)
  })

  it('throws when the receipt has no SCUTIdentityRegistered event', async () => {
    const provider = new MockProvider() as unknown as Provider
    const wallet = makeWallet(provider)
    const tx: MintTxStub = {
      hash: '0x1111',
      wait: () => Promise.resolve({ logs: [] }),
    }
    const client = makeClient({ provider, wallet, mintTx: tx })
    await expect(client.mintWithPlaceholder('data:application/json;base64,e30=')).rejects.toThrow(
      /SCUTIdentityRegistered/,
    )
  })

  it('throws when wait returns null', async () => {
    const provider = new MockProvider() as unknown as Provider
    const wallet = makeWallet(provider)
    const tx: MintTxStub = {
      hash: '0x2222',
      wait: () => Promise.resolve(null),
    }
    const client = makeClient({ provider, wallet, mintTx: tx })
    await expect(client.mintWithPlaceholder('data:application/json;base64,e30=')).rejects.toThrow(
      /null receipt/,
    )
  })
})

describe('waitForOwnerOfReadable (RPC consistency)', () => {
  it('resolves on the first call when ownerOf succeeds immediately', async () => {
    const provider = new MockProvider() as unknown as Provider
    const wallet = makeWallet(provider)
    const client = makeClient({
      provider,
      wallet,
      ownerOfBehavior: { failuresBeforeSuccess: 0 },
    })
    await expect(client.waitForOwnerOfReadable(42n)).resolves.toBeUndefined()
  })

  it('retries on transient failures and resolves once a backend has the new state', async () => {
    const provider = new MockProvider() as unknown as Provider
    const wallet = makeWallet(provider)
    const client = makeClient({
      provider,
      wallet,
      ownerOfBehavior: { failuresBeforeSuccess: 3 }, // 3 stale, then success
    })
    await expect(client.waitForOwnerOfReadable(42n)).resolves.toBeUndefined()
  })

  it('throws after pollMaxAttempts (5) failures with a descriptive message', async () => {
    const provider = new MockProvider() as unknown as Provider
    const wallet = makeWallet(provider)
    const client = makeClient({
      provider,
      wallet,
      ownerOfBehavior: { failuresBeforeSuccess: 100 }, // never succeeds
    })
    await expect(client.waitForOwnerOfReadable(42n)).rejects.toThrow(/ownerOf.*not readable.*5/)
  })
})

describe('updateIdentityUri', () => {
  it('returns the tx hash on a successful confirmation', async () => {
    const provider = new MockProvider() as unknown as Provider
    const wallet = makeWallet(provider)
    const tx: UpdateTxStub = {
      hash: '0xabcdef',
      wait: () => Promise.resolve({ logs: [] }),
    }
    const client = makeClient({ provider, wallet, updateTx: tx })
    const result = await client.updateIdentityUri(
      12345n,
      'data:application/json;base64,eyJzaWlWZXJzaW9uIjoxfQ==',
    )
    expect(result.txHash).toBe(tx.hash)
  })

  it('throws when the receipt is null', async () => {
    const provider = new MockProvider() as unknown as Provider
    const wallet = makeWallet(provider)
    const tx: UpdateTxStub = {
      hash: '0xabcdef',
      wait: () => Promise.resolve(null),
    }
    const client = makeClient({ provider, wallet, updateTx: tx })
    await expect(client.updateIdentityUri(12345n, 'x')).rejects.toThrow(/null receipt/)
  })
})

describe('getWalletBalance', () => {
  it('returns the provider balance for the wallet address', async () => {
    const mockProvider = new MockProvider()
    mockProvider.balance = 70_000_000_000_000_000n // 0.07 ETH
    const provider = mockProvider as unknown as Provider
    const wallet = makeWallet(provider)
    const client = makeClient({ provider, wallet })
    expect(await client.getWalletBalance()).toBe(70_000_000_000_000_000n)
    expect(mockProvider.getBalance).toHaveBeenCalledWith(wallet.address)
  })
})

describe('walletAddress', () => {
  it('exposes the wallet public address (used for funding alerts)', () => {
    const provider = new MockProvider() as unknown as Provider
    const wallet = makeWallet(provider)
    const client = makeClient({ provider, wallet })
    expect(client.walletAddress).toBe(wallet.address)
    expect(client.walletAddress).toMatch(/^0x[a-fA-F0-9]{40}$/)
  })
})
