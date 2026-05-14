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
  it('kick-back: agent recovers by ACTUALLY DOING THE WORK via tool call', async () => {
    const dispatcher = makeDispatcher()
    const taskStore = new TaskStore(home, 'hobby')
    const ap = agentPaths(home, 'hobby')
    const provider = new ScriptedProvider([
      // turn 1: hallucinated claim (no tool call)
      'I wrote /project/note.md with the content hello.',
      // turn 2 (after kick-back): actually do the work
      '```tool\n{"tool":"fs_write","args":{"path":"/project/note.md","content":"hello"},"predicted_outcome":"ok","reason":"actually do it"}\n```',
      // turn 3: re-summarize
      'Done. /project/note.md now exists with the content hello.',
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
        // First audit (turn 1): contradicted → kick back
        // Second audit (turn 3): silent because the agent re-summarized
        // accurately AND the tool log now backs the prior claim
        return auditCalls === 1 ? importantAudit() : silentAudit()
      },
    })
    const task = newPendingTask({
      id: newTaskId(),
      agent: 'hobby',
      title: 'demo',
      body: 'write hello to /project/note.md',
      idempotency: 'destructive',
    })
    await taskStore.save(task)
    const r = await loop.run(task)
    expect(r.kind).toBe('done')
    if (r.kind === 'done') {
      // turn1 + kickback + tool turn + summarize = 3 iterations
      expect(r.iterations).toBe(3)
      expect(r.audit_kickbacks).toBe(1)
      expect(r.claim_audit?.severity).toBe('silent')
    }
    // Audit ran twice: once per "I think I'm done" moment.
    expect(auditCalls).toBe(2)
  })

  it('text-only escape after kick-back triggers ANOTHER kick-back (no-escape)', async () => {
    // Doug's bar: a plain-text "I did not do it" reply is not a valid
    // end-state. The loop must demand action OR formal ask via tool.
    const dispatcher = makeDispatcher()
    const taskStore = new TaskStore(home, 'hobby')
    const ap = agentPaths(home, 'hobby')
    const provider = new ScriptedProvider([
      // turn 1: hallucinated claim
      'I wrote /project/totally-fake.txt with the content hello.',
      // turn 2: text-only ack-and-bail (no tool call, no new claim)
      'Sorry. I did not actually write any file. Acknowledging.',
      // turn 3: another text-only ack
      'I cannot do this work.',
      // turn 4: still text only
      'Acknowledged again.',
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
        // First audit: flagged. Subsequent: silent (no claims in text-only acks).
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
      // 1 initial fab + 3 text-only escape attempts = 4 iterations,
      // 3 kick-backs (one for the fab, two for the no-escape rule).
      expect(r.iterations).toBe(4)
      expect(r.audit_kickbacks).toBe(3)
    }
  })

  it('formal ask via tool call satisfies the bar (path 2: blocked-with-ask)', async () => {
    // Doug's bar: agent must either DO the work or formally ASK via tool.
    // Simulating the ask path: agent calls notification_create (mocked
    // here as fs_write since it's a real tool the test dispatcher has,
    // but the principle holds: any send-class tool call counts as a
    // formal ask in production).
    const dispatcher = makeDispatcher()
    const taskStore = new TaskStore(home, 'hobby')
    const ap = agentPaths(home, 'hobby')
    const provider = new ScriptedProvider([
      // turn 1: hallucinated
      'I wrote /project/note.md with hello.',
      // turn 2: formal ask via fs_write to a project file (in production
      // this would be notification_create / chat_send; using fs_write
      // here keeps the test focused on the loop behavior).
      '```tool\n{"tool":"fs_write","args":{"path":"/project/blocked.md","content":"I need a credential to proceed."},"predicted_outcome":"ask recorded","reason":"formal ask"}\n```',
      // turn 3: summarize the ask
      'I cannot complete the work without a credential. I have recorded the ask in /project/blocked.md.',
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
        return auditCalls === 1 ? importantAudit() : silentAudit()
      },
    })
    const task = newPendingTask({
      id: newTaskId(),
      agent: 'hobby',
      title: 'demo',
      body: 'do something needing a credential',
      idempotency: 'destructive',
    })
    await taskStore.save(task)
    const r = await loop.run(task)
    expect(r.kind).toBe('done')
    if (r.kind === 'done') {
      // turn1 + kickback + tool turn + summarize = 3 iterations
      expect(r.iterations).toBe(3)
      expect(r.audit_kickbacks).toBe(1)
      expect(r.claim_audit?.severity).toBe('silent')
      expect(r.summary).toContain('cannot complete')
    }
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
