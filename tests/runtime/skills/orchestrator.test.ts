import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  installSkillFromSource,
  listSkillCredentials,
  previewSkillInstall,
  SkillOrchestratorError,
  uninstallSkillFromHome,
  updateSkillCredential,
} from '../../../src/runtime/skills/orchestrator.js'
import { CredentialVault } from '../../../src/runtime/credentials/vault.js'
import { loadIdentity } from '../../../src/runtime/identity/loader.js'
import { loadAuditOverlay } from '../../../src/runtime/agent/audit/overlay.js'
import { agentIdentityDir } from '../../../src/runtime/storage/layout.js'

let home: string
let scratch: string

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

const OPENPUB_SKILL = [
  '---',
  'name: openpub',
  'description: Social pubs for AI agents.',
  'tags:',
  '  - social',
  'tool_classes:',
  '  check_in: external_send',
  '  search_pubs: file_read',
  '---',
  '',
  '# OpenPub',
  '',
  '```json',
  '{',
  '  "mcpServers": {',
  '    "openpub": {',
  '      "command": "npx",',
  '      "args": ["@openpub-ai/hub-mcp"],',
  '      "env": {',
  '        "OPENPUB_AGENT_TOKEN": "<your-token>",',
  '        "OPENPUB_REFRESH_TOKEN": "<your-refresh-token>"',
  '      }',
  '    }',
  '  }',
  '}',
  '```',
].join('\n')

async function setupAgent(name: string): Promise<void> {
  const root = join(home, 'agents', name)
  await mkdir(root, { recursive: true })
  await mkdir(agentIdentityDir(home, name), { recursive: true })
  const content = VALID_IDENTITY.replace(/agent_name: hobby/, `agent_name: ${name}`)
    .replace(/agents\/hobby\/project/g, `agents/${name}/project`)
    .replace(/agents\/hobby\/brain/g, `agents/${name}/brain`)
  await writeFile(join(root, 'identity.md'), content, 'utf8')
}

function makeFetchFor(body: string, init?: ResponseInit): typeof fetch {
  return () => Promise.resolve(new Response(body, init ?? { status: 200 }))
}

