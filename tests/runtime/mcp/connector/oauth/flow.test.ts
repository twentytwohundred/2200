/**
 * End-to-end OAuth flow against the real connector listener.
 *
 * Exercises the full chain locked in the Phase 2 PR-A design:
 *   1. operator registers a client at the trusted (loopback) surface
 *   2. client hits /authorize with PKCE → 302 redirect with code
 *   3. client hits /token with the code + verifier → access + refresh tokens
 *   4. client uses the access token at /mcp (coexistence with static bearer)
 *   5. client refreshes → new tokens; old refresh marked rotated
 *   6. refresh-token reuse triggers chain revocation
 *   7. revoke client → all tokens invalidated; /mcp rejects
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { ConnectorAuditEmitter } from '../../../../../src/runtime/mcp/connector/audit.js'
import {
  mintBearerToken,
  saveBearer,
} from '../../../../../src/runtime/mcp/connector/bearer-store.js'
import {
  startConnectorListener,
  type ConnectorListenerHandle,
} from '../../../../../src/runtime/mcp/connector/listener.js'
import { registerClient } from '../../../../../src/runtime/mcp/connector/oauth/client-store.js'
import { computePkceChallenge } from '../../../../../src/runtime/mcp/connector/oauth/pkce.js'
import {
  readRefreshToken,
  revokeClientTokens,
} from '../../../../../src/runtime/mcp/connector/oauth/token-store.js'

let home: string
let handle: ConnectorListenerHandle | null = null
let staticBearer: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-oauth-flow-'))
  staticBearer = mintBearerToken()
  await saveBearer(home, { token: staticBearer, createdAt: new Date().toISOString() })
})

afterEach(async () => {
  if (handle !== null) {
    await handle.close('test cleanup').catch(() => undefined)
    handle = null
  }
  await new Promise((r) => setTimeout(r, 20))
  await rm(home, { recursive: true, force: true })
})

function stubDeps(): {
  snapshot: () => {
    schema_version: 1
    home: string
    state_dir: string
    agents: Record<string, never>
    pubs: Record<string, never>
  }
  knownAgents: () => Promise<Set<string>>
  resolveThreadPrimaryAgent: (slug: string) => Promise<string | null>
  proposeWorkPackage: () => Promise<{
    packageId: string
    packageSlug: string
    coordinationTaskId: string
  }>
} {
  return {
    snapshot: () => ({
      schema_version: 1 as const,
      home,
      state_dir: home + '/state',
      agents: {},
      pubs: {},
    }),
    knownAgents: () => Promise.resolve(new Set()),
    resolveThreadPrimaryAgent: () => Promise.resolve(null),
    proposeWorkPackage: () =>
      Promise.resolve({
        packageId: 'pkg_stub',
        packageSlug: 'work-package-pkg_stub',
        coordinationTaskId: 'task_stub',
      }),
  }
}

function makeVerifier(): { verifier: string; challenge: string } {
  // 64 base64url chars = above the 43-char minimum.
  const verifier = randomBytes(48).toString('base64url').slice(0, 64)
  return { verifier, challenge: computePkceChallenge(verifier) }
}

async function startListener(): Promise<string> {
  const audit = new ConnectorAuditEmitter({ home })
  handle = await startConnectorListener({
    home,
    port: 0,
    host: '127.0.0.1',
    audit,
    serverDeps: stubDeps(),
  })
  return `http://127.0.0.1:${String(handle.port)}`
}

describe('end-to-end OAuth flow', () => {
  it('completes the authorization-code grant with PKCE', async () => {
    const baseUrl = await startListener()
    const reg = await registerClient({
      home,
      displayName: 'Grok (test)',
      redirectUris: ['https://grok.example/cb'],
    })
    const { verifier, challenge } = makeVerifier()

    // /authorize → 302 with code.
    const authorize = await fetch(
      `${baseUrl}/oauth/authorize?response_type=code&client_id=${reg.clientId}` +
        `&redirect_uri=${encodeURIComponent('https://grok.example/cb')}` +
        `&code_challenge=${challenge}&code_challenge_method=S256&scope=connector%3Afull&state=opaque`,
      { redirect: 'manual' },
    )
    expect(authorize.status).toBe(302)
    const location = authorize.headers.get('location')
    expect(location).not.toBeNull()
    const redirectUrl = new URL(location!)
    expect(redirectUrl.origin + redirectUrl.pathname).toBe('https://grok.example/cb')
    expect(redirectUrl.searchParams.get('state')).toBe('opaque')
    const code = redirectUrl.searchParams.get('code')
    expect(code).not.toBeNull()

    // /token → access + refresh tokens.
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code!,
      client_id: reg.clientId,
      redirect_uri: 'https://grok.example/cb',
      code_verifier: verifier,
    })
    const tokenResp = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString(),
    })
    expect(tokenResp.status).toBe(200)
    const tokenJson = (await tokenResp.json()) as {
      access_token: string
      refresh_token: string
      token_type: string
      expires_in: number
      scope: string
    }
    expect(tokenJson.token_type).toBe('Bearer')
    expect(tokenJson.access_token).toMatch(/^2200-mcp-at-/)
    expect(tokenJson.refresh_token).toMatch(/^2200-mcp-rt-/)
    expect(tokenJson.expires_in).toBeGreaterThan(0)
    expect(tokenJson.scope).toBe('connector:full')

    // Access token works at /mcp.
    const mcpResp = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenJson.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    // The body is whatever the MCP SDK responds with; the load-bearing
    // assertion is that the auth gate accepted the OAuth token (not 401).
    expect(mcpResp.status).not.toBe(401)
  })

  it('rejects an /authorize with a redirect_uri not on the registered list', async () => {
    const baseUrl = await startListener()
    const reg = await registerClient({
      home,
      displayName: 'Grok',
      redirectUris: ['https://grok.example/cb'],
    })
    const { challenge } = makeVerifier()
    const resp = await fetch(
      `${baseUrl}/oauth/authorize?response_type=code&client_id=${reg.clientId}` +
        `&redirect_uri=${encodeURIComponent('https://evil.example/cb')}` +
        `&code_challenge=${challenge}&code_challenge_method=S256`,
      { redirect: 'manual' },
    )
    expect(resp.status).toBe(400)
    const body = (await resp.json()) as { error: string }
    expect(body.error).toBe('invalid_request')
  })

  it('rejects /token with a wrong PKCE verifier', async () => {
    const baseUrl = await startListener()
    const reg = await registerClient({
      home,
      displayName: 'Grok',
      redirectUris: ['https://grok.example/cb'],
    })
    const { challenge } = makeVerifier()
    const authorize = await fetch(
      `${baseUrl}/oauth/authorize?response_type=code&client_id=${reg.clientId}` +
        `&redirect_uri=${encodeURIComponent('https://grok.example/cb')}` +
        `&code_challenge=${challenge}&code_challenge_method=S256`,
      { redirect: 'manual' },
    )
    const code = new URL(authorize.headers.get('location')!).searchParams.get('code')!

    const wrongVerifier = randomBytes(48).toString('base64url').slice(0, 64)
    const tokenResp = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: reg.clientId,
        redirect_uri: 'https://grok.example/cb',
        code_verifier: wrongVerifier,
      }).toString(),
    })
    expect(tokenResp.status).toBe(400)
    const body = (await tokenResp.json()) as { error: string }
    expect(body.error).toBe('invalid_grant')
  })

  it('refresh_token rotation: old refresh is marked rotated; reuse revokes the chain', async () => {
    const baseUrl = await startListener()
    const reg = await registerClient({
      home,
      displayName: 'Grok',
      redirectUris: ['https://grok.example/cb'],
    })
    const { verifier, challenge } = makeVerifier()
    const authorize = await fetch(
      `${baseUrl}/oauth/authorize?response_type=code&client_id=${reg.clientId}` +
        `&redirect_uri=${encodeURIComponent('https://grok.example/cb')}` +
        `&code_challenge=${challenge}&code_challenge_method=S256`,
      { redirect: 'manual' },
    )
    const code = new URL(authorize.headers.get('location')!).searchParams.get('code')!
    const firstToken = (await (
      await fetch(`${baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: reg.clientId,
          redirect_uri: 'https://grok.example/cb',
          code_verifier: verifier,
        }).toString(),
      })
    ).json()) as { refresh_token: string }

    // Refresh once: old refresh marked rotated; new refresh shares chain.
    const refreshOnce = (await (
      await fetch(`${baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: firstToken.refresh_token,
          client_id: reg.clientId,
        }).toString(),
      })
    ).json()) as { refresh_token: string; access_token: string }
    expect(refreshOnce.refresh_token).not.toBe(firstToken.refresh_token)

    // Old refresh is now marked rotated.
    const oldRecord = await readRefreshToken(home, firstToken.refresh_token)
    expect(oldRecord?.rotated).toBe(true)

    // Reuse the old refresh → chain revoked.
    const reuse = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: firstToken.refresh_token,
        client_id: reg.clientId,
      }).toString(),
    })
    expect(reuse.status).toBe(400)
    const reuseBody = (await reuse.json()) as { error: string }
    expect(reuseBody.error).toBe('invalid_grant')

    // The successor refresh from the rotation is now also gone (chain revocation).
    expect(await readRefreshToken(home, refreshOnce.refresh_token)).toBeNull()
  })

  it('static bearer (PR 1a) still works alongside OAuth (PR-A1 coexistence)', async () => {
    const baseUrl = await startListener()
    const resp = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${staticBearer}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(resp.status).not.toBe(401)
  })

  it('revokeClientTokens kills active access tokens at /mcp', async () => {
    const baseUrl = await startListener()
    const reg = await registerClient({
      home,
      displayName: 'Grok',
      redirectUris: ['https://grok.example/cb'],
    })
    const { verifier, challenge } = makeVerifier()
    const authorize = await fetch(
      `${baseUrl}/oauth/authorize?response_type=code&client_id=${reg.clientId}` +
        `&redirect_uri=${encodeURIComponent('https://grok.example/cb')}` +
        `&code_challenge=${challenge}&code_challenge_method=S256`,
      { redirect: 'manual' },
    )
    const code = new URL(authorize.headers.get('location')!).searchParams.get('code')!
    const tokens = (await (
      await fetch(`${baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: reg.clientId,
          redirect_uri: 'https://grok.example/cb',
          code_verifier: verifier,
        }).toString(),
      })
    ).json()) as { access_token: string }

    await revokeClientTokens(home, reg.clientId)

    const after = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(after.status).toBe(401)
  })

  it('publishes /.well-known/oauth-authorization-server metadata', async () => {
    const baseUrl = await startListener()
    const resp = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)
    expect(resp.status).toBe(200)
    const meta = (await resp.json()) as {
      issuer: string
      authorization_endpoint: string
      token_endpoint: string
      response_types_supported: string[]
      grant_types_supported: string[]
      code_challenge_methods_supported: string[]
      scopes_supported: string[]
    }
    expect(meta.issuer).toMatch(/^https?:\/\//)
    expect(meta.authorization_endpoint).toContain('/oauth/authorize')
    expect(meta.token_endpoint).toContain('/oauth/token')
    expect(meta.response_types_supported).toEqual(['code'])
    expect(meta.grant_types_supported).toEqual(['authorization_code', 'refresh_token'])
    expect(meta.code_challenge_methods_supported).toEqual(['S256'])
    expect(meta.scopes_supported).toEqual(['connector:full'])
  })
})
