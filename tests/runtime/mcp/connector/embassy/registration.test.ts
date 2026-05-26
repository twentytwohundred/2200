import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, mkdir, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildDedicatedSourceIdentity,
  initEmbassyBrainDirs,
  patchIdentityWithEmbassyBlock,
} from '../../../../../src/runtime/mcp/connector/embassy/registration.js'
import { renderEmbassyIdentityBody } from '../../../../../src/runtime/mcp/connector/embassy/identity-template.js'
import { loadIdentity } from '../../../../../src/runtime/identity/loader.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-embassy-reg-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('renderEmbassyIdentityBody', () => {
  it('produces the spec section 3 body verbatim shape', () => {
    const body = renderEmbassyIdentityBody({
      externalModelDisplay: 'Grok',
      clientId: 'grok-aaa',
      registeredAt: '2026-05-26',
    })
    expect(body).toContain('You are the **Grok Embassy** for this fleet.')
    expect(body).toContain('You are not Grok.')
    expect(body).toContain('Connection ID: grok-aaa')
    expect(body).toContain('Registered: 2026-05-26')
    expect(body).toContain('You never push information outward.')
    expect(body).toContain('You operate under the same execution constraints')
  })
})

describe('buildDedicatedSourceIdentity', () => {
  it('writes a parseable source identity with the embassy block in frontmatter', async () => {
    const path = await buildDedicatedSourceIdentity({
      home,
      agentName: 'grok-embassy',
      externalModel: 'grok',
      clientId: 'grok-aaa',
      registeredAt: '2026-05-26T10:00:00.000Z',
      model: { tier: 'frontier', provider: 'xai', model_id: 'grok-4.3' },
    })
    const identity = await loadIdentity(path)
    expect(identity.frontmatter.agent_name).toBe('grok-embassy')
    expect(identity.frontmatter.agent_role).toBe('Embassy for Grok')
    expect(identity.frontmatter.embassy?.client_id).toBe('grok-aaa')
    expect(identity.frontmatter.embassy?.external_model).toBe('grok')
    expect(identity.frontmatter.embassy?.mode).toBe('dedicated')
    expect(identity.body).toContain('You are the **Grok Embassy**')
  })

  it('produces a 0600 file mode', async () => {
    const path = await buildDedicatedSourceIdentity({
      home,
      agentName: 'grok-embassy',
      externalModel: 'grok',
      clientId: 'grok-aaa',
      registeredAt: '2026-05-26T10:00:00.000Z',
      model: { tier: 'frontier', provider: 'xai', model_id: 'grok-4.3' },
    })
    const s = await stat(path)
    expect(s.mode & 0o777).toBe(0o600)
  })
})

describe('initEmbassyBrainDirs', () => {
  it('creates shelf/, relationship-history/, standing-briefs/, notes/ under the embassy brain', async () => {
    // Need a minimal brain dir to mkdir into.
    const ap = join(home, 'agents', 'grok-embassy', 'brain')
    await mkdir(ap, { recursive: true })
    await initEmbassyBrainDirs(home, 'grok-embassy')
    for (const d of ['shelf', 'relationship-history', 'standing-briefs', 'notes']) {
      const s = await stat(join(ap, d))
      expect(s.isDirectory()).toBe(true)
    }
  })
})

describe('patchIdentityWithEmbassyBlock', () => {
  async function writeStubIdentity(): Promise<string> {
    const dir = join(home, 'agents', 'hobby')
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'identity.md')
    const fm = [
      'schema_version: 5',
      'agent_name: hobby',
      'agent_role: "test"',
      'model:',
      '  tier: frontier',
      '  provider: anthropic',
      '  model_id: claude-opus-4-7',
      'tools: []',
      `project_dir: ${join(home, 'agents', 'hobby', 'project')}`,
      `brain_dir: ${join(home, 'agents', 'hobby', 'brain')}`,
      'created: 2026-05-26',
    ].join('\n')
    await writeFile(path, `---\n${fm}\n---\n\n# Identity\n`)
    return path
  }

  it('adds the embassy block when none exists', async () => {
    const path = await writeStubIdentity()
    await patchIdentityWithEmbassyBlock(path, {
      external_model: 'grok',
      client_id: 'grok-aaa',
      mode: 'attached',
      registered_at: '2026-05-26T10:00:00.000Z',
    })
    const identity = await loadIdentity(path)
    expect(identity.frontmatter.embassy?.client_id).toBe('grok-aaa')
    expect(identity.frontmatter.embassy?.mode).toBe('attached')
    expect(identity.body).toContain('# Identity')
  })

  it('is idempotent when the same client_id is patched in twice', async () => {
    const path = await writeStubIdentity()
    const block = {
      external_model: 'grok' as const,
      client_id: 'grok-aaa',
      mode: 'attached' as const,
      registered_at: '2026-05-26T10:00:00.000Z',
    }
    await patchIdentityWithEmbassyBlock(path, block)
    await patchIdentityWithEmbassyBlock(path, block)
    const identity = await loadIdentity(path)
    expect(identity.frontmatter.embassy?.client_id).toBe('grok-aaa')
  })

  it('throws when a DIFFERENT client_id is already registered', async () => {
    const path = await writeStubIdentity()
    await patchIdentityWithEmbassyBlock(path, {
      external_model: 'grok',
      client_id: 'grok-aaa',
      mode: 'attached',
      registered_at: '2026-05-26T10:00:00.000Z',
    })
    await expect(
      patchIdentityWithEmbassyBlock(path, {
        external_model: 'claude',
        client_id: 'claude-bbb',
        mode: 'attached',
        registered_at: '2026-05-26T11:00:00.000Z',
      }),
    ).rejects.toThrow(/already acting as embassy/)
  })
})

describe('identity body preservation', () => {
  it('does not clobber the existing body markdown when patching in the block', async () => {
    const dir = join(home, 'agents', 'simon')
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'identity.md')
    const fm = [
      'schema_version: 5',
      'agent_name: simon',
      'agent_role: "devops"',
      'model:',
      '  tier: frontier',
      '  provider: anthropic',
      '  model_id: claude-opus-4-7',
      'tools: []',
      `project_dir: ${join(home, 'agents', 'simon', 'project')}`,
      `brain_dir: ${join(home, 'agents', 'simon', 'brain')}`,
      'created: 2026-05-26',
    ].join('\n')
    const distinctiveBody = [
      '# Identity',
      '',
      'You are Simon, the fleet DevOps Agent.',
      '',
      '## Memory Rules',
      'Persistent notes live under brain/notes/.',
    ].join('\n')
    await writeFile(path, `---\n${fm}\n---\n\n${distinctiveBody}\n`)
    await patchIdentityWithEmbassyBlock(path, {
      external_model: 'grok',
      client_id: 'grok-aaa',
      mode: 'attached',
      registered_at: '2026-05-26T10:00:00.000Z',
    })
    const after = await readFile(path, 'utf-8')
    expect(after).toContain('You are Simon, the fleet DevOps Agent.')
    expect(after).toContain('Persistent notes live under brain/notes/.')
    expect(after).toContain('embassy:')
  })
})