function makeTempDirFactory(sub: string) {
  return async () => {
    const path = join(scratch, sub)
    await mkdir(path, { recursive: true })
    return path
  }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-skill-orch-'))
  scratch = await mkdtemp(join(tmpdir(), '2200-skill-orch-scratch-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

describe('previewSkillInstall', () => {
  it('fetches a SKILL.md URL and returns the parsed preview', async () => {
    const preview = await previewSkillInstall({
      source: 'https://openpub.ai/skill.md',
      resolveOptions: {
        makeTempDir: makeTempDirFactory('preview'),
        fetchImpl: makeFetchFor(OPENPUB_SKILL),
      },
    })
    expect(preview.name).toBe('openpub')
    expect(preview.description).toBe('Social pubs for AI agents.')
    expect(preview.tags).toEqual(['social'])
    expect(preview.source_kind).toBe('skill_url')
    expect(preview.mcp_servers).toHaveLength(1)
    expect(preview.mcp_servers[0]?.name).toBe('openpub')
    expect(preview.tool_classes).toEqual({
      check_in: 'external_send',
      search_pubs: 'file_read',
    })
  })

  it('surfaces SOURCE_FAILED on fetch failure', async () => {
    await expect(
      previewSkillInstall({
        source: 'https://example.com/skill.md',
        resolveOptions: {
          makeTempDir: makeTempDirFactory('preview-fail'),
          fetchImpl: () => Promise.resolve(new Response('nope', { status: 404 })),
        },
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_FAILED' })
  })

  it('surfaces PARSE_FAILED on a malformed SKILL.md', async () => {
    await expect(
      previewSkillInstall({
        source: 'https://example.com/skill.md',
        resolveOptions: {
          makeTempDir: makeTempDirFactory('preview-parse'),
          fetchImpl: makeFetchFor('not yaml at all'),
        },
      }),
    ).rejects.toMatchObject({ code: 'PARSE_FAILED' })
  })

  it('cleans up the temp dir after preview', async () => {
    const factory = makeTempDirFactory('preview-cleanup')
    let captured: string | undefined
    await previewSkillInstall({
      source: 'https://openpub.ai/skill.md',
      resolveOptions: {
        makeTempDir: async () => {
          const p = await factory()
          captured = p
          return p
        },
        fetchImpl: makeFetchFor(OPENPUB_SKILL),
      },
    })
    expect(captured).toBeDefined()
    await expect(stat(captured!)).rejects.toThrow()
  })
})

describe('installSkillFromSource', () => {
  it('installs the skill to disk, wires up the agent, stores secrets', async () => {
    await setupAgent('hobby')
    const result = await installSkillFromSource({
      home,
      source: 'https://openpub.ai/skill.md',
      agents: ['hobby'],
      secrets: {
        hobby: {
          openpub: {
            OPENPUB_AGENT_TOKEN: 'real-token-a',
            OPENPUB_REFRESH_TOKEN: 'real-token-b',
          },
        },
      },
      resolveOptions: {
        makeTempDir: makeTempDirFactory('install-source'),
        fetchImpl: makeFetchFor(OPENPUB_SKILL),
      },
    })

    expect(result.skill.name).toBe('openpub')
    expect(result.mcp_installed_for).toEqual(['hobby'])
    expect(result.requires_restart).toEqual(['hobby'])

    // Skill landed on disk
    const skillContent = await readFile(join(home, 'skills', 'openpub', 'SKILL.md'), 'utf8')
    expect(skillContent).toContain('name: openpub')

    // Identity got the server
    const identity = await loadIdentity(join(home, 'agents', 'hobby', 'identity.md'))
    expect(identity.frontmatter.mcp_servers).toHaveLength(1)
    const server = identity.frontmatter.mcp_servers[0]
    if (server?.transport !== 'stdio') throw new Error('expected stdio')
    expect(server.command).toBe('npx')
    expect(server.env['OPENPUB_AGENT_TOKEN']).toEqual({
      source: 'vault',
      id: 'openpub--openpub-agent-token',
    })

    // Vault has the values
    const vault = new CredentialVault(home, 'hobby')
    expect((await vault.get('openpub--openpub-agent-token')).value).toBe('real-token-a')
    expect((await vault.get('openpub--openpub-refresh-token')).value).toBe('real-token-b')
  })

  it('rejects an install when required secrets are missing', async () => {
    await setupAgent('hobby')
    await expect(
      installSkillFromSource({
        home,
        source: 'https://openpub.ai/skill.md',
        agents: ['hobby'],
        secrets: {
          hobby: { openpub: { OPENPUB_AGENT_TOKEN: 'has-value' } }, // missing the second
        },
        resolveOptions: {
          makeTempDir: makeTempDirFactory('install-missing'),
          fetchImpl: makeFetchFor(OPENPUB_SKILL),
        },
      }),
    ).rejects.toMatchObject({ code: 'SECRETS_INCOMPLETE' })
  })

  it('installs a knowledge-only skill without touching any agent', async () => {
    await setupAgent('hobby')
    const KNOWLEDGE_ONLY = [
      '---',
      'name: pure-knowledge',
      'description: Just instructions.',
      '---',
      '',
      '# Body',
    ].join('\n')
    const result = await installSkillFromSource({
      home,
      source: 'https://example.com/skill.md',
      agents: [],
      secrets: {},
      resolveOptions: {
        makeTempDir: makeTempDirFactory('install-knowledge'),
        fetchImpl: makeFetchFor(KNOWLEDGE_ONLY),
      },
    })
    expect(result.skill.name).toBe('pure-knowledge')
    expect(result.mcp_installed_for).toEqual([])
    const identity = await loadIdentity(join(home, 'agents', 'hobby', 'identity.md'))
    expect(identity.frontmatter.mcp_servers).toHaveLength(0)
  })

  it('writes a per-agent audit overlay with namespaced tool_classes', async () => {
    await setupAgent('hobby')
    await installSkillFromSource({
      home,
      source: 'https://openpub.ai/skill.md',
      agents: ['hobby'],
      secrets: {
        hobby: {
          openpub: {
            OPENPUB_AGENT_TOKEN: 'a',
            OPENPUB_REFRESH_TOKEN: 'b',
          },
        },
      },
      resolveOptions: {
        makeTempDir: makeTempDirFactory('install-overlay'),
        fetchImpl: makeFetchFor(OPENPUB_SKILL),
      },
    })
    const overlay = await loadAuditOverlay(home, 'hobby')
    expect(overlay).toEqual({
      openpub_check_in: 'external_send',
      openpub_search_pubs: 'file_read',
    })
  })

  it('scrubs the overlay on uninstall', async () => {
    await setupAgent('hobby')
    await installSkillFromSource({
      home,
      source: 'https://openpub.ai/skill.md',
      agents: ['hobby'],
      secrets: {
        hobby: {
          openpub: {
            OPENPUB_AGENT_TOKEN: 'a',
            OPENPUB_REFRESH_TOKEN: 'b',
          },
        },
      },
      resolveOptions: {
        makeTempDir: makeTempDirFactory('install-scrub'),
        fetchImpl: makeFetchFor(OPENPUB_SKILL),
      },
    })
    expect(Object.keys(await loadAuditOverlay(home, 'hobby'))).toHaveLength(2)
    await uninstallSkillFromHome({ home, name: 'openpub', agents: ['hobby'] })
    expect(await loadAuditOverlay(home, 'hobby')).toEqual({})
  })

  it('emits tool_classes warnings when the SKILL.md declares unknown classes', async () => {
    await setupAgent('hobby')
    const WITH_BAD_CLASS = [
      '---',
      'name: openpub2',
      'description: x.',
      'tool_classes:',
      '  fine: external_send',
      '  bad: not_a_real_class',
      '---',
      '',
      'body',
    ].join('\n')
    const result = await installSkillFromSource({
      home,
      source: 'https://example.com/skill.md',
      agents: [],
      secrets: {},
      resolveOptions: {
        makeTempDir: makeTempDirFactory('install-warnings'),
        fetchImpl: makeFetchFor(WITH_BAD_CLASS),
      },
    })
    expect(result.warnings.some((w) => w.includes('not_a_real_class'))).toBe(true)
  })

  it('aborts before writing when an agent is unknown', async () => {
    await expect(
      installSkillFromSource({
        home,
        source: 'https://openpub.ai/skill.md',
        agents: ['ghost'],
        secrets: {
          ghost: {
            openpub: {
              OPENPUB_AGENT_TOKEN: 'a',
              OPENPUB_REFRESH_TOKEN: 'b',
            },
          },
        },
        resolveOptions: {
          makeTempDir: makeTempDirFactory('install-ghost'),
          fetchImpl: makeFetchFor(OPENPUB_SKILL),
        },
      }),
    ).rejects.toBeInstanceOf(SkillOrchestratorError)
  })
})

describe('uninstallSkillFromHome', () => {
  it('removes the skill from disk + each listed agent', async () => {
    await setupAgent('hobby')
    await setupAgent('simon')
    await installSkillFromSource({
      home,
      source: 'https://openpub.ai/skill.md',
      agents: ['hobby', 'simon'],
      secrets: {
        hobby: { openpub: { OPENPUB_AGENT_TOKEN: 'a', OPENPUB_REFRESH_TOKEN: 'b' } },
        simon: { openpub: { OPENPUB_AGENT_TOKEN: 'c', OPENPUB_REFRESH_TOKEN: 'd' } },
      },
      resolveOptions: {
        makeTempDir: makeTempDirFactory('round-trip-install'),
        fetchImpl: makeFetchFor(OPENPUB_SKILL),
      },
    })

    const result = await uninstallSkillFromHome({
      home,
      name: 'openpub',
      agents: ['hobby', 'simon'],
    })
    expect(result.removed).toBe(true)
    expect(result.removed_from_agents.sort()).toEqual(['hobby', 'simon'])

    // Skill dir is gone
    await expect(stat(join(home, 'skills', 'openpub'))).rejects.toThrow()
    // Identities no longer carry the server
    const hobby = await loadIdentity(join(home, 'agents', 'hobby', 'identity.md'))
    expect(hobby.frontmatter.mcp_servers).toHaveLength(0)
    const simon = await loadIdentity(join(home, 'agents', 'simon', 'identity.md'))
    expect(simon.frontmatter.mcp_servers).toHaveLength(0)
  })

  it('returns removed=false for an unknown skill name', async () => {
    const result = await uninstallSkillFromHome({ home, name: 'never-installed', agents: [] })
    expect(result.removed).toBe(false)
  })
})

describe('listSkillCredentials + updateSkillCredential', () => {
  async function setupOpenpubInstall(): Promise<void> {
    await setupAgent('hobby')
    await setupAgent('simon')
    await installSkillFromSource({
      home,
      source: 'https://openpub.ai/skill.md',
      agents: ['hobby', 'simon'],
      secrets: {
        hobby: { openpub: { OPENPUB_AGENT_TOKEN: 'h-tok', OPENPUB_REFRESH_TOKEN: 'h-ref' } },
        simon: { openpub: { OPENPUB_AGENT_TOKEN: 's-tok', OPENPUB_REFRESH_TOKEN: 's-ref' } },
      },
      resolveOptions: {
        makeTempDir: makeTempDirFactory('cred-mgmt-install'),
        fetchImpl: makeFetchFor(OPENPUB_SKILL),
      },
    })
  }

  it('lists per-agent vault credentials wired up by the named skill', async () => {
    await setupOpenpubInstall()
    const groups = await listSkillCredentials({
      home,
      skillName: 'openpub',
      agents: ['hobby', 'simon'],
    })
    expect(groups).toHaveLength(2)
    const hobbyGroup = groups.find((g) => g.agent === 'hobby')!
    expect(hobbyGroup.server_name).toBe('openpub')
    expect(hobbyGroup.credentials.map((c) => c.env_key).sort()).toEqual([
      'OPENPUB_AGENT_TOKEN',
      'OPENPUB_REFRESH_TOKEN',
    ])
    expect(hobbyGroup.credentials[0]?.credential_name.startsWith('openpub--')).toBe(true)
    expect(hobbyGroup.credentials[0]?.set_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('skips agents that do not have the skill installed', async () => {
    await setupOpenpubInstall()
    await setupAgent('jodin') // jodin exists but never had the skill installed
    const groups = await listSkillCredentials({
      home,
      skillName: 'openpub',
      agents: ['hobby', 'simon', 'jodin'],
    })
    expect(groups.map((g) => g.agent).sort()).toEqual(['hobby', 'simon'])
  })

  it('returns an empty list for a skill nobody has', async () => {
    await setupAgent('hobby')
    const groups = await listSkillCredentials({
      home,
      skillName: 'never-installed',
      agents: ['hobby'],
    })
    expect(groups).toEqual([])
  })

  it('updates one credential value (round-trip through vault)', async () => {
    await setupOpenpubInstall()
    const result = await updateSkillCredential({
      home,
      skillName: 'openpub',
      agentName: 'hobby',
      envKey: 'OPENPUB_AGENT_TOKEN',
      value: 'rotated-token-h',
    })
    expect(result.credential_name).toBe('openpub--openpub-agent-token')
    expect(result.requires_restart).toBe('hobby')
    const vault = new CredentialVault(home, 'hobby')
    expect((await vault.get('openpub--openpub-agent-token')).value).toBe('rotated-token-h')
  })

  it('does not affect other agents when updating one agent', async () => {
    await setupOpenpubInstall()
    await updateSkillCredential({
      home,
      skillName: 'openpub',
      agentName: 'hobby',
      envKey: 'OPENPUB_AGENT_TOKEN',
      value: 'rotated-token-h',
    })
    const simonVault = new CredentialVault(home, 'simon')
    expect((await simonVault.get('openpub--openpub-agent-token')).value).toBe('s-tok')
  })

  it('refuses to update a credential whose name does not carry the skill prefix', async () => {
    await setupOpenpubInstall()
    // Create a non-skill credential and try to update it via the skill path.
    // The orchestrator should refuse because the env key isn't mapped to a
    // <skill>-- prefixed credential in hobby's identity.
    await expect(
      updateSkillCredential({
        home,
        skillName: 'openpub',
        agentName: 'hobby',
        envKey: 'NOT_A_REAL_ENV',
        value: 'whatever',
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_FAILED' })
  })

  it('refuses an empty value', async () => {
    await setupOpenpubInstall()
    await expect(
      updateSkillCredential({
        home,
        skillName: 'openpub',
        agentName: 'hobby',
        envKey: 'OPENPUB_AGENT_TOKEN',
        value: '',
      }),
    ).rejects.toMatchObject({ code: 'SECRETS_INCOMPLETE' })
  })
})
