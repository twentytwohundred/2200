/**
 * Tests for the custodial keystore (Epic 4 Phase A PR B).
 *
 * Cover:
 *  - Master-key generation: first call writes 32 bytes, second call
 *    reads same bytes back; mode 0600 on the file.
 *  - Master-key length validation: corruption → throws.
 *  - Generate keypairs: both Ed25519 + X25519 produce 32-byte raw
 *    public + private keys.
 *  - Round-trip: write → read returns identical private keys.
 *  - Public-key consistency: writeAgentKeys returns the same public
 *    key bytes as the generated keypair.
 *  - Wrong master key (different bytes) → readAgentPrivateKeys throws
 *    on GCM tag mismatch.
 *  - Tamper with ciphertext → throws.
 *  - hasAgentKeys returns false before, true after.
 *  - Per-Agent isolation: keys for two Agents under the same master
 *    key do not decrypt with each other's wrapping key.
 *  - Mode 0600 on every key file on disk.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  hasAgentKeys,
  loadOrCreateMasterKey,
  readAgentPrivateKeys,
  writeAgentKeys,
} from '../../../src/runtime/identity/keystore.js'
import { generateAgentKeypairs } from '../../../src/runtime/identity/keystore-keygen.js'
import { agentIdentityPaths, masterKeyPath } from '../../../src/runtime/storage/layout.js'
import { initHome } from '../../../src/runtime/storage/init.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-keystore-'))
  await initHome(home)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

async function modeOf(path: string): Promise<number> {
  const s = await stat(path)
  return s.mode & 0o777
}

describe('master key', () => {
  it('first call writes a 32-byte file with mode 0600 and returns its bytes', async () => {
    const k = await loadOrCreateMasterKey(home)
    expect(k.length).toBe(32)
    const path = masterKeyPath(home)
    const onDisk = await readFile(path)
    expect(onDisk.length).toBe(32)
    expect(Buffer.compare(k, onDisk)).toBe(0)
    expect(await modeOf(path)).toBe(0o600)
  })

  it('second call reads the same bytes back', async () => {
    const a = await loadOrCreateMasterKey(home)
    const b = await loadOrCreateMasterKey(home)
    expect(Buffer.compare(a, b)).toBe(0)
  })

  it('throws if the master key file is the wrong length (corruption)', async () => {
    await loadOrCreateMasterKey(home)
    await writeFile(masterKeyPath(home), Buffer.from('too short'))
    await expect(loadOrCreateMasterKey(home)).rejects.toThrow(/master key/)
  })
})

describe('generateAgentKeypairs', () => {
  it('produces 32-byte raw Ed25519 + X25519 keys', () => {
    const kp = generateAgentKeypairs()
    expect(kp.ed25519.publicKeyRaw.length).toBe(32)
    expect(kp.ed25519.privateKeyRaw.length).toBe(32)
    expect(kp.x25519.publicKeyRaw.length).toBe(32)
    expect(kp.x25519.privateKeyRaw.length).toBe(32)
  })

  it('produces fresh keys on each call', () => {
    const a = generateAgentKeypairs()
    const b = generateAgentKeypairs()
    expect(Buffer.compare(a.ed25519.privateKeyRaw, b.ed25519.privateKeyRaw)).not.toBe(0)
    expect(Buffer.compare(a.x25519.privateKeyRaw, b.x25519.privateKeyRaw)).not.toBe(0)
  })
})

describe('round-trip seal / open', () => {
  it('writeAgentKeys then readAgentPrivateKeys returns identical private keys', async () => {
    const masterKey = await loadOrCreateMasterKey(home)
    const kp = generateAgentKeypairs()
    const pub = await writeAgentKeys({ home, agentName: 'hobby', keypairs: kp, masterKey })
    expect(pub.ed25519).toBe(kp.ed25519.publicKeyRaw.toString('base64'))
    expect(pub.x25519).toBe(kp.x25519.publicKeyRaw.toString('base64'))

    const out = await readAgentPrivateKeys({ home, agentName: 'hobby', masterKey })
    expect(Buffer.compare(out.ed25519PrivateKeyRaw, kp.ed25519.privateKeyRaw)).toBe(0)
    expect(Buffer.compare(out.x25519PrivateKeyRaw, kp.x25519.privateKeyRaw)).toBe(0)
  })

  it('every persisted key file has mode 0600', async () => {
    const masterKey = await loadOrCreateMasterKey(home)
    const kp = generateAgentKeypairs()
    await writeAgentKeys({ home, agentName: 'hobby', keypairs: kp, masterKey })
    const paths = agentIdentityPaths(home, 'hobby')
    expect(await modeOf(paths.signingKey)).toBe(0o600)
    expect(await modeOf(paths.encryptionKey)).toBe(0o600)
    expect(await modeOf(paths.salt)).toBe(0o600)
  })
})

describe('error paths', () => {
  it('readAgentPrivateKeys throws on a wrong master key (GCM tag mismatch)', async () => {
    const masterKey = await loadOrCreateMasterKey(home)
    const kp = generateAgentKeypairs()
    await writeAgentKeys({ home, agentName: 'hobby', keypairs: kp, masterKey })

    const wrongMaster = Buffer.alloc(32, 0xff)
    await expect(
      readAgentPrivateKeys({ home, agentName: 'hobby', masterKey: wrongMaster }),
    ).rejects.toThrow()
  })

  it('readAgentPrivateKeys throws when ciphertext has been tampered', async () => {
    const masterKey = await loadOrCreateMasterKey(home)
    const kp = generateAgentKeypairs()
    await writeAgentKeys({ home, agentName: 'hobby', keypairs: kp, masterKey })

    const paths = agentIdentityPaths(home, 'hobby')
    const blob = JSON.parse(await readFile(paths.signingKey, 'utf8')) as { ciphertext: string }
    blob.ciphertext = `${blob.ciphertext.slice(0, -2)}00`
    await writeFile(paths.signingKey, JSON.stringify(blob))
    await expect(readAgentPrivateKeys({ home, agentName: 'hobby', masterKey })).rejects.toThrow()
  })

  it('readAgentPrivateKeys throws when the agent has no provisioned keys', async () => {
    const masterKey = await loadOrCreateMasterKey(home)
    await expect(
      readAgentPrivateKeys({ home, agentName: 'no-such-agent', masterKey }),
    ).rejects.toThrow()
  })
})

describe('hasAgentKeys', () => {
  it('returns false before provisioning, true after', async () => {
    const masterKey = await loadOrCreateMasterKey(home)
    expect(await hasAgentKeys(home, 'hobby')).toBe(false)
    await writeAgentKeys({
      home,
      agentName: 'hobby',
      keypairs: generateAgentKeypairs(),
      masterKey,
    })
    expect(await hasAgentKeys(home, 'hobby')).toBe(true)
  })
})

describe('per-Agent isolation', () => {
  it("one Agent's wrapped keys do not decrypt under another Agent's wrapping key", async () => {
    const masterKey = await loadOrCreateMasterKey(home)
    const hobbyKp = generateAgentKeypairs()
    const simonKp = generateAgentKeypairs()
    await writeAgentKeys({ home, agentName: 'hobby', keypairs: hobbyKp, masterKey })
    await writeAgentKeys({ home, agentName: 'simon', keypairs: simonKp, masterKey })

    // Swap salts: copy hobby's salt over simon's. Now simon's ciphertext
    // would need hobby's wrapping key to open, but simon's agent_name
    // also factors into HKDF info... so even with the same salt, the
    // wrapping keys still differ. The decrypt must fail.
    const hobbyPaths = agentIdentityPaths(home, 'hobby')
    const simonPaths = agentIdentityPaths(home, 'simon')
    const hobbySalt = await readFile(hobbyPaths.salt)
    await writeFile(simonPaths.salt, hobbySalt)

    await expect(readAgentPrivateKeys({ home, agentName: 'simon', masterKey })).rejects.toThrow()
  })
})
