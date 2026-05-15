/**
 * Tests for the http.* baseline tool family.
 *
 * Focused on the privacy property: a credential resolved from vault
 * lands in the outgoing request's headers but never appears in the
 * tool's return value (the response body and headers are redacted of
 * any literal substring match). Also covers happy-path GET, custom
 * header credential, missing-credential failure, and method/body
 * pass-through.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { httpTools } from '../../../../src/runtime/tools/baseline/http.js'
import { CredentialVault } from '../../../../src/runtime/credentials/vault.js'
import { agentPaths } from '../../../../src/runtime/storage/layout.js'
import type { ToolContext } from '../../../../src/runtime/mcp/tool.js'

let home: string
let originalFetch: typeof globalThis.fetch

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-http-'))
  originalFetch = globalThis.fetch
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  await rm(home, { recursive: true, force: true })
})

function findTool() {
  const tool = httpTools.find((t) => t.name === 'http_request')
  if (!tool) throw new Error('http_request missing from baseline')
  return tool
}

function ctx(): ToolContext {
  const ap = agentPaths(home, 'hobby')
  return {
    callingAgent: 'hobby',
    home,
    brainDir: ap.brain,
    projectDir: ap.project,
    taskId: 'task_test',
    callId: 'call_test',
  }
}

async function seedCredential(name: string, value: string): Promise<void> {
  const vault = new CredentialVault(home, 'hobby')
  await vault.set(name, {
    value,
    metadata: { created_at: new Date().toISOString(), provider: 'test' },
  })
}

/**
 * Capture the outgoing init options for the assertion-side and return
 * a synthetic Response with the supplied body + status.
 */
function stubFetch(
  bodyText: string,
  opts: { status?: number; headers?: Record<string, string> } = {},
): { capture: { url: string; init: RequestInit } } {
  const capture: { url: string; init: RequestInit } = { url: '', init: {} }
  globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
    capture.url = typeof url === 'string' ? url : url.toString()
    capture.init = init ?? {}
    const headers = new Headers(opts.headers ?? { 'content-type': 'application/json' })
    return Promise.resolve(new Response(bodyText, { status: opts.status ?? 200, headers }))
  }) as typeof globalThis.fetch
  return { capture }
}

describe('http_request — privacy property', () => {
  it('injects bearer credential into the outgoing Authorization header', async () => {
    await seedCredential('test-token', 'sk-secret-abc-123')
    const tool = findTool()
    const { capture } = stubFetch('{"ok":true}')
    const args = tool.argsSchema.parse({
      url: 'https://example.com/me',
      bearer_credential: 'test-token',
    })
    await tool.execute(args, ctx())
    const sentHeaders = capture.init.headers as Record<string, string>
    expect(sentHeaders['Authorization']).toBe('Bearer sk-secret-abc-123')
  })

  it('injects a custom-header credential when configured', async () => {
    await seedCredential('test-key', 'k_live_xyz')
    const tool = findTool()
    const { capture } = stubFetch('{"ok":true}')
    const args = tool.argsSchema.parse({
      url: 'https://example.com/me',
      credential_header: { header: 'X-API-Key', credential_name: 'test-key' },
    })
    await tool.execute(args, ctx())
    const sentHeaders = capture.init.headers as Record<string, string>
    expect(sentHeaders['X-API-Key']).toBe('k_live_xyz')
  })

  it('redacts the credential value from an echoed response body', async () => {
    await seedCredential('echo-token', 'super-secret-value')
    const tool = findTool()
    stubFetch(JSON.stringify({ authenticated: true, token: 'super-secret-value' }))
    const args = tool.argsSchema.parse({
      url: 'https://httpbin-clone.test/bearer',
      bearer_credential: 'echo-token',
    })
    const result = (await tool.execute(args, ctx())) as {
      body: string
      redacted: boolean
    }
    expect(result.body).not.toContain('super-secret-value')
    expect(result.body).toContain('<redacted>')
    expect(result.redacted).toBe(true)
  })

  it('redacts the credential value from response headers too', async () => {
    await seedCredential('header-echo', 'leaky-token-987')
    const tool = findTool()
    stubFetch('{}', {
      headers: {
        'content-type': 'application/json',
        'x-token-echo': 'leaky-token-987',
      },
    })
    const args = tool.argsSchema.parse({
      url: 'https://example.test/x',
      bearer_credential: 'header-echo',
    })
    const result = (await tool.execute(args, ctx())) as {
      headers: Record<string, string>
      redacted: boolean
    }
    expect(result.headers['x-token-echo']).toBe('<redacted>')
    expect(result.redacted).toBe(true)
  })

  it('redacted=false when the response does not contain the credential value', async () => {
    await seedCredential('quiet-token', 'a-secret-not-echoed')
    const tool = findTool()
    stubFetch('{"hello":"world"}')
    const args = tool.argsSchema.parse({
      url: 'https://example.test/x',
      bearer_credential: 'quiet-token',
    })
    const result = (await tool.execute(args, ctx())) as {
      body: string
      redacted: boolean
    }
    expect(result.body).toBe('{"hello":"world"}')
    expect(result.redacted).toBe(false)
  })

  it('the tool args object never carries the resolved credential value', async () => {
    // Validate via the parsed schema that the only credential-related
    // field is the *name*; the value isn't even an optional field.
    await seedCredential('shape-check', 'do-not-leak')
    const tool = findTool()
    const args = tool.argsSchema.parse({
      url: 'https://example.test/x',
      bearer_credential: 'shape-check',
    })
    const json = JSON.stringify(args)
    expect(json).toContain('shape-check')
    expect(json).not.toContain('do-not-leak')
  })
})

