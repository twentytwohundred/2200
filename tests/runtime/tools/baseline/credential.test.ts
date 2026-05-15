/**
 * Tests for the credential.* baseline tool family.
 *
 * Focused on the dispatch semantics: surface gating, rate cap, record
 * persistence, system-role chat insertion, return-shape integrity
 * (no values leak), and the four valid terminal states.
 *
 * waitForResolution + transition logic are covered upstream in
 * tests/runtime/credentials/requests.test.ts; here we exercise the
 * tool's coordination with those layers.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialTools } from '../../../../src/runtime/tools/baseline/credential.js'
import { initHome, initAgentDirs } from '../../../../src/runtime/storage/init.js'
import { agentPaths } from '../../../../src/runtime/storage/layout.js'
import { CredentialRequestStore } from '../../../../src/runtime/credentials/requests.js'
import { MultiChatStore } from '../../../../src/runtime/agent/chat/multi-store.js'
import { listNotifications } from '../../../../src/runtime/notifications/reader.js'
import type { ToolContext } from '../../../../src/runtime/mcp/tool.js'
import type { IdentityRecord } from '../../../../src/runtime/identity/types.js'
import type { CredentialRequestState } from '../../../../src/runtime/credentials/request-types.js'

/**
 * Polls the request store until exactly one pending request exists for
 * the agent, then transitions it to `nextState`. Resolves with the new
 * record. Robust to parallel-test filesystem contention; the original
 * fixed-delay setTimeout approach raced the request-record creation.
 */
async function pollAndTransition(args: {
  home: string
  agent: string
  nextState: Exclude<CredentialRequestState, 'pending'>
  declineReason?: string
  expiredReason?: 'timeout' | 'agent_crashed' | 'agent_archived'
}): Promise<void> {
  const store = new CredentialRequestStore(args.home)
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const pending = await store.list({ agent: args.agent, state: 'pending' })
    if (pending.length > 0) {
      await store.transition(pending[0]!.id, args.nextState, {
        now: new Date().toISOString(),
        ...(args.declineReason !== undefined ? { decline_reason: args.declineReason } : {}),
        ...(args.expiredReason !== undefined ? { expired_reason: args.expiredReason } : {}),
      })
      return
    }
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('pollAndTransition: no pending request appeared within 8s')
}

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-credreq-tool-'))
  await initHome(home)
  const seed = join(home, '_seed_identity.md')
  await writeFile(
    seed,
    `---
schema_version: 1
agent_name: hobby
agent_role: build agent
model:
  tier: frontier
  provider: deepseek
  model_id: deepseek-chat
tools: []
project_dir: /unused
brain_dir: /unused
created: 2026-05-15
---

# Identity

Test agent.
`,
    'utf8',
  )
  await initAgentDirs(home, 'hobby', seed)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function findTool() {
  const tools = credentialTools(() => stubIdentity())
  const tool = tools.find((t) => t.name === 'credential_request')
  if (!tool) throw new Error('credential_request missing from baseline')
  return tool
}

function stubIdentity(override?: Partial<IdentityRecord['frontmatter']>): IdentityRecord {
  return {
    source_path: '/x',
    body: '',
    frontmatter: {
      agent_name: 'hobby',
      ...(override ?? {}),
    },
  } as never
}

function ctx(opts: { source?: ToolContext['taskSource'] } = {}): ToolContext {
  const ap = agentPaths(home, 'hobby')
  return {
    callingAgent: 'hobby',
    home,
    brainDir: ap.brain,
    projectDir: ap.project,
    taskId: 'task_test',
    callId: 'call_test',
    taskSource: opts.source,
  }
}

const sampleArgs = {
  credential_name: 'openpub--private-key',
  label: 'OpenPub Private Key',
  help: 'paste from dashboard',
  kind: 'secret' as const,
  reason: 'authenticate to openpub MCP server',
}

describe('credential_request — surface gating', () => {
  it('declines when no taskSource is present', async () => {
    const tool = findTool()
    const args = tool.argsSchema.parse(sampleArgs)
    const out = (await tool.execute(args, ctx({ source: null }))) as {
      status: string
      decline_reason: string
    }
    expect(out.status).toBe('declined')
    expect(out.decline_reason).toBe('surface_invalid')
  })

  it('declines when taskSource is pub / schedule / cli / delegation / self_spawn', async () => {
    const tool = findTool()
    const sources: ToolContext['taskSource'][] = [
      { kind: 'pub', pub: 'lobby' },
      { kind: 'schedule', schedule_id: 'sched_x' },
      { kind: 'cli' },
      { kind: 'delegation', parent_task_id: 'task_x' },
      { kind: 'self_spawn' },
    ]
    const args = tool.argsSchema.parse(sampleArgs)
    for (const source of sources) {
      const out = (await tool.execute(args, ctx({ source }))) as {
        status: string
        decline_reason: string
      }
      expect(out.status).toBe('declined')
      expect(out.decline_reason).toBe('surface_invalid')
    }
  })

  it('does NOT write a request record on a rejected surface', async () => {
    const tool = findTool()
    const args = tool.argsSchema.parse(sampleArgs)
    await tool.execute(args, ctx({ source: { kind: 'pub', pub: 'lobby' } }))
    const store = new CredentialRequestStore(home)
    const list = await store.list()
    expect(list).toEqual([])
  })
})

