/**
 * Tests for SII v1 document construction + data URI encoding
 * (Epic 4 Phase A PR C).
 */
import { describe, expect, it } from 'vitest'
import {
  BASE_MAINNET_CHAIN_ID,
  SII_CONTRACT_ADDRESS,
  SII_PLACEHOLDER_DATA_URI,
  buildSiiDocument,
  composeScutUri,
  dataUriBytes,
  decodeFromDataUri,
  encodeAsDataUri,
} from '../../../src/runtime/identity/sii-document.js'

describe('locked constants', () => {
  it('Base mainnet chain id is 8453', () => {
    expect(BASE_MAINNET_CHAIN_ID).toBe(8453)
  })

  it('SII contract address is the canonical Base deployment from Garfield 2026-04-28', () => {
    expect(SII_CONTRACT_ADDRESS).toBe('0x199b48E27a28881502b251B0068F388Ce750feff')
  })

  it('placeholder data URI decodes to the empty object', () => {
    const placeholder = SII_PLACEHOLDER_DATA_URI
    expect(placeholder).toBe('data:application/json;base64,e30=')
    // {}-as-base64
    const payload = placeholder.slice('data:application/json;base64,'.length)
    expect(Buffer.from(payload, 'base64').toString('utf8')).toBe('{}')
  })
})

describe('buildSiiDocument', () => {
  it('produces a SII v1 document with the requested identity fields', () => {
    const doc = buildSiiDocument({
      chainId: BASE_MAINNET_CHAIN_ID,
      contract: SII_CONTRACT_ADDRESS,
      tokenId: 12345,
      ed25519PublicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      x25519PublicKeyB64: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=',
    })
    expect(doc.siiVersion).toBe(1)
    expect(doc.agentRef.scheme).toBe('scut')
    expect(doc.agentRef.chainId).toBe('8453')
    expect(doc.agentRef.contract).toBe(SII_CONTRACT_ADDRESS)
    expect(doc.agentRef.tokenId).toBe('12345')
    expect(doc.publicKeys.ed25519).toBe('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')
    expect(doc.publicKeys.x25519).toBe('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=')
    expect(doc.relays).toEqual([])
    expect(doc.capabilities.protocolVersion).toBe('0.2.0')
    expect(doc.capabilities.maxPayloadBytes).toBe(65536)
  })

  it('stringifies tokenId from a bigint without precision loss', () => {
    const huge = 12345678901234567890n
    const doc = buildSiiDocument({
      chainId: BASE_MAINNET_CHAIN_ID,
      contract: SII_CONTRACT_ADDRESS,
      tokenId: huge,
      ed25519PublicKeyB64: 'a',
      x25519PublicKeyB64: 'b',
    })
    expect(doc.agentRef.tokenId).toBe('12345678901234567890')
  })

  it('honors a maxPayloadBytes override', () => {
    const doc = buildSiiDocument({
      chainId: BASE_MAINNET_CHAIN_ID,
      contract: SII_CONTRACT_ADDRESS,
      tokenId: 1,
      ed25519PublicKeyB64: 'a',
      x25519PublicKeyB64: 'b',
      maxPayloadBytes: 16384,
    })
    expect(doc.capabilities.maxPayloadBytes).toBe(16384)
  })
})

describe('encodeAsDataUri / decodeFromDataUri', () => {
  it('round-trips an SII document through data: URI encoding', () => {
    const doc = buildSiiDocument({
      chainId: BASE_MAINNET_CHAIN_ID,
      contract: SII_CONTRACT_ADDRESS,
      tokenId: 42,
      ed25519PublicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      x25519PublicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    })
    const uri = encodeAsDataUri(doc)
    expect(uri.startsWith('data:application/json;base64,')).toBe(true)
    const decoded = decodeFromDataUri(uri)
    expect(decoded).toEqual(doc)
  })

  it('produces the same URI byte-for-byte for the same document', () => {
    const doc = buildSiiDocument({
      chainId: BASE_MAINNET_CHAIN_ID,
      contract: SII_CONTRACT_ADDRESS,
      tokenId: 1,
      ed25519PublicKeyB64: 'a',
      x25519PublicKeyB64: 'b',
    })
    expect(encodeAsDataUri(doc)).toBe(encodeAsDataUri(doc))
  })

  it('decodeFromDataUri throws on a non-data URI', () => {
    expect(() => decodeFromDataUri('https://example.com/doc.json')).toThrow(
      /data:application\/json/,
    )
  })

  it('decodeFromDataUri throws on a malformed payload', () => {
    expect(() => decodeFromDataUri('data:application/json;base64,not-json')).toThrow()
  })
})

describe('composeScutUri', () => {
  it('formats scut://<chainId>/<contract>/<tokenId> with lowercase contract', () => {
    expect(composeScutUri(BASE_MAINNET_CHAIN_ID, SII_CONTRACT_ADDRESS, 42)).toBe(
      'scut://8453/0x199b48e27a28881502b251b0068f388ce750feff/42',
    )
  })

  it('handles a bigint tokenId without scientific notation', () => {
    expect(composeScutUri(BASE_MAINNET_CHAIN_ID, SII_CONTRACT_ADDRESS, 12345678901234567890n)).toBe(
      'scut://8453/0x199b48e27a28881502b251b0068f388ce750feff/12345678901234567890',
    )
  })
})

describe('dataUriBytes', () => {
  it('reports the URI byte length within the expected ~500-700 byte range for a typical SII document', () => {
    // Per Garfield's 2026-04-28 follow-up: typical SII documents
    // encode to ~500-700 bytes. Exact size depends on key encoding
    // length; this test pins the order of magnitude.
    const doc = buildSiiDocument({
      chainId: BASE_MAINNET_CHAIN_ID,
      contract: SII_CONTRACT_ADDRESS,
      tokenId: 12345,
      ed25519PublicKeyB64: Buffer.alloc(32).toString('base64'),
      x25519PublicKeyB64: Buffer.alloc(32).toString('base64'),
    })
    const bytes = dataUriBytes(doc)
    expect(bytes).toBeGreaterThan(200)
    expect(bytes).toBeLessThan(1000)
  })
})