describe('http_request — happy paths', () => {
  it('passes method + body through unchanged', async () => {
    const tool = findTool()
    const { capture } = stubFetch('{"created":true}', { status: 201 })
    const args = tool.argsSchema.parse({
      url: 'https://example.test/things',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"foo"}',
    })
    const result = (await tool.execute(args, ctx())) as { status: number }
    expect(capture.init.method).toBe('POST')
    expect(capture.init.body).toBe('{"name":"foo"}')
    expect(result.status).toBe(201)
  })

  it('caller-supplied Authorization header overrides bearer_credential', async () => {
    // Caller-supplied headers merge AFTER credential-injected ones, so
    // a callsite that knowingly wants to set its own Auth header can
    // do so. The credential value is still resolved (and so still
    // redacted from the response), but the outgoing header reflects
    // the override.
    await seedCredential('override-cred', 'should-not-go-out')
    const tool = findTool()
    const { capture } = stubFetch('{}')
    const args = tool.argsSchema.parse({
      url: 'https://example.test/x',
      bearer_credential: 'override-cred',
      headers: { Authorization: 'Bearer explicit-override' },
    })
    await tool.execute(args, ctx())
    const sent = capture.init.headers as Record<string, string>
    expect(sent['Authorization']).toBe('Bearer explicit-override')
  })

  it('truncates oversized response bodies at max_bytes', async () => {
    const tool = findTool()
    const big = 'a'.repeat(5000)
    stubFetch(big)
    const args = tool.argsSchema.parse({
      url: 'https://example.test/big',
      max_bytes: 1000,
    })
    const result = (await tool.execute(args, ctx())) as {
      body: string
      truncated: boolean
      bytes: number
    }
    expect(result.truncated).toBe(true)
    expect(result.bytes).toBe(1000)
    expect(result.body.length).toBeLessThanOrEqual(1000)
  })
})

describe('http_request — error paths', () => {
  it('throws a friendly error when bearer_credential is not in vault', async () => {
    const tool = findTool()
    stubFetch('{}')
    const args = tool.argsSchema.parse({
      url: 'https://example.test/x',
      bearer_credential: 'missing-token',
    })
    await expect(tool.execute(args, ctx())).rejects.toThrow(/not in vault/)
  })

  it('throws when credential_header.credential_name is not in vault', async () => {
    const tool = findTool()
    stubFetch('{}')
    const args = tool.argsSchema.parse({
      url: 'https://example.test/x',
      credential_header: { header: 'X-API-Key', credential_name: 'absent' },
    })
    await expect(tool.execute(args, ctx())).rejects.toThrow(/not in vault/)
  })

  it('does NOT make a request when credential resolution fails', async () => {
    const tool = findTool()
    let called = false
    globalThis.fetch = () => {
      called = true
      return Promise.resolve(new Response('{}'))
    }
    const args = tool.argsSchema.parse({
      url: 'https://example.test/x',
      bearer_credential: 'missing',
    })
    await expect(tool.execute(args, ctx())).rejects.toThrow()
    expect(called).toBe(false)
  })
})
