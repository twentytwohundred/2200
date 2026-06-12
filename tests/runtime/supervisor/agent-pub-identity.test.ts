/**
 * Tests for the Agent pub identity provisioning extension to
 * `Supervisor.createAgent` (Epic 3 PR B follow-up).
 *
 * Three behaviors:
 *   1. Source Identity has NO `pub:` block — non-pub Agent. createAgent is
 *      a no-op on the pub side. Canonical identity.md unchanged from source.
 *   2. Source Identity HAS `pub:` block but no pub is running — defer:
 *      keypair minted + persisted, identity.md patched with empty
 *      `pub.identity` and `local://unregistered` issuer.
 *   3. Source Identity HAS `pub:` block and a pub is running — register
 *      end-to-end: keypair persisted, agent_id assigned, canonical
 *      identity.md patched with the registered fields.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { Supervisor } from '../../../src/runtime/supervisor/supervisor.js'
import { JsonRpcClient } from '../../../src/runtime/control-plane/client.js'
import { connectUds } from '../../../src/runtime/control-plane/uds-client.js'
import { agentPaths } from '../../../src/runtime/storage/layout.js'
import { loadIdentity } from '../../../src/runtime/identity/loader.js'
import { readCredentialFile } from '../../../src/runtime/pub/keypair.js'

let home: string
let supervisor: Supervisor | undefined
let client: JsonRpcClient | undefined
let pubServer: Server | undefined

async function startFakePub(): Promise<{ port: number }> {
  pubServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void readBody(req).then((body) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      if (req.method === 'GET' && url.pathname === '/agents/me') {
        res.writeHead(404).end()
        return
      }
      if (req.method === 'POST' && url.pathname === '/admin/register-agent') {
        const parsed = JSON.parse(body) as { display_name: string }
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            agent_id: randomUUID(),
            display_name: parsed.display_name,
          }),
        )
        return
      }
      res.writeHead(404).end()
    })
  })
  await new Promise<void>((resolve) => {
    pubServer!.listen(0, '127.0.0.1', () => {
      resolve()
    })
  })
  const addr = pubServer.address()
  if (addr === null || typeof addr === 'string') throw new Error('no address')
  return { port: addr.port }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  return new Promise((resolve, reject) => {
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

async function writeIdentitySource(name: string, withPubBlock: boolean): Promise<string> {
  const path = join(home, `${name}.identity.md`)
  const pubBlock = withPubBlock
    ? `pub:
  identity: ""
  display_name: ${name}
  handle: "@${name}"
  credentials:
    source: file
    id: /placeholder/will-be-overwritten
  key_version: 1
  issuer_url: ""
  domains: []
  member_of: []
`
    : ''
  const content = `---
schema_version: 1
agent_name: ${name}
agent_role: "test agent"
model:
  tier: frontier
  provider: anthropic
  model_id: claude-opus-4-7
tools: []
project_dir: /tmp/${name}/project
brain_dir: /tmp/${name}/brain
created: 2026-04-26
${pubBlock}---

# Identity
Test agent.
`
  await writeFile(path, content, 'utf8')
  return path
}

async function writeSleepBinary(): Promise<string> {
  const path = join(home, 'sleep.cjs')
  const script = `#!/usr/bin/env node
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1_000_000)
`
  await writeFile(path, script)
  await chmod(path, 0o755)
  return path
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-agent-pub-id-'))
})

afterEach(async () => {
  if (client) {
    try {
      await client.close()
    } catch {
      // ignore
    }
    client = undefined
  }
  if (supervisor) {
    await supervisor.shutdown()
    supervisor = undefined
  }
  if (pubServer) {
    await new Promise<void>((resolve) =>
      pubServer!.close(() => {
        resolve()
      }),
    )
    pubServer = undefined
  }
  // createUserIdentity (setup) regenerates the shared-brain index
  // asynchronously; a write landing mid-recursive-delete yields
  // ENOTEMPTY (hit once on CI 2026-06-12). Retry absorbs it.
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

async function setup(): Promise<void> {
  supervisor = await Supervisor.create({ home })
  await supervisor.start()
  // Pub creation derives its owner from the user identity (fail-fast
  // when absent), so the harness mints one the way first-run does.
  await supervisor.createUserIdentity({ display_name: 'Alice' })
  const conn = await connectUds(Supervisor.socketPath(home))
  client = new JsonRpcClient(conn)
}

describe('createAgent — no pub block in source Identity', () => {
  it('synthesizes a default pub block, mints a keypair, and patches the canonical identity.md', async () => {
    // Per Doug's "every Agent at all times in the Studio" rule, a
    // source Identity that does not declare a pub: block now gets
    // a synthesized default pub block (display_name + handle from
    // agent_name; credentials.id at the canonical pub.secret path).
    // The supervisor mints a keypair as if the operator had hand-
    // authored a pub block. With no pub running on this test, the
    // mint goes through the deferred-registration path: identity is
    // empty, issuer_url is local://unregistered, credentials.id is
    // canonicalized.
    await setup()
    const src = await writeIdentitySource('hobby', false)
    await client!.call('cli.agent.create', { name: 'hobby', identity_path: src })

    const credPath = agentPaths(home, 'hobby').pubSecret
    const cred = await readCredentialFile(credPath)
    expect(cred.display_name).toBe('hobby')
    expect(cred.agent_id).toBeNull()
    expect(cred.issuer_url).toBe('local://unregistered')

    const canonical = agentPaths(home, 'hobby').identity
    const ident = await loadIdentity(canonical)
    expect(ident.frontmatter.pub).toBeDefined()
    expect(ident.frontmatter.pub?.display_name).toBe('hobby')
    expect(ident.frontmatter.pub?.handle).toBe('@hobby')
    expect(ident.frontmatter.pub?.identity).toBe('')
    expect(ident.frontmatter.pub?.issuer_url).toBe('local://unregistered')
    expect(ident.frontmatter.pub?.credentials.id).toBe(credPath)
  })
})

describe('createAgent — pub block, no pub running (deferred registration)', () => {
  it('mints keypair, persists credential file at mode 0600, writes empty identity', async () => {
    await setup()
    const src = await writeIdentitySource('poe', true)
    await client!.call('cli.agent.create', { name: 'poe', identity_path: src })

    const credPath = agentPaths(home, 'poe').pubSecret
    const cred = await readCredentialFile(credPath)
    expect(cred.display_name).toBe('poe')
    expect(cred.agent_id).toBeNull()
    expect(cred.issuer_url).toBe('local://unregistered')
    if (process.platform !== 'win32') {
      const s = await stat(credPath)
      expect(s.mode & 0o777).toBe(0o600)
    }

    // Canonical identity.md has empty pub.identity but the credentials path
    // is canonicalized to <home>/agents/poe/pub.secret (not the placeholder).
    const ident = await loadIdentity(agentPaths(home, 'poe').identity)
    expect(ident.frontmatter.pub?.identity).toBe('')
    expect(ident.frontmatter.pub?.issuer_url).toBe('local://unregistered')
    expect(ident.frontmatter.pub?.credentials.id).toBe(credPath)
  })

  it('preserves source Identity body and other frontmatter fields', async () => {
    await setup()
    const src = await writeIdentitySource('poe', true)
    await client!.call('cli.agent.create', { name: 'poe', identity_path: src })

    const ident = await loadIdentity(agentPaths(home, 'poe').identity)
    expect(ident.frontmatter.agent_name).toBe('poe')
    expect(ident.frontmatter.agent_role).toBe('test agent')
    expect(ident.frontmatter.model.model_id).toBe('claude-opus-4-7')
    expect(ident.body).toContain('Test agent.')
  })
})

describe('createAgent — pub block, pub running (full registration)', () => {
  it('registers the keypair against the running pub and patches identity.md', async () => {
    await setup()
    const fake = await startFakePub()
    await client!.call('cli.pub.create', { name: 'ops', port: fake.port })
    const sleeperBin = await writeSleepBinary()
    await supervisor!.startPub('ops', { executablePath: sleeperBin })

    const src = await writeIdentitySource('poe', true)
    await client!.call('cli.agent.create', { name: 'poe', identity_path: src })

    // Credential file has agent_id assigned.
    const credPath = agentPaths(home, 'poe').pubSecret
    const cred = await readCredentialFile(credPath)
    expect(cred.agent_id).not.toBeNull()
    expect(cred.agent_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(cred.issuer_url).toBe(`local://127.0.0.1:${String(fake.port)}`)

    // Canonical identity.md has pub.identity filled in.
    const ident = await loadIdentity(agentPaths(home, 'poe').identity)
    expect(ident.frontmatter.pub?.identity).toBe(cred.agent_id)
    expect(ident.frontmatter.pub?.issuer_url).toBe(cred.issuer_url)
    expect(ident.frontmatter.pub?.credentials.id).toBe(credPath)
  })
})

describe('createAgent — multiple pubs without --pub picks a sensible default', () => {
  it('prefers `studio` (canonical team room) when present', async () => {
    await setup()
    await client!.call('cli.pub.create', { name: 'ops' })
    await client!.call('cli.pub.create', { name: 'studio' })
    await client!.call('cli.pub.create', { name: 'family' })
    const src = await writeIdentitySource('poe', true)
    await client!.call('cli.agent.create', { name: 'poe', identity_path: src })
    const credPath = agentPaths(home, 'poe').pubSecret
    const cred = await readCredentialFile(credPath)
    // Studio's pub URL identifies the chosen target. The actual port
    // varies per test; we just confirm the cred file landed (not the
    // "deferred without target" zero-pub path).
    expect(cred.issuer_url).toMatch(/^local:\/\/127\.0\.0\.1:/)
  })

  it('falls back to alphabetically-first pub when no `studio` exists', async () => {
    await setup()
    await client!.call('cli.pub.create', { name: 'ops' })
    await client!.call('cli.pub.create', { name: 'family' })
    const src = await writeIdentitySource('poe', true)
    // Should not throw: `family` (alphabetically first) is picked.
    await client!.call('cli.agent.create', { name: 'poe', identity_path: src })
    const credPath = agentPaths(home, 'poe').pubSecret
    const cred = await readCredentialFile(credPath)
    expect(cred.issuer_url).toMatch(/^local:\/\/127\.0\.0\.1:/)
  })

  it('respects --pub when multiple pubs exist (deferred registration since no pub running)', async () => {
    await setup()
    await client!.call('cli.pub.create', { name: 'ops' })
    await client!.call('cli.pub.create', { name: 'family' })
    const src = await writeIdentitySource('poe', true)
    await client!.call('cli.agent.create', { name: 'poe', identity_path: src, pub: 'ops' })
    const credPath = agentPaths(home, 'poe').pubSecret
    const cred = await readCredentialFile(credPath)
    // Issuer URL points at the picked pub's port (even though not running, deferred).
    expect(cred.issuer_url).toMatch(/^local:\/\/127\.0\.0\.1:/)
  })

  it('--pub <name> on an unknown pub errors clearly', async () => {
    await setup()
    await client!.call('cli.pub.create', { name: 'ops' })
    const src = await writeIdentitySource('poe', true)
    await expect(
      client!.call('cli.agent.create', { name: 'poe', identity_path: src, pub: 'no-such-pub' }),
    ).rejects.toThrow(/no pub record for/)
  })
})

describe('readFile sanity', () => {
  it('canonical identity.md is valid YAML with the patched pub block', async () => {
    await setup()
    const src = await writeIdentitySource('poe', true)
    await client!.call('cli.agent.create', { name: 'poe', identity_path: src })
    const raw = await readFile(agentPaths(home, 'poe').identity, 'utf8')
    expect(raw.startsWith('---\n')).toBe(true)
    expect(raw).toContain('pub:')
    expect(raw).toContain(`id: ${agentPaths(home, 'poe').pubSecret}`)
  })
})
