import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendMcpServerToIdentity,
  credentialNameFor,
  IdentityMutationError,
  removeMcpServerFromIdentity,
  storeServerSecrets,
} from '../../../src/runtime/skills/identity-write.js'
import { CredentialVault } from '../../../src/runtime/credentials/vault.js'
import { loadIdentity } from '../../../src/runtime/identity/loader.js'
import type { McpServerSpec } from '../../../src/runtime/identity/types.js'

let home: string

const VALID_IDENTITY = `---
schema_version: 5
agent_name: hobby
agent_role: "primary build agent for 2200"
model:
  tier: frontier
  provider: anthropic
  model_id: claude-opus-4-7
tools: []
project_dir: /var/lib/2200/agents/hobby/project
brain_dir: /var/lib/2200/agents/hobby/brain
created: 2026-04-26
---

# Identity

Body text.
`

async function setupAgent(name: string): Promise<string> {
  const root = join(home, 'agents', name)
  await mkdir(root, { recursive: true })
  const identityPath = join(root, 'identity.md')
  const content = VALID_IDENTITY.replace(/agent_name: hobby/, `agent_name: ${name}`)
    .replace(/agents\/hobby\/project/g, `agents/${name}/project`)
    .replace(/agents\/hobby\/brain/g, `agents/${name}/brain`)
  await writeFile(identityPath, content, 'utf8')
  return identityPath
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-skill-id-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('credentialNameFor', () => {
  it('lowercases and replaces underscores with dashes', () => {
    expect(credentialNameFor('openpub', 'OPENPUB_AGENT_TOKEN')).toBe('openpub--openpub-agent-token')
  })

  it('collapses repeated dashes', () => {
    expect(credentialNameFor('foo', 'BAR__BAZ')).toBe('foo--bar-baz')
  })

  it('throws on a credential name that would have unsafe characters', () => {
    expect(() => credentialNameFor('', '')).toThrow(IdentityMutationError)
  })
})

describe('storeServerSecrets', () => {
  it('writes per-Agent vault entries and returns SecretRefs', async () => {
    await setupAgent('hobby')
    const refs = await storeServerSecrets({
      home,
      agentName: 'hobby',
      skillSlug: 'openpub',
      env: {
        OPENPUB_AGENT_TOKEN: 'secret-token-a',
        OPENPUB_REFRESH_TOKEN: 'secret-token-b',
      },
    })
    expect(refs).toEqual({
      OPENPUB_AGENT_TOKEN: { source: 'vault', id: 'openpub--openpub-agent-token' },
      OPENPUB_REFRESH_TOKEN: { source: 'vault', id: 'openpub--openpub-refresh-token' },
    })
    const vault = new CredentialVault(home, 'hobby')
    expect((await vault.get('openpub--openpub-agent-token')).value).toBe('secret-token-a')
    expect((await vault.get('openpub--openpub-refresh-token')).value).toBe('secret-token-b')
  })
})

describe('appendMcpServerToIdentity', () => {
  const stdioSpec: McpServerSpec = {
    name: 'openpub',
    transport: 'stdio',
    command: 'npx',
    args: ['@openpub-ai/hub-mcp'],
    env: {
      OPENPUB_AGENT_TOKEN: { source: 'vault', id: 'openpub--openpub-agent-token' },
    },
  }

  it('appends a server to an Identity with no prior mcp_servers', async () => {
    const path = await setupAgent('hobby')
    await appendMcpServerToIdentity({ home, agentName: 'hobby', spec: stdioSpec })
    const reloaded = await loadIdentity(path)
    expect(reloaded.frontmatter.mcp_servers).toHaveLength(1)
    const server = reloaded.frontmatter.mcp_servers[0]
    expect(server?.name).toBe('openpub')
    if (server?.transport !== 'stdio') throw new Error('wrong transport')
    expect(server.command).toBe('npx')
  })

  it('grants the <server>.* tool wildcard so the agent can call the new tools', async () => {
    const path = await setupAgent('hobby')
    await appendMcpServerToIdentity({ home, agentName: 'hobby', spec: stdioSpec })
    const reloaded = await loadIdentity(path)
    expect(reloaded.frontmatter.tools).toContain('openpub.*')
  })

  it('does not duplicate the wildcard grant on idempotent re-add (after remove)', async () => {
    const path = await setupAgent('hobby')
    await appendMcpServerToIdentity({ home, agentName: 'hobby', spec: stdioSpec })
    await removeMcpServerFromIdentity({ home, agentName: 'hobby', serverName: 'openpub' })
    await appendMcpServerToIdentity({ home, agentName: 'hobby', spec: stdioSpec })
    const reloaded = await loadIdentity(path)
    expect(reloaded.frontmatter.tools.filter((t) => t === 'openpub.*')).toHaveLength(1)
  })

  it('preserves the markdown body across the rewrite', async () => {
    const path = await setupAgent('hobby')
    await appendMcpServerToIdentity({ home, agentName: 'hobby', spec: stdioSpec })
    const reloaded = await loadIdentity(path)
    expect(reloaded.body).toMatch(/Identity/)
    expect(reloaded.body).toContain('Body text.')
  })

  it('rejects a duplicate server name', async () => {
    await setupAgent('hobby')
    await appendMcpServerToIdentity({ home, agentName: 'hobby', spec: stdioSpec })
    await expect(
      appendMcpServerToIdentity({ home, agentName: 'hobby', spec: stdioSpec }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_SERVER_NAME' })
  })

  it('throws AGENT_NOT_FOUND for a missing identity', async () => {
    await expect(
      appendMcpServerToIdentity({ home, agentName: 'ghost', spec: stdioSpec }),
    ).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' })
  })

  it('appends an http server with bearer auth', async () => {
    const path = await setupAgent('hobby')
    const httpSpec: McpServerSpec = {
      name: 'hosted',
      transport: 'http',
      url: 'https://api.example.com/mcp',
      auth: { type: 'bearer', token: { source: 'vault', id: 'hosted--token' } },
      headers: {},
    }
    await appendMcpServerToIdentity({ home, agentName: 'hobby', spec: httpSpec })
    const reloaded = await loadIdentity(path)
    const s = reloaded.frontmatter.mcp_servers[0]
    if (s?.transport !== 'http') throw new Error('expected http')
    expect(s.url).toBe('https://api.example.com/mcp')
    expect(s.auth.type).toBe('bearer')
  })
})

describe('removeMcpServerFromIdentity', () => {
  it('removes a present server and returns true', async () => {
    const path = await setupAgent('hobby')
    await appendMcpServerToIdentity({
      home,
      agentName: 'hobby',
      spec: {
        name: 'openpub',
        transport: 'stdio',
        command: 'npx',
        args: [],
        env: {},
      },
    })
    const removed = await removeMcpServerFromIdentity({
      home,
      agentName: 'hobby',
      serverName: 'openpub',
    })
    expect(removed).toBe(true)
    const reloaded = await loadIdentity(path)
    expect(reloaded.frontmatter.mcp_servers).toHaveLength(0)
  })

  it('revokes the <server>.* tool grant on remove', async () => {
    const path = await setupAgent('hobby')
    await appendMcpServerToIdentity({
      home,
      agentName: 'hobby',
      spec: { name: 'openpub', transport: 'stdio', command: 'npx', args: [], env: {} },
    })
    let reloaded = await loadIdentity(path)
    expect(reloaded.frontmatter.tools).toContain('openpub.*')
    await removeMcpServerFromIdentity({ home, agentName: 'hobby', serverName: 'openpub' })
    reloaded = await loadIdentity(path)
    expect(reloaded.frontmatter.tools).not.toContain('openpub.*')
  })

  it('preserves tool grants for unrelated servers/tools when removing one server', async () => {
    const path = await setupAgent('hobby')
    await appendMcpServerToIdentity({
      home,
      agentName: 'hobby',
      spec: { name: 'openpub', transport: 'stdio', command: 'npx', args: [], env: {} },
    })
    await appendMcpServerToIdentity({
      home,
      agentName: 'hobby',
      spec: { name: 'slackish', transport: 'stdio', command: 'npx', args: [], env: {} },
    })
    await removeMcpServerFromIdentity({ home, agentName: 'hobby', serverName: 'openpub' })
    const reloaded = await loadIdentity(path)
    expect(reloaded.frontmatter.tools).not.toContain('openpub.*')
    expect(reloaded.frontmatter.tools).toContain('slackish.*')
  })

  it('returns false when no entry matches', async () => {
    await setupAgent('hobby')
    const removed = await removeMcpServerFromIdentity({
      home,
      agentName: 'hobby',
      serverName: 'never-installed',
    })
    expect(removed).toBe(false)
  })

  it('writes a valid identity after removal (round-trips through loadIdentity)', async () => {
    const path = await setupAgent('hobby')
    await appendMcpServerToIdentity({
      home,
      agentName: 'hobby',
      spec: { name: 'a', transport: 'stdio', command: 'a', args: [], env: {} },
    })
    await appendMcpServerToIdentity({
      home,
      agentName: 'hobby',
      spec: { name: 'b', transport: 'stdio', command: 'b', args: [], env: {} },
    })
    await removeMcpServerFromIdentity({ home, agentName: 'hobby', serverName: 'a' })
    const reloaded = await loadIdentity(path)
    expect(reloaded.frontmatter.mcp_servers.map((s) => s.name)).toEqual(['b'])
    const raw = await readFile(path, 'utf8')
    expect(raw).toContain('schema_version: 5')
  })
})