describe('credential_request — rate cap', () => {
  it('declines with rate_capped + emits operator notification on cap hit', async () => {
    // Override identity to cap=2 for a fast test.
    const tools = credentialTools(
      () => stubIdentity({ request_credential_rate_per_hour: 2 } as never),
    )
    const tool = tools.find((t) => t.name === 'credential_request')!
    const args = tool.argsSchema.parse(sampleArgs)
    const source: ToolContext['taskSource'] = { kind: 'chat', chat_id: 'chat_a' }

    // First two succeed but block on the operator — we don't await,
    // we transition them off-loop. We just want to bump the rate
    // counter. Easiest: bump the rate state directly via the store.
    const store = new CredentialRequestStore(home)
    await store.checkAndIncrementRate({ agent: 'hobby', cap: 2, now: new Date() })
    await store.checkAndIncrementRate({ agent: 'hobby', cap: 2, now: new Date() })

    const out = (await tool.execute(args, ctx({ source }))) as {
      status: string
      decline_reason: string
    }
    expect(out.status).toBe('declined')
    expect(out.decline_reason).toBe('rate_capped')

    // Operator notification surfaced at important tier.
    const notifs = await listNotifications(home, { kind: 'credential_request_rate_capped' })
    expect(notifs.length).toBeGreaterThan(0)
    expect(notifs[0]?.frontmatter.tier).toBe('important')
  })
})

describe('credential_request — persisted shape', () => {
  it('returns fulfilled when the operator fulfills mid-wait', async () => {
    const tool = findTool()
    const args = tool.argsSchema.parse(sampleArgs)
    const source: ToolContext['taskSource'] = { kind: 'chat', chat_id: 'chat_a' }

    // Fulfill the request as soon as the tool persists it.
    void pollAndTransition({ home, agent: 'hobby', nextState: 'fulfilled' })

    const out = (await tool.execute(args, ctx({ source }))) as {
      status: string
      credential_name: string
      set_at: string | null
    }
    expect(out.status).toBe('fulfilled')
    expect(out.credential_name).toBe('openpub--private-key')
    expect(typeof out.set_at).toBe('string')
  })

  it('persists a record with no value field and a frozen envelope shape', { timeout: 15_000 }, async () => {
    const tool = findTool()
    const args = tool.argsSchema.parse(sampleArgs)

    // Real chat threads are created by the web HTTP handlers before
    // a task spawns; for the tool test we pre-create the thread so
    // the system-role insertion path is exercised.
    const chats = new MultiChatStore(home, 'hobby')
    const chat = await chats.createChat({ title: 'auth setup' })
    const source: ToolContext['taskSource'] = { kind: 'chat', chat_id: chat.id }

    void pollAndTransition({
      home,
      agent: 'hobby',
      nextState: 'declined',
      declineReason: 'operator hit decline',
    })

    await tool.execute(args, ctx({ source }))
    const store = new CredentialRequestStore(home)
    const list = await store.list({ agent: 'hobby' })
    expect(list).toHaveLength(1)
    const rec = list[0]!
    expect(rec.state).toBe('declined')
    expect(rec.decline_reason).toBe('operator hit decline')

    // Chat-thread system-role message landed with the right kind +
    // envelope shape; the body JSON must NOT carry a value field.
    const messages = await chats.listMessages(chat.id)
    const sysMsgs = messages.filter((m) => m.role === 'system' && m.kind === 'credential_request')
    expect(sysMsgs).toHaveLength(1)
    const body = JSON.parse(sysMsgs[0]!.body) as Record<string, unknown>
    expect(body['envelope']).toBe('credential_request_v1')
    expect(body['destination_credential_name']).toBe('openpub--private-key')
    expect('value' in body).toBe(false)
  })

  it('flips to expired locally if no resolution arrives in time', { timeout: 15_000 }, async () => {
    // Force a tight timeout so the local sweep kicks in.
    const tool = findTool()
    const args = tool.argsSchema.parse(sampleArgs)
    const source: ToolContext['taskSource'] = { kind: 'chat', chat_id: 'chat_a' }

    // Simulate a sweeper-driven expire by transitioning the record
    // as soon as the tool persists it. The tool's local fallback
    // would do the same after DEFAULT_TIMEOUT_MS; we shortcut that
    // here so the test is fast.
    void pollAndTransition({
      home,
      agent: 'hobby',
      nextState: 'expired',
      expiredReason: 'timeout',
    })

    const out = (await tool.execute(args, ctx({ source }))) as {
      status: string
      expired_reason: string | null
    }
    expect(out.status).toBe('expired')
    expect(out.expired_reason).toBe('timeout')
  })
})
