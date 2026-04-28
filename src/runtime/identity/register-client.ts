/**
 * HTTPS client for register.openscut.ai (Epic 4 Phase A v0.4).
 *
 * Per the v0.4 spec lock: Path B is the only production path. 2200
 * generates the Agent's keypair locally, posts the public halves to
 * OpenSCUT's hosted register service, and gets back the minted
 * token. The on-chain mint+update happens server-side. This client
 * is the entire "talk to OpenSCUT" surface.
 *
 * Endpoints (all under https://register.openscut.ai/scut/v1/):
 *   POST /register   — mint a new custodial SCUT identity.
 *   POST /update     — sign-and-update the SII URI for a token we
 *                      still hold custodially. Signed with the
 *                      Agent's Ed25519 private key over the
 *                      canonicalized new SII document.
 *   POST /transfer   — graduate a token to self-custody. Post-launch.
 *   GET  /health     — wallet runway, balance, registrations count.
 *
 * Error shapes are mapped onto a single typed-error tree so callers
 * can handle the operationally distinct failure modes (rate limit,
 * on-chain failure, service down) without parsing JSON themselves.
 */

export const DEFAULT_REGISTER_BASE_URL = 'https://register.openscut.ai'

export interface RegisterRequest {
  keys: {
    signing: { algorithm: 'ed25519'; publicKey: string }
    encryption: { algorithm: 'x25519'; publicKey: string }
  }
  /** Optional; OpenSCUT defaults to one https relay if absent. */
  relays?: { host: string; priority: number; protocols: string[] }[]
  /** Optional capabilities. v1 omits and accepts the server defaults. */
  capabilities?: string[]
  /**
   * Display name; surfaced to other Agents in the SCUT directory.
   * Subject to OpenSCUT's per-displayName-per-day rate limit.
   */
  displayName?: string
}

export interface AgentRef {
  chainId: number
  contract: string
  tokenId: string
}

export interface SiiDocument {
  siiVersion: number
  agentRef: AgentRef
  publicKeys: { ed25519: string; x25519: string }
  relays: { host: string; priority: number; protocols: string[] }[]
  capabilities: { protocolVersion: string; maxPayloadBytes?: number } | string[]
  displayName?: string
  updatedAt?: string
}

export interface RegisterResponse {
  ref: string
  agentRef: AgentRef
  txHashes: { mint: string; update: string }
  basescan: { mint: string; update: string }
  document: SiiDocument
}

export interface UpdateRequest {
  tokenId: string
  newSiiDoc: SiiDocument
  /** Base64-encoded Ed25519 detached signature over canonicalized newSiiDoc. */
  signature: string
}

export interface UpdateResponse {
  tokenId: string
  txHash: string
  basescan: string
}

export interface TransferRequest {
  tokenId: string
  /** 0x-prefixed 40-hex-char EOA. */
  newOwner: string
  /** Base64-encoded Ed25519 signature over `scut/v1/transfer:<tokenId>:<newOwner_lowercase>`. */
  signature: string
}

export interface TransferResponse {
  tokenId: string
  newOwner: string
  txHash: string
  basescan: string
}

export interface HealthResponse {
  status: 'ok' | 'degraded'
  wallet: { address: string; balanceWei: string; balanceEth: string }
  runway: {
    registrationsAtConservativeGas: number
    gasPerRegistrationEstimate: string
  }
  registrationsCount: number
  version: string
  /** Present when status is 'degraded'. */
  error?: string
  detail?: string
}

// ---------------------------------------------------------------------------
// Error tree
// ---------------------------------------------------------------------------

export class RegisterError extends Error {
  readonly status: number | undefined
  readonly responseBody: unknown
  constructor(message: string, opts: { status?: number; responseBody?: unknown } = {}) {
    super(message)
    this.name = 'RegisterError'
    this.status = opts.status
    this.responseBody = opts.responseBody
  }
}

/** 400 invalid request body (Zod-style flattened errors in `details`). */
export class RegisterRequestError extends RegisterError {
  constructor(message: string, opts: { status?: number; responseBody?: unknown } = {}) {
    super(message, opts)
    this.name = 'RegisterRequestError'
  }
}

/** 401 signature did not verify against the registered Ed25519 key. */
export class RegisterAuthError extends RegisterError {
  constructor(message: string, opts: { status?: number; responseBody?: unknown } = {}) {
    super(message, opts)
    this.name = 'RegisterAuthError'
  }
}

