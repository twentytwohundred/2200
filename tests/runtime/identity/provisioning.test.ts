/**
 * Tests for the SCUT provisioning pipeline (Epic 4 Phase A v0.4).
 *
 * Three-state machine: pending → keys_generated → registered, plus
 * an `errored` sink. Tests inject a fake RegisterClient so they
 * never touch the network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initHome } from '../../../src/runtime/storage/init.js'
import { agentIdentityPaths } from '../../../src/runtime/storage/layout.js'
import {
  ProvisioningPipeline,
  type IdentityWriter,
  type KeyStoreFns,
  type ProvisionState,
} from '../../../src/runtime/identity/provisioning.js'
import {
  RegisterRateLimitError,
  RegisterOnChainError,
  type RegisterClient,
  type RegisterRequest,
  type RegisterResponse,
  type UpdateRequest,
  type TransferRequest,
  type HealthResponse,
} from '../../../src/runtime/identity/register-client.js'

let home: string
let writes: Parameters<IdentityWriter>[0][]

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-provisioning-'))
  await initHome(home)
  writes = []
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

const fakeKeyStore: KeyStoreFns = {
  generate: () => ({
    ed25519: {
      publicKeyRaw: Buffer.alloc(32, 0x11),
      privateKeyRaw: Buffer.alloc(32, 0x22),
    },
    x25519: {
      publicKeyRaw: Buffer.alloc(32, 0x33),
      privateKeyRaw: Buffer.alloc(32, 0x44),
    },
  }),
  write: () =>
    Promise.resolve({
      ed25519: 'EQEREREREREREREREREREREREREREREREREREREREREREw==',
      x25519: 'MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMw==',
    }),
}

const writeIdentity: IdentityWriter = (args) => {
  writes.push(args)
  return Promise.resolve()
}

interface FakeOpts {
  response?: Partial<RegisterResponse>
  throwOn?: 'register' | 'update' | 'transfer' | 'health'
  throwError?: Error
  onCall?: (method: string) => void
}

function makeFakeRegisterClient(opts: FakeOpts = {}): RegisterClient {
  const baseResponse: RegisterResponse = {
    ref: 'scut://8453/0x199b48e27a28881502b251b0068f388ce750feff/12345',
    agentRef: {
      chainId: 8453,
      contract: '0x199b48e27a28881502b251b0068f388ce750feff',
      tokenId: '12345',
    },
    txHashes: {
      mint: '0x' + 'a'.repeat(64),
      update: '0x' + 'b'.repeat(64),
    },
    basescan: {
      mint: 'https://basescan.org/tx/0xaaa',
      update: 'https://basescan.org/tx/0xbbb',
    },
    document: {
      siiVersion: 1,
      agentRef: {
        chainId: 8453,
        contract: '0x199b48e27a28881502b251b0068f388ce750feff',
        tokenId: '12345',
      },
      publicKeys: {
        ed25519: 'EQEREREREREREREREREREREREREREREREREREREREREREw==',
        x25519: 'MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMw==',
      },
      relays: [],
      capabilities: { protocolVersion: '0.2.0', maxPayloadBytes: 65536 },
    },
  }
  const response: RegisterResponse = { ...baseResponse, ...opts.response }
  return {
    register: (_req: RegisterRequest) => {
      opts.onCall?.('register')
      if (opts.throwOn === 'register' && opts.throwError) return Promise.reject(opts.throwError)
      return Promise.resolve(response)
    },
    update: (_req: UpdateRequest) => {
      opts.onCall?.('update')
      if (opts.throwOn === 'update' && opts.throwError) return Promise.reject(opts.throwError)
      return Promise.resolve({
        tokenId: response.agentRef.tokenId,
        txHash: response.txHashes.update,
        basescan: response.basescan.update,
      })
    },
    transfer: (_req: TransferRequest) => {
      opts.onCall?.('transfer')
      if (opts.throwOn === 'transfer' && opts.throwError) return Promise.reject(opts.throwError)
      return Promise.resolve({
        tokenId: response.agentRef.tokenId,
        newOwner: '0x0000000000000000000000000000000000000000',
        txHash: response.txHashes.update,
        basescan: response.basescan.update,
      })
    },
    health: () => {
      opts.onCall?.('health')
      if (opts.throwOn === 'health' && opts.throwError) return Promise.reject(opts.throwError)
      const h: HealthResponse = {
        status: 'ok',
        wallet: { address: '0xabc', balanceWei: '70000000000000000', balanceEth: '0.07' },
        runway: { registrationsAtConservativeGas: 2221, gasPerRegistrationEstimate: '630000' },
        registrationsCount: 0,
        version: '0.1.0',
      }
      return Promise.resolve(h)
    },
  }
}

describe('ProvisioningPipeline (Path B)', () => {
  it('runs the happy path: pending → keys_generated → registered', async () => {
    const pipeline = new ProvisioningPipeline({
      home,
      agentName: 'hobby',
      masterKey: Buffer.alloc(32, 0xaa),
      registerClient: makeFakeRegisterClient(),
      keyStore: fakeKeyStore,
      writeIdentity,
      now: () => new Date('2026-04-29T10:00:00.000Z'),
    })
    const final = await pipeline.run()
    expect(final.state).toBe('registered')
    expect(final.token_id).toBe('12345')
    expect(final.scut_uri).toBe('scut://8453/0x199b48e27a28881502b251b0068f388ce750feff/12345')
    expect(final.mint_tx_hash).toMatch(/^0xa+$/)
    expect(final.update_tx_hash).toMatch(/^0xb+$/)

    expect(writes).toHaveLength(1)
    expect(writes[0]!.scut.uri).toBe(final.scut_uri)
    expect(writes[0]!.scut.identity_doc_uri).toMatch(/^data:application\/json;base64,/)
  })

  it('persists state checkpoint and only calls register once', async () => {
    const calls: string[] = []
    const pipeline = new ProvisioningPipeline({
      home,
      agentName: 'hobby',
      masterKey: Buffer.alloc(32, 0xaa),
      registerClient: makeFakeRegisterClient({
        onCall: (m) => calls.push(m),
      }),
      keyStore: fakeKeyStore,
      writeIdentity,
    })
    await pipeline.run()
    expect(calls.filter((c) => c === 'register')).toHaveLength(1)
    const path = agentIdentityPaths(home, 'hobby').provisionState
    const persisted = JSON.parse(await readFile(path, 'utf8')) as ProvisionState
    expect(persisted.state).toBe('registered')
  })

  it('re-running a registered Agent is a no-op (idempotent)', async () => {
    const calls: string[] = []
    const pipeline = new ProvisioningPipeline({
      home,
      agentName: 'hobby',
      masterKey: Buffer.alloc(32, 0xaa),
      registerClient: makeFakeRegisterClient({
        onCall: (m) => calls.push(m),
      }),
      keyStore: fakeKeyStore,
      writeIdentity,
    })
    await pipeline.run()
    const callsAfterFirst = calls.length
    await pipeline.run()
    expect(calls.length).toBe(callsAfterFirst)
  })

  it('persists errored state and surfaces an Important notification on RegisterRateLimitError', async () => {
    const pipeline = new ProvisioningPipeline({
      home,
      agentName: 'hobby',
      masterKey: Buffer.alloc(32, 0xaa),
      registerClient: makeFakeRegisterClient({
        throwOn: 'register',
        throwError: new RegisterRateLimitError('display name already used today', {
          status: 429,
          responseBody: { error: 'display name already used today', displayName: 'hobby' },
        }),
      }),
      keyStore: fakeKeyStore,
      writeIdentity,
    })
    await expect(pipeline.run()).rejects.toThrow(RegisterRateLimitError)
    const path = agentIdentityPaths(home, 'hobby').provisionState
    const persisted = JSON.parse(await readFile(path, 'utf8')) as ProvisionState
    expect(persisted.state).toBe('errored')
    expect(persisted.error?.class).toBe('RegisterRateLimitError')
    expect(persisted.error?.at_state).toBe('keys_generated')
    const notifDir = join(home, 'state', 'notifications')
    const notifFiles = await readdir(notifDir)
    expect(notifFiles.length).toBeGreaterThan(0)
    const notifText = await readFile(join(notifDir, notifFiles[0]!), 'utf8')
    expect(notifText).toMatch(/rename the Agent or wait/i)
  })

  it('persists errored state on RegisterOnChainError', async () => {
    const pipeline = new ProvisioningPipeline({
      home,
      agentName: 'hobby',
      masterKey: Buffer.alloc(32, 0xaa),
      registerClient: makeFakeRegisterClient({
        throwOn: 'register',
        throwError: new RegisterOnChainError('on-chain mint failed', {
          status: 502,
          responseBody: { error: 'on-chain mint failed', detail: 'rpc timeout' },
        }),
      }),
      keyStore: fakeKeyStore,
      writeIdentity,
    })
    await expect(pipeline.run()).rejects.toThrow(RegisterOnChainError)
    const path = agentIdentityPaths(home, 'hobby').provisionState
    const persisted = JSON.parse(await readFile(path, 'utf8')) as ProvisionState
    expect(persisted.state).toBe('errored')
    expect(persisted.error?.class).toBe('RegisterOnChainError')
  })

  it('passes the configured displayName to the register client', async () => {
    let captured: RegisterRequest | null = null
    const captureClient: RegisterClient = {
      register: (req: RegisterRequest) => {
        captured = req
        return makeFakeRegisterClient().register(req)
      },
      update: (req) => makeFakeRegisterClient().update(req),
      transfer: (req) => makeFakeRegisterClient().transfer(req),
      health: () => makeFakeRegisterClient().health(),
    }
    const pipeline = new ProvisioningPipeline({
      home,
      agentName: 'hobby',
      displayName: 'Hobby (lead build agent)',
      masterKey: Buffer.alloc(32, 0xaa),
      registerClient: captureClient,
      keyStore: fakeKeyStore,
      writeIdentity,
    })
    await pipeline.run()
    expect(captured).not.toBeNull()
    expect(captured!.displayName).toBe('Hobby (lead build agent)')
    expect(captured!.keys.signing.algorithm).toBe('ed25519')
    expect(captured!.keys.encryption.algorithm).toBe('x25519')
  })

  it('defaults displayName to agentName when not specified', async () => {
    let captured: RegisterRequest | null = null
    const captureClient: RegisterClient = {
      register: (req) => {
        captured = req
        return makeFakeRegisterClient().register(req)
      },
      update: (req) => makeFakeRegisterClient().update(req),
      transfer: (req) => makeFakeRegisterClient().transfer(req),
      health: () => makeFakeRegisterClient().health(),
    }
    const pipeline = new ProvisioningPipeline({
      home,
      agentName: 'simon',
      masterKey: Buffer.alloc(32, 0xaa),
      registerClient: captureClient,
      keyStore: fakeKeyStore,
      writeIdentity,
    })
    await pipeline.run()
    expect(captured!.displayName).toBe('simon')
  })
})
