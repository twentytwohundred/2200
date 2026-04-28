/**
 * Tests for the register.openscut.ai HTTPS client (Epic 4 Phase A v0.4).
 *
 * Spins a real http.Server fake of Garfield's v0.1.0 register
 * service and exercises every endpoint plus every documented error
 * status code. Validates request shape, response parsing, and the
 * typed-error mapping (RegisterRateLimitError / RegisterOnChainError /
 * RegisterServiceUnavailableError / etc.).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  createRegisterClient,
  RegisterAuthError,
  RegisterConflictError,
  RegisterError,
  RegisterNotFoundError,
  RegisterOnChainError,
  RegisterRateLimitError,
  RegisterRequestError,
  RegisterServiceUnavailableError,
  type HealthResponse,
  type RegisterRequest,
  type RegisterResponse,
} from '../../../src/runtime/identity/register-client.js'

interface ServerStub {
  status?: number
  body?: unknown
  /** Called with the parsed request body for assertions. */
  onRequest?: (req: { method: string; url: string; body: unknown }) => void
}

let server: Server | undefined
let baseUrl: string
let stub: { register?: ServerStub; update?: ServerStub; transfer?: ServerStub; health?: ServerStub }

beforeEach(async () => {
  stub = {}
  await new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += String(chunk)
      })
      req.on('end', () => {
        const path = req.url ?? ''
        let parsed: unknown = null
        if (body.length > 0) {
          try {
            parsed = JSON.parse(body) as unknown
          } catch {
            parsed = body
          }
        }
        let s: ServerStub | undefined
        let defaultStatus = 200
        if (path === '/scut/v1/register') {
          s = stub.register
          defaultStatus = 201
        } else if (path === '/scut/v1/update') {
          s = stub.update
          defaultStatus = 200
        } else if (path === '/scut/v1/transfer') {
          s = stub.transfer
          defaultStatus = 200
        } else if (path === '/scut/v1/health') {
          s = stub.health
          defaultStatus = 200
        }
        if (!s) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'not found' }))
          return
        }
        s.onRequest?.({ method: req.method ?? 'GET', url: path, body: parsed })
        const status = s.status ?? defaultStatus
        const responseBody = s.body !== undefined ? JSON.stringify(s.body) : ''
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(responseBody)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address() as AddressInfo
      baseUrl = `http://127.0.0.1:${String(addr.port)}`
      resolve()
    })
  })
})

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => {
      server!.close(() => {
        resolve()
      })
    })
    server = undefined
  }
})

const sampleResponse: RegisterResponse = {
  ref: 'scut://8453/0x199b48e27a28881502b251b0068f388ce750feff/12345',
  agentRef: {
    chainId: 8453,
    contract: '0x199b48e27a28881502b251b0068f388ce750feff',
    tokenId: '12345',
  },
  txHashes: { mint: '0x' + 'a'.repeat(64), update: '0x' + 'b'.repeat(64) },
  basescan: { mint: 'https://basescan.org/tx/0xaaa', update: 'https://basescan.org/tx/0xbbb' },
  document: {
    siiVersion: 1,
    agentRef: {
      chainId: 8453,
      contract: '0x199b48e27a28881502b251b0068f388ce750feff',
      tokenId: '12345',
    },
    publicKeys: { ed25519: 'pub-ed', x25519: 'pub-x' },
    relays: [],
    capabilities: { protocolVersion: '0.2.0' },
  },
}

const sampleHealth: HealthResponse = {
  status: 'ok',
  wallet: { address: '0xabc', balanceWei: '70000000000000000', balanceEth: '0.07' },
  runway: { registrationsAtConservativeGas: 2221, gasPerRegistrationEstimate: '630000' },
  registrationsCount: 0,
  version: '0.1.0',
}

