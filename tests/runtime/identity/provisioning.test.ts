/**
 * Tests for the SCUT provisioning pipeline (Epic 4 Phase A PR E).
 *
 * Cover:
 *  - happy path: pending → keys_generated → token_minted → registered
 *  - resume from each persisted state without redoing prior work
 *  - mint failure → errored, error notification fires
 *  - update failure (TX2) → errored at token_minted, mint state preserved
 *  - rerun a registered agent is a no-op
 *  - success notification carries token_id; error notification names the state
 *  - writeIdentity called with the right scut block on success
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  ProvisioningPipeline,
  type IdentityWriter,
  type KeyStoreFns,
  type OnChainClient,
  type ProvisionState,
} from '../../../src/runtime/identity/provisioning.js'
import { agentIdentityPaths, homePaths } from '../../../src/runtime/storage/layout.js'
import { initHome } from '../../../src/runtime/storage/init.js'

const CHAIN_ID = 8453
const CONTRACT = '0x199b48E27a28881502b251B0068F388Ce750feff'
const MASTER_KEY = Buffer.alloc(32, 0x42)
const FIXED_TS = '2026-04-29T15:23:00.000Z'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-provision-'))
  await initHome(home)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function makeKeyStore(): KeyStoreFns {
  return {
    generate: () => ({
      ed25519: { publicKeyRaw: Buffer.alloc(32, 0xaa), privateKeyRaw: Buffer.alloc(32, 0xbb) },
      x25519: { publicKeyRaw: Buffer.alloc(32, 0xcc), privateKeyRaw: Buffer.alloc(32, 0xdd) },
    }),
    write: vi.fn(() =>
      Promise.resolve({
        ed25519: Buffer.alloc(32, 0xaa).toString('base64'),
        x25519: Buffer.alloc(32, 0xcc).toString('base64'),
      }),
    ),
  }
}

function makeOnChain(
  opts: {
    mintResult?: { tokenId: bigint; txHash: string }
    mintError?: Error
    updateResult?: { txHash: string }
    updateError?: Error
  } = {},
): OnChainClient {
  return {
    walletAddress: '0x6050bB51838d007336e10A0054e3173998269b6C',
    mintWithPlaceholder: vi.fn(() => {
      if (opts.mintError) return Promise.reject(opts.mintError)
      return Promise.resolve(
        opts.mintResult ?? {
          tokenId: 12345n,
          txHash: '0xabcd0123456789abcd0123456789abcd0123456789abcd0123456789abcdabcd',
        },
      )
    }),
    waitForOwnerOfReadable: vi.fn(() => Promise.resolve()),
    updateIdentityUri: vi.fn(() => {
      if (opts.updateError) return Promise.reject(opts.updateError)
      return Promise.resolve(
        opts.updateResult ?? {
          txHash: '0xfedc9876543210fedc9876543210fedc9876543210fedc9876543210fedcfedc',
        },
      )
    }),
  }
}

interface IdentityWriterCalls {
  calls: Parameters<IdentityWriter>[0][]
  writer: IdentityWriter
}

function makeIdentityWriter(): IdentityWriterCalls {
  const calls: Parameters<IdentityWriter>[0][] = []
  const writer: IdentityWriter = (args) => {
    calls.push(args)
    return Promise.resolve()
  }
  return { calls, writer: vi.fn(writer) }
}

async function readState(agentName: string): Promise<ProvisionState> {
  const path = agentIdentityPaths(home, agentName).provisionState
  return JSON.parse(await readFile(path, 'utf8')) as ProvisionState
}

async function readNotifications(): Promise<
  { frontmatter: Record<string, unknown>; body: string }[]
> {
  const dir = homePaths(home).stateNotifications
  const entries = await readdir(dir).catch(() => [])
  const out: { frontmatter: Record<string, unknown>; body: string }[] = []
  const re = /^---\n([\s\S]+?)\n---\n([\s\S]*)$/
  for (const e of entries) {
    if (!e.endsWith('.md')) continue
    const text = await readFile(join(dir, e), 'utf8')
    const m = re.exec(text)
    if (!m) continue
    out.push({ frontmatter: parseYaml(m[1]!) as Record<string, unknown>, body: m[2]! })
  }
  return out
}

describe('happy path', () => {
  it('runs pending → keys_generated → token_minted → registered, persists the scut block', async () => {
    const onChain = makeOnChain()
    const keyStore = makeKeyStore()
    const idWriter = makeIdentityWriter()
    const pipeline = new ProvisioningPipeline({
      home,
      agentName: 'hobby',
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      masterKey: MASTER_KEY,
      onChain,
      keyStore,
      writeIdentity: idWriter.writer,
      now: () => new Date(FIXED_TS),
    })

    const final = await pipeline.run()

    expect(final.state).toBe('registered')
    expect(final.token_id).toBe('12345')
    expect(final.mint_tx_hash).toMatch(/^0xabcd/)
    expect(final.update_tx_hash).toMatch(/^0xfedc/)

    const stateOnDisk = await readState('hobby')
    expect(stateOnDisk.state).toBe('registered')

    expect(idWriter.calls).toHaveLength(1)
    const scut = idWriter.calls[0]!.scut
    expect(scut.token_id).toBe('12345')
    expect(scut.uri).toBe('scut://8453/0x199b48e27a28881502b251b0068f388ce750feff/12345')
    expect(scut.identity_doc_uri).toMatch(/^data:application\/json;base64,/)
    expect(scut.public_keys.ed25519).toBe(Buffer.alloc(32, 0xaa).toString('base64'))
  })

  it('fires a passive success notification with the token id', async () => {
    const pipeline = new ProvisioningPipeline({
      home,
      agentName: 'hobby',
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      masterKey: MASTER_KEY,
      onChain: makeOnChain(),
      keyStore: makeKeyStore(),
      writeIdentity: makeIdentityWriter().writer,
      now: () => new Date(FIXED_TS),
    })
    await pipeline.run()
    const notifs = await readNotifications()
    const success = notifs.find((n) => n.frontmatter['kind'] === 'identity_provisioned')
    expect(success).toBeDefined()
    expect(success!.frontmatter['tier']).toBe('passive')
    expect(success!.frontmatter['token_id']).toBe('12345')
    expect(success!.body).toContain('hobby')
    expect(success!.body).toContain('12345')
  })
})

describe('resume', () => {
  it('a re-run of a registered Agent is a no-op (does not call onChain or writeIdentity again)', async () => {
    const onChain = makeOnChain()
    const keyStore = makeKeyStore()
    const idWriter = makeIdentityWriter()
    const opts = {
      home,
      agentName: 'hobby',
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      masterKey: MASTER_KEY,
      onChain,
      keyStore,
      writeIdentity: idWriter.writer,
      now: () => new Date(FIXED_TS),
    }

    await new ProvisioningPipeline(opts).run()
    const mintCalls1 = (onChain.mintWithPlaceholder as ReturnType<typeof vi.fn>).mock.calls.length
    const writeCalls1 = idWriter.calls.length

    await new ProvisioningPipeline(opts).run()
    const mintCalls2 = (onChain.mintWithPlaceholder as ReturnType<typeof vi.fn>).mock.calls.length
    const writeCalls2 = idWriter.calls.length

    expect(mintCalls2).toBe(mintCalls1)
    expect(writeCalls2).toBe(writeCalls1)
  })

  it('resume from token_minted skips the mint and proceeds to update', async () => {
    const keyStore = makeKeyStore()
    const idWriter = makeIdentityWriter()
    // First run: mint succeeds; updateIdentityUri throws so we land at token_minted.
    const onChainFirst = makeOnChain({ updateError: new Error('rpc timeout') })
    await expect(
      new ProvisioningPipeline({
        home,
        agentName: 'hobby',
        chainId: CHAIN_ID,
        contractAddress: CONTRACT,
        masterKey: MASTER_KEY,
        onChain: onChainFirst,
        keyStore,
        writeIdentity: idWriter.writer,
        now: () => new Date(FIXED_TS),
      }).run(),
    ).rejects.toThrow(/rpc timeout/)

    // Persisted state is errored, but at_state is token_minted.
    const stateAfterFirst = await readState('hobby')
    expect(stateAfterFirst.state).toBe('errored')
    expect(stateAfterFirst.error?.at_state).toBe('token_minted')
    expect(stateAfterFirst.token_id).toBe('12345')

    // Repair: simulate operator clearing the error to retry from
    // token_minted (the recovery path the CLI's `retry` command will
    // use in PR F).
    const recovered: ProvisionState = {
      ...stateAfterFirst,
      state: 'token_minted',
      updated_at: FIXED_TS,
    }
    delete recovered.error
    const recoveredPath = agentIdentityPaths(home, 'hobby').provisionState
    await (await import('node:fs/promises')).writeFile(recoveredPath, JSON.stringify(recovered))

    // Second run: mint should NOT be called again; update should be.
    const onChainSecond = makeOnChain()
    await new ProvisioningPipeline({
      home,
      agentName: 'hobby',
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      masterKey: MASTER_KEY,
      onChain: onChainSecond,
      keyStore,
      writeIdentity: idWriter.writer,
      now: () => new Date(FIXED_TS),
    }).run()
    expect((onChainSecond.mintWithPlaceholder as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      0,
    )
    expect((onChainSecond.updateIdentityUri as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    const finalState = await readState('hobby')
    expect(finalState.state).toBe('registered')
  })
})

describe('failure paths', () => {
  it('mint failure → errored at keys_generated, error notification fires', async () => {
    const onChain = makeOnChain({ mintError: new Error('insufficient funds') })
    const idWriter = makeIdentityWriter()
    const pipeline = new ProvisioningPipeline({
      home,
      agentName: 'hobby',
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      masterKey: MASTER_KEY,
      onChain,
      keyStore: makeKeyStore(),
      writeIdentity: idWriter.writer,
      now: () => new Date(FIXED_TS),
    })
    await expect(pipeline.run()).rejects.toThrow(/insufficient funds/)

    const state = await readState('hobby')
    expect(state.state).toBe('errored')
    expect(state.error?.at_state).toBe('keys_generated')
    expect(state.error?.message).toBe('insufficient funds')

    expect(idWriter.calls).toHaveLength(0)

    const notifs = await readNotifications()
    const errNotif = notifs.find((n) => n.frontmatter['kind'] === 'identity_provision_failed')
    expect(errNotif).toBeDefined()
    expect(errNotif!.frontmatter['tier']).toBe('important')
    expect(errNotif!.frontmatter['at_state']).toBe('keys_generated')
  })

  it('update failure preserves the mint state for manual recovery', async () => {
    const onChain = makeOnChain({ updateError: new Error('boom') })
    const pipeline = new ProvisioningPipeline({
      home,
      agentName: 'hobby',
      chainId: CHAIN_ID,
      contractAddress: CONTRACT,
      masterKey: MASTER_KEY,
      onChain,
      keyStore: makeKeyStore(),
      writeIdentity: makeIdentityWriter().writer,
      now: () => new Date(FIXED_TS),
    })
    await expect(pipeline.run()).rejects.toThrow(/boom/)
    const state = await readState('hobby')
    expect(state.state).toBe('errored')
    expect(state.error?.at_state).toBe('token_minted')
    expect(state.token_id).toBe('12345')
    expect(state.mint_tx_hash).toMatch(/^0xabcd/)
  })
})
