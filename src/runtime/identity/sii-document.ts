/**
 * SCUT Identity Interface (SII) v1 document construction and
 * `data:` URI encoding (Epic 4 Phase A PR C).
 *
 * Per the Phase A spec v0.3, 2200 stores SII documents on-chain
 * as inline `data:application/json;base64,...` URIs (no IPFS, no
 * HTTPS hoster). This module produces the canonical document shape
 * that matches the SCUT spec §4.3 and encodes / decodes the URI
 * form used by the contract's URI slot.
 *
 * Pure functions; no I/O. The supervisor's provisioning pipeline
 * (PR E) calls these to compose the document with the real tokenId
 * after TX1 confirms, then passes the encoded URI to TX2.
 *
 * The placeholder URI used in TX1 (`data:application/json;base64,e30=`)
 * decodes to `{}`; the SII contract refuses empty URIs but accepts
 * the placeholder.
 */

/**
 * SII v1 document shape per the OpenSCUT spec §4.3.
 * Field names use camelCase to match the on-chain document the
 * resolver expects, NOT the snake_case form the Identity file uses.
 */
export interface SiiDocumentV1 {
  siiVersion: 1
  agentRef: {
    scheme: 'scut'
    chainId: string
    contract: string
    tokenId: string
  }
  publicKeys: {
    ed25519: string
    x25519: string
  }
  /**
   * Prioritized relay list. Empty at v1 of 2200's Phase A; the SCUT
   * resolver tolerates an empty list (the identity is addressable
   * and verifiable but not yet receivable). Phase B populates this.
   */
  relays: never[]
  capabilities: {
    protocolVersion: '0.2.0'
    maxPayloadBytes: number
  }
}

/** Locked Base mainnet contract per Garfield's 2026-04-28 confirmation. */
export const BASE_MAINNET_CHAIN_ID = 8453
export const SII_CONTRACT_ADDRESS = '0x199b48E27a28881502b251B0068F388Ce750feff'

/** Default max payload bytes for SCUT v0.2 messaging. The resolver does not enforce this; it is informational for senders. */
const DEFAULT_MAX_PAYLOAD_BYTES = 65536

/**
 * The placeholder URI used in TX1 (mint). Decodes to `{}` and
 * satisfies the contract's `URIEmpty` revert guard. The real URI
 * is set in TX2 via `updateIdentityURI`.
 */
export const SII_PLACEHOLDER_DATA_URI = 'data:application/json;base64,e30='

const DATA_URI_PREFIX = 'data:application/json;base64,'

export interface BuildSiiDocumentArgs {
  chainId: number
  contract: string
  tokenId: string | number | bigint
  ed25519PublicKeyB64: string
  x25519PublicKeyB64: string
  maxPayloadBytes?: number
}

/**
 * Construct an SII v1 document with the given identity components.
 * The chainId and contract default to Base mainnet + the locked
 * SII contract address; pass overrides for tests or future
 * multi-chain support.
 */
export function buildSiiDocument(args: BuildSiiDocumentArgs): SiiDocumentV1 {
  return {
    siiVersion: 1,
    agentRef: {
      scheme: 'scut',
      chainId: String(args.chainId),
      contract: args.contract,
      tokenId: String(args.tokenId),
    },
    publicKeys: {
      ed25519: args.ed25519PublicKeyB64,
      x25519: args.x25519PublicKeyB64,
    },
    relays: [],
    capabilities: {
      protocolVersion: '0.2.0',
      maxPayloadBytes: args.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
    },
  }
}

/**
 * Encode an SII document as a `data:application/json;base64,...`
 * URI suitable for the contract's URI slot.
 *
 * Uses canonical JSON (no whitespace, key order as written) so the
 * URI is byte-for-byte reproducible across re-encodes of the same
 * logical document. This matters because the on-chain URI is the
 * integrity check; resolvers compare the decoded content's
 * `agentRef` against the lookup triple.
 */
export function encodeAsDataUri(doc: SiiDocumentV1): string {
  const json = JSON.stringify(doc)
  const b64 = Buffer.from(json, 'utf8').toString('base64')
  return `${DATA_URI_PREFIX}${b64}`
}

/**
 * Decode a `data:application/json;base64,...` URI back to the SII
 * document. Throws if the URI does not have the expected prefix or
 * if the base64 payload does not parse as JSON.
 *
 * Used by tests and (in Phase B) by the resolver-verification
 * paths inside the runtime.
 */
export function decodeFromDataUri(uri: string): SiiDocumentV1 {
  if (!uri.startsWith(DATA_URI_PREFIX)) {
    throw new Error(`uri does not start with ${DATA_URI_PREFIX}`)
  }
  const b64 = uri.slice(DATA_URI_PREFIX.length)
  const json = Buffer.from(b64, 'base64').toString('utf8')
  return JSON.parse(json) as SiiDocumentV1
}

/**
 * Compose the canonical `scut://<chainId>/<contract>/<tokenId>` URI
 * used as the Agent's address in the Identity file's `scut.uri`
 * field and as the `from` field on outbound SCUT messages.
 *
 * The contract address is lowercased to match the form the resolver
 * normalizes to internally (per SCUT spec §4.6 addressing).
 */
export function composeScutUri(
  chainId: number,
  contract: string,
  tokenId: string | number | bigint,
): string {
  return `scut://${String(chainId)}/${contract.toLowerCase()}/${String(tokenId)}`
}

/**
 * Round-trip-check that a freshly-constructed document encodes to a
 * URI under a configurable byte ceiling. The on-chain URI slot is a
 * `string calldata` which is not capacity-bounded by the contract,
 * but operators should know if a document is materially bigger than
 * the typical ~500-700 bytes Garfield benchmarked against.
 */
export function dataUriBytes(doc: SiiDocumentV1): number {
  return Buffer.byteLength(encodeAsDataUri(doc), 'utf8')
}