describe('createRegisterClient.register', () => {
  it('posts the right body and parses a 201 response', async () => {
    let captured: { method: string; url: string; body: unknown } | null = null
    stub.register = {
      status: 201,
      body: sampleResponse,
      onRequest: (r) => {
        captured = r
      },
    }
    const client = createRegisterClient({ baseUrl })
    const req: RegisterRequest = {
      keys: {
        signing: { algorithm: 'ed25519', publicKey: 'pub-ed' },
        encryption: { algorithm: 'x25519', publicKey: 'pub-x' },
      },
      displayName: 'hobby',
    }
    const r = await client.register(req)
    expect(r.ref).toBe(sampleResponse.ref)
    expect(r.agentRef.tokenId).toBe('12345')
    expect(captured).not.toBeNull()
    expect(captured!.method).toBe('POST')
    const body = captured!.body as RegisterRequest
    expect(body.keys.signing.publicKey).toBe('pub-ed')
    expect(body.displayName).toBe('hobby')
  })

  it('throws RegisterRateLimitError on 429', async () => {
    stub.register = {
      status: 429,
      body: { error: 'display name already used today', displayName: 'hobby' },
    }
    const client = createRegisterClient({ baseUrl })
    await expect(
      client.register({
        keys: {
          signing: { algorithm: 'ed25519', publicKey: 'p' },
          encryption: { algorithm: 'x25519', publicKey: 'p' },
        },
      }),
    ).rejects.toBeInstanceOf(RegisterRateLimitError)
  })

  it('throws RegisterRequestError on 400', async () => {
    stub.register = {
      status: 400,
      body: { error: 'invalid request body', details: { fieldErrors: { keys: ['required'] } } },
    }
    const client = createRegisterClient({ baseUrl })
    await expect(
      client.register({
        keys: {
          signing: { algorithm: 'ed25519', publicKey: '' },
          encryption: { algorithm: 'x25519', publicKey: '' },
        },
      }),
    ).rejects.toBeInstanceOf(RegisterRequestError)
  })

  it('throws RegisterOnChainError on 502', async () => {
    stub.register = {
      status: 502,
      body: { error: 'on-chain mint failed', detail: 'rpc timeout' },
    }
    const client = createRegisterClient({ baseUrl })
    await expect(
      client.register({
        keys: {
          signing: { algorithm: 'ed25519', publicKey: 'p' },
          encryption: { algorithm: 'x25519', publicKey: 'p' },
        },
      }),
    ).rejects.toBeInstanceOf(RegisterOnChainError)
  })

  it('throws RegisterServiceUnavailableError on 503', async () => {
    stub.register = {
      status: 503,
      body: { error: 'global daily registration cap reached, try tomorrow' },
    }
    const client = createRegisterClient({ baseUrl })
    await expect(
      client.register({
        keys: {
          signing: { algorithm: 'ed25519', publicKey: 'p' },
          encryption: { algorithm: 'x25519', publicKey: 'p' },
        },
      }),
    ).rejects.toBeInstanceOf(RegisterServiceUnavailableError)
  })
})

describe('createRegisterClient.update', () => {
  it('posts and parses a successful update', async () => {
    stub.update = {
      status: 200,
      body: { tokenId: '12345', txHash: '0xff', basescan: 'https://...' },
    }
    const client = createRegisterClient({ baseUrl })
    const r = await client.update({
      tokenId: '12345',
      newSiiDoc: sampleResponse.document,
      signature: 'b64sig',
    })
    expect(r.tokenId).toBe('12345')
  })

  it('throws RegisterAuthError on 401', async () => {
    stub.update = {
      status: 401,
      body: { error: 'signature does not match registered ed25519 key' },
    }
    const client = createRegisterClient({ baseUrl })
    await expect(
      client.update({ tokenId: '12345', newSiiDoc: sampleResponse.document, signature: 'bad' }),
    ).rejects.toBeInstanceOf(RegisterAuthError)
  })

  it('throws RegisterNotFoundError on 404', async () => {
    stub.update = { status: 404, body: { error: 'token not registered with this service' } }
    const client = createRegisterClient({ baseUrl })
    await expect(
      client.update({ tokenId: '99', newSiiDoc: sampleResponse.document, signature: 'sig' }),
    ).rejects.toBeInstanceOf(RegisterNotFoundError)
  })

  it('throws RegisterConflictError on 409', async () => {
    stub.update = {
      status: 409,
      body: { error: 'token has been transferred to user custody' },
    }
    const client = createRegisterClient({ baseUrl })
    await expect(
      client.update({ tokenId: '12345', newSiiDoc: sampleResponse.document, signature: 'sig' }),
    ).rejects.toBeInstanceOf(RegisterConflictError)
  })
})

describe('createRegisterClient.transfer', () => {
  it('parses a successful transfer', async () => {
    stub.transfer = {
      status: 200,
      body: {
        tokenId: '12345',
        newOwner: '0xabc...',
        txHash: '0xdd',
        basescan: 'https://...',
      },
    }
    const client = createRegisterClient({ baseUrl })
    const r = await client.transfer({
      tokenId: '12345',
      newOwner: '0xabc',
      signature: 'sig',
    })
    expect(r.tokenId).toBe('12345')
    expect(r.newOwner).toMatch(/^0x/)
  })
})

describe('createRegisterClient.health', () => {
  it('returns the health envelope', async () => {
    stub.health = { status: 200, body: sampleHealth }
    const client = createRegisterClient({ baseUrl })
    const r = await client.health()
    expect(r.status).toBe('ok')
    expect(r.version).toBe('0.1.0')
    expect(r.runway.registrationsAtConservativeGas).toBe(2221)
  })

  it('treats 503 degraded as a service-unavailable error', async () => {
    stub.health = {
      status: 503,
      body: { status: 'degraded', error: 'rpc unreachable', detail: 'ECONNREFUSED' },
    }
    const client = createRegisterClient({ baseUrl })
    await expect(client.health()).rejects.toBeInstanceOf(RegisterServiceUnavailableError)
  })
})

describe('createRegisterClient network failures', () => {
  it('wraps a connection refused as RegisterError', async () => {
    // Close the server before calling.
    await new Promise<void>((resolve) => {
      server!.close(() => {
        resolve()
      })
    })
    server = undefined
    const client = createRegisterClient({ baseUrl })
    await expect(client.health()).rejects.toBeInstanceOf(RegisterError)
  })
})
