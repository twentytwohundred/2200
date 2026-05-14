/**
 * Tests for the audit kick-back loop in AgentLoop. Doug's mandate
 * (cure-not-symptom): when the audit catches a contradicted claim,
 * the loop pushes a corrective tool message + continues, giving the
 * agent the chance to actually do the work or rewrite its reply.
 * Bounded by MAX_AUDIT_KICKBACKS so a persistently failing agent
 * doesn't loop forever.
 *
 * Cover:
 *  - kick-back fires on important severity, then the agent corrects → done
 *  - kick-back exhausts after 3 attempts → finalizes with the flag still set
 *  - silent severity → never kicks back
 *  - pure tasks skip the audit hook entirely
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../../../../src/runtime/agent/loop.js'
import { TaskStore } from '../../../../src/runtime/agent/task/store.js'
import { newPendingTask } from '../../../../src/runtime/agent/task/types.js'
import { newTaskId } from '../../../../src/runtime/util/id.js'
import { ToolRegistry } from '../../../../src/runtime/mcp/registry.js'
import { ToolDispatcher } from '../../../../src/runtime/tools/dispatcher.js'
import {
  baselineServers,
  BASELINE_TOOL_NAMES,
} from '../../../../src/runtime/tools/baseline/index.js'
import { agentPaths } from '../../../../src/runtime/storage/layout.js'
import type { LLMProvider } from '../../../../src/runtime/llm/provider.js'
import type { CompletionRequest, CompletionResponse } from '../../../../src/runtime/llm/types.js'
import type { ClaimEvidenceAuditResult } from '../../../../src/runtime/agent/audit/types.js'
import type { IdentityRecord } from '../../../../src/runtime/identity/types.js'

class ScriptedProvider implements LLMProvider {
  readonly name = 'fake'
  readonly baseUrl = 'http://fake'
  private idx = 0
  constructor(private readonly script: string[]) {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async complete(_req: CompletionRequest): Promise<CompletionResponse> {
    if (this.idx >= this.script.length) {
      throw new Error(`provider exhausted at call ${String(this.idx)}`)
    }
    return {
      text: this.script[this.idx++] ?? '',
      finishReason: 'stop',
      costMetrics: { inputTokens: 5, outputTokens: 5, estDollars: 0.001 },
    }
  }
}

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-audit-kickback-'))
  await mkdir(join(home, 'agents', 'hobby', 'project'), { recursive: true })
  await mkdir(join(home, 'agents', 'hobby', 'brain'), { recursive: true })
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function makeDispatcher(): ToolDispatcher {
  const registry = new ToolRegistry()
  for (const server of baselineServers({
    getIdentity: () => fakeIdentity(),
    getSupervisorRpc: () => undefined,
  })) {
    registry.register(server)
  }
  return new ToolDispatcher({
    registry,
    allowedToolNames: new Set(BASELINE_TOOL_NAMES),
    home,
    callingAgent: 'hobby',
    brainDir: agentPaths(home, 'hobby').brain,
    projectDir: agentPaths(home, 'hobby').project,
  })
}

function fakeIdentity(): IdentityRecord {
  return {
    source_path: '/tmp/identity.md',
    frontmatter: {
      schema_version: 5,
      agent_name: 'hobby',
      agent_role: 'test agent',
      model: { tier: 'frontier', provider: 'fake', model_id: 'frontier-1' },
      tools: [],
      project_dir: 'project',
      brain_dir: 'brain',
      created: '2026-05-14',
      cost_caps: {
        daily_usd: 50,
        warn_at_pct: 80,
        reset_at: '00:00 UTC',
        on_breach: 'block_new_tasks',
      },
      notification_policy: { tiers_allowed: ['passive', 'normal', 'important'] },
      mcp_servers: [],
    },
    body: '',
  }
}

function importantAudit(): ClaimEvidenceAuditResult {
  return {
    severity: 'important',
    summary: '1 contradicted',
    destructive: true,
    records: [
      {
        claim: { category: 'file_create', verb: 'wrote', object: 'a file' },
        outcome: { status: 'contradicted', reason: 'no fs_write call in transcript' },
      },
    ],
  }
}

function silentAudit(): ClaimEvidenceAuditResult {
  return {
    severity: 'silent',
    summary: 'no factual claims extracted',
    destructive: true,
    records: [],
  }
}

describe('AgentLoop · audit kick-back', () => {
  it('fires kick-back on important severity, then accepts a corrected reply', async () => {
    const dispatcher = makeDispatcher()
    const taskStore = new TaskStore(home, 'hobby')
    const ap = agentPaths(home, 'hobby')
    const provider = new ScriptedProvider([
      // turn 1: hallucinated claim
      'I wrote /project/totally-fake.txt with the content hello.',
      // turn 2: agent admits and rewrites
      'Sorry. I did not actually write any file. Acknowledging.',
    ])
    let auditCalls = 0
    const loop = new AgentLoop({
      identity: fakeIdentity(),
      provider,
      dispatcher,
      taskStore,
      home,
      brainDir: ap.brain,
      availableToolNames: BASELINE_TOOL_NAMES,
      claimEvidenceAudit: async () => {
        auditCalls += 1
        await Promise.resolve()
        // First audit: contradicted. Second audit: silent (the agent
        // corrected its narration, no claim left to verify).
        return auditCalls === 1 ? importantAudit() : silentAudit()
      },
    })
    const task = newPendingTask({
      id: newTaskId(),
      agent: 'hobby',
      title: 'demo',
      body: 'do something',
      idempotency: 'destructive',
    })
    await taskStore.save(task)
    const r = await loop.run(task)
    expect(r.kind).toBe('done')
    if (r.kind === 'done') {
      expect(r.iterations).toBe(2)
      expect(r.audit_kickbacks).toBe(1)
      expect(r.summary).toContain('did not actually write')
      expect(r.claim_audit?.severity).toBe('silent')
    }
    expect(auditCalls).toBe(2)
  })

  it('exhausts the kick-back budget then finalizes anyway with the flag set', async () => {
    const dispatcher = makeDispatcher()
    const taskStore = new TaskStore(home, 'hobby')
    const ap = agentPaths(home, 'hobby')
    // Agent stubbornly repeats the same hallucinated claim 4 times.
    const provider = new ScriptedProvider([
      'I wrote /project/x.txt.',
      'I wrote /project/x.txt.',
      'I wrote /project/x.txt.',
      'I wrote /project/x.txt.',
    ])
    const loop = new AgentLoop({
      identity: fakeIdentity(),
      provider,
      dispatcher,
      taskStore,
      home,
      brainDir: ap.brain,
      availableToolNames: BASELINE_TOOL_NAMES,
      claimEvidenceAudit: async () => {
        await Promise.resolve()
        return importantAudit()
      },
    })
    const task = newPendingTask({
      id: newTaskId(),
      agent: 'hobby',
      title: 'demo',
      body: 'do something',
      idempotency: 'destructive',
    })
    await taskStore.save(task)
    const r = await loop.run(task)
    expect(r.kind).toBe('done')
    if (r.kind === 'done') {
      // 1 initial reply + 3 kick-backs = 4 iterations
      expect(r.iterations).toBe(4)
      expect(r.audit_kickbacks).toBe(3)
      expect(r.claim_audit?.severity).toBe('important')
    }
  })

  it('does not kick back on silent severity', async () => {
    const dispatcher = makeDispatcher()
    const taskStore = new TaskStore(home, 'hobby')
    const ap = agentPaths(home, 'hobby')
    const provider = new ScriptedProvider(['Final answer.'])
    const loop = new AgentLoop({
      identity: fakeIdentity(),
      provider,
      dispatcher,
      taskStore,
      home,
      brainDir: ap.brain,
      availableToolNames: BASELINE_TOOL_NAMES,
      claimEvidenceAudit: async () => {
        await Promise.resolve()
        return silentAudit()
      },
    })
    const task = newPendingTask({
      id: newTaskId(),
      agent: 'hobby',
      title: 'demo',
      body: 'just answer',
      idempotency: 'checkpointed',
    })
    await taskStore.save(task)
    const r = await loop.run(task)
    expect(r.kind).toBe('done')
    if (r.kind === 'done') {
      expect(r.iterations).toBe(1)
      expect(r.audit_kickbacks).toBe(0)
    }
  })

  it('skips the audit hook entirely on pure tasks', async () => {
    const dispatcher = makeDispatcher()
    const taskStore = new TaskStore(home, 'hobby')
    const ap = agentPaths(home, 'hobby')
    const provider = new ScriptedProvider(['Pure answer with claims.'])
    let auditCalls = 0
    const loop = new AgentLoop({
      identity: fakeIdentity(),
      provider,
      dispatcher,
      taskStore,
      home,
      brainDir: ap.brain,
      availableToolNames: BASELINE_TOOL_NAMES,
      claimEvidenceAudit: async () => {
        auditCalls += 1
        await Promise.resolve()
        return importantAudit()
      },
    })
    const task = newPendingTask({
      id: newTaskId(),
      agent: 'hobby',
      title: 'demo',
      body: 'qa',
      idempotency: 'pure',
    })
    await taskStore.save(task)
    const r = await loop.run(task)
    expect(r.kind).toBe('done')
    expect(auditCalls).toBe(0)
    if (r.kind === 'done') {
      expect(r.audit_kickbacks).toBe(0)
      expect(r.claim_audit).toBeNull()
    }
  })
})