/** 404 token not registered with this service. */
export class RegisterNotFoundError extends RegisterError {
  constructor(message: string, opts: { status?: number; responseBody?: unknown } = {}) {
    super(message, opts)
    this.name = 'RegisterNotFoundError'
  }
}

/** 409 token already transferred or otherwise in conflicting state. */
export class RegisterConflictError extends RegisterError {
  constructor(message: string, opts: { status?: number; responseBody?: unknown } = {}) {
    super(message, opts)
    this.name = 'RegisterConflictError'
  }
}

/** 429 OpenSCUT rate limit (per-displayName, per-IP, etc.). */
export class RegisterRateLimitError extends RegisterError {
  constructor(message: string, opts: { status?: number; responseBody?: unknown } = {}) {
    super(message, opts)
    this.name = 'RegisterRateLimitError'
  }
}

/** 502 on-chain mint/update/transfer failed at OpenSCUT's RPC layer. */
export class RegisterOnChainError extends RegisterError {
  constructor(message: string, opts: { status?: number; responseBody?: unknown } = {}) {
    super(message, opts)
    this.name = 'RegisterOnChainError'
  }
}

/** 503 service-level limits exceeded (global daily cap, RPC unreachable). */
export class RegisterServiceUnavailableError extends RegisterError {
  constructor(message: string, opts: { status?: number; responseBody?: unknown } = {}) {
    super(message, opts)
    this.name = 'RegisterServiceUnavailableError'
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Interface used by ProvisioningPipeline (so tests can swap in a
 * fake without going over the network).
 */
export interface RegisterClient {
  register(req: RegisterRequest): Promise<RegisterResponse>
  update(req: UpdateRequest): Promise<UpdateResponse>
  transfer(req: TransferRequest): Promise<TransferResponse>
  health(): Promise<HealthResponse>
}

export interface RegisterClientOptions {
  /** Base URL. Default: https://register.openscut.ai */
  baseUrl?: string
  /** Inject for tests. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch
  /** Per-request timeout in ms. Default: 30s. */
  timeoutMs?: number
}

export function createRegisterClient(opts: RegisterClientOptions = {}): RegisterClient {
  const baseUrl = (opts.baseUrl ?? DEFAULT_REGISTER_BASE_URL).replace(/\/+$/, '')
  const fetchImpl = opts.fetch ?? globalThis.fetch
  const timeoutMs = opts.timeoutMs ?? 30_000

  async function call<T>(path: string, init: RequestInit): Promise<T> {
    const url = `${baseUrl}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, timeoutMs)
    let res: Response
    try {
      res = await fetchImpl(url, { ...init, signal: controller.signal })
    } catch (err) {
      throw new RegisterError(
        `request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      clearTimeout(timer)
    }
    let body: unknown = null
    const text = await res.text().catch(() => '')
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown
      } catch {
        body = text
      }
    }
    if (res.ok) return body as T
    throwFor(res.status, body)
  }

  return {
    async register(req) {
      return call<RegisterResponse>('/scut/v1/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(req),
      })
    },
    async update(req) {
      return call<UpdateResponse>('/scut/v1/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(req),
      })
    },
    async transfer(req) {
      return call<TransferResponse>('/scut/v1/transfer', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(req),
      })
    },
    async health() {
      return call<HealthResponse>('/scut/v1/health', {
        method: 'GET',
        headers: { accept: 'application/json' },
      })
    },
  }
}

function throwFor(status: number, body: unknown): never {
  const message = extractMessage(body) ?? `register service returned ${String(status)}`
  const opts = { status, responseBody: body }
  switch (status) {
    case 400:
      throw new RegisterRequestError(message, opts)
    case 401:
      throw new RegisterAuthError(message, opts)
    case 404:
      throw new RegisterNotFoundError(message, opts)
    case 409:
      throw new RegisterConflictError(message, opts)
    case 429:
      throw new RegisterRateLimitError(message, opts)
    case 502:
      throw new RegisterOnChainError(message, opts)
    case 503:
      throw new RegisterServiceUnavailableError(message, opts)
    default:
      throw new RegisterError(message, opts)
  }
}

function extractMessage(body: unknown): string | undefined {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const v = (body as { error?: unknown }).error
    if (typeof v === 'string' && v.length > 0) return v
  }
  if (typeof body === 'string' && body.length > 0) return body
  return undefined
}
