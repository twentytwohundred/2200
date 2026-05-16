/**
 * Integration tests for the planning-only retry wired into AgentLoop.
 *
 * The unit tests in `incomplete-turn.test.ts` cover the resolver in
 * isolation. These tests reproduce the live failure pattern from
 * 2026-05-11/12 ... an agent narrates work without performing it ...
 * and verify the loop catches it, injects the directive, and gives
 * the model a second chance to call tools.
 *
 * Reference: wiki/decisions/2026-05-12-incomplete-turn-detector.md
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../../../src/runtime/agent/loop.js'
import { TaskStore } from '../../../src/runtime/agent/task/store.js'
import { newPendingTask } from '../../../src/runtime/agent/task/types.js'
import { newTaskId } from '../../../src/runtime/util/id.js'
import { ToolDispatcher } from '../../../src/runtime/tools/dispatcher.js'
import { ToolRegistry } from '../../../src/runtime/mcp/registry.js'
import { BASELINE_TOOL_NAMES, baselineServers } from '../../../src/runtime/tools/baseline/index.js'
import { initHome, initAgentDirs } from '../../../src/runtime/storage/init.js'
import { agentPaths } from '../../../src/runtime/storage/layout.js'
import type { LLMProvider } from '../../../src/runtime/llm/provider.js'
import type { CompletionResponse } from '../../../src/runtime/llm/types.js'
import type { IdentityRecord } from '../../../src/runtime/identity/types.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-incomplete-turn-'))
  await initHome(home)
  const idSrc = join(home, '_seed_identity.md')
  await writeFile(
    idSrc,
    `---
schema_version: 1
agent_name: hobby
agent_role: build agent
model:
  tier: frontier
  provider: anthropic
  model_id: claude-opus-4-7
tools: []
project_dir: /unused-at-test
brain_dir: /unused-at-test
created: 2026-04-26
---

# Identity

You are hobby.
`,
  )
  await initAgentDirs(home, 'hobby', idSrc)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

class FakeProvider implements LLMProvider {
  readonly name = 'fake'
  readonly baseUrl = 'http://fake'
  callCount = 0
  constructor(private readonly script: CompletionResponse[]) {}
  complete(): Promise<CompletionResponse> {
    const r = this.script[this.callCount]
    if (!r) {
      throw new Error(
        `FakeProvider exhausted at call ${String(this.callCount)}; provide more script entries`,
      )
    }
    this.callCount += 1
    return Promise.resolve(r)
  }
}

function fakeIdentity(): IdentityRecord {
  return {
    source_path: '/unused-at-test',
    frontmatter: {
      schema_version: 5,
      agent_name: 'hobby',
      agent_role: 'build agent',
      model: {
        tier: 'frontier',
        provider: 'anthropic',
        model_id: 'claude-opus-4-7',
      },
      tools: [],
      project_dir: '/unused-at-test',
      brain_dir: '/unused-at-test',
      created: '2026-04-26',
      cost_caps: {
        daily_usd: 10,
        warn_at_pct: 80,
        reset_at: '00:00 UTC',
        on_breach: 'block_new_tasks',
      },
      notification_policy: {
        tiers_allowed: ['passive', 'normal', 'important'],
      },
      mcp_servers: [],
      connectors: [],
    },
    body: 'You are hobby.',
  }
}

function makeDispatcher(): ToolDispatcher {
  const registry = new ToolRegistry()
  for (const server of baselineServers()) {
    registry.register(server)
  }
  const ap = agentPaths(home, 'hobby')
  return new ToolDispatcher({
    registry,
    allowedToolNames: new Set(BASELINE_TOOL_NAMES),
    home,
    callingAgent: 'hobby',
    brainDir: ap.brain,
    projectDir: ap.project,
  })
}

function fakeResponse(text: string): CompletionResponse {
  return {
    text,
    finishReason: 'stop',
    costMetrics: { inputTokens: 100, outputTokens: 50, estDollars: 0.001 },
  }
}

describe('AgentLoop planning-only retry integration', () => {
  it("recovers when the model narrates 'I'll check and report back' without tool calls", async () => {
    // Scripted pattern that reproduces the live 2026-05-11 failure shape:
    //   1. The model responds with planning-only prose, no tool calls.
    //   2. The loop should detect this, append the act-now directive
    //      to history, and call the model again.
    //   3. On the retry the model is expected to dispatch a tool call.
    //   4. After the tool result lands, the model produces a real answer.
    const dispatcher = makeDispatcher()
    const taskStore = new TaskStore(home, 'hobby')
    const ap = agentPaths(home, 'hobby')

    const provider = new FakeProvider([
      // Iteration 1: planning-only prose ... the failure pattern.
      fakeResponse("I'll check the brain notes and report back."),
      // Iteration 2 (post-retry): the model now dispatches a real tool call.
      fakeResponse(
        '```tool\n{"tool":"brain_list","args":{},"predicted_outcome":"list brain notes","reason":"answering the operator"}\n```',
      ),
      // Iteration 3: substantive final answer after the tool result.
      fakeResponse('I read the brain. There are no notes yet ... fresh agent home.'),
    ])

    const loop = new AgentLoop({
      identity: fakeIdentity(),
      provider,
      dispatcher,
      taskStore,
      home,
      brainDir: ap.brain,
      availableToolNames: BASELINE_TOOL_NAMES,
    })

    const task = newPendingTask({
      id: newTaskId(),
      agent: 'hobby',
      title: 'status check',
      body: "What's the status of the brain notes? Can you check and tell me?",
    })
    await taskStore.save(task)

    const result = await loop.run(task)

    expect(result.kind).toBe('done')
    if (result.kind === 'done') {
      // 3 model calls: original + post-retry + final answer.
      expect(result.iterations).toBe(3)
      // The summary is the substantive answer, not the planning-only stall.
      expect(result.summary).toContain('no notes yet')
      // No audit flag fired (the task didn't end with zero tool calls).
      expect(result.audit_flags).toEqual([])
    }
    expect(provider.callCount).toBe(3)
  })

  it('stops retrying after the budget is exhausted', async () => {
    // The model keeps producing planning-only text on every retry. The
    // loop should fire the retry 3 times (the default budget), then
    // accept the response as final on the 4th attempt to avoid an
    // infinite loop. The audit flag fires because this was an actionable
    // request that completed with zero successful tool calls.
    const dispatcher = makeDispatcher()
    const taskStore = new TaskStore(home, 'hobby')
    const ap = agentPaths(home, 'hobby')

    const persistentlyPlanningOnly = "I'll check the logs and report back shortly."
    const provider = new FakeProvider([
      fakeResponse(persistentlyPlanningOnly),
      fakeResponse(persistentlyPlanningOnly),
      fakeResponse(persistentlyPlanningOnly),
      fakeResponse(persistentlyPlanningOnly),
    ])

    const loop = new AgentLoop({
      identity: fakeIdentity(),
      provider,
      dispatcher,
      taskStore,
      home,
      brainDir: ap.brain,
      availableToolNames: BASELINE_TOOL_NAMES,
    })

    const task = newPendingTask({
      id: newTaskId(),
      agent: 'hobby',
      title: 'log check',
      body: 'Please check the logs and summarize anything unusual.',
      idempotency: 'destructive',
    })
    await taskStore.save(task)

    const result = await loop.run(task)

    expect(result.kind).toBe('done')
    if (result.kind === 'done') {
      // 4 model calls: original + 3 retries (the budget).
      expect(result.iterations).toBe(4)
      expect(result.summary).toBe(persistentlyPlanningOnly)
      // Audit flag fires because this destructive task ended with zero tool calls.
      expect(result.audit_flags).toHaveLength(1)
      expect(result.audit_flags[0]?.kind).toBe('narrated_completion_without_tool_call')
    }
    expect(provider.callCount).toBe(4)
  })

  it('does not retry when the agent already made a successful tool call this task', async () => {
    // After the agent has done real work (a successful tool call),
    // treat a subsequent text-only "I'll do X next" turn as a
    // legitimate stopping point rather than planning-only. This is
    // the conservative cumulative-side-effects guard.
    const dispatcher = makeDispatcher()
    const taskStore = new TaskStore(home, 'hobby')
    const ap = agentPaths(home, 'hobby')

    const provider = new FakeProvider([
      // Iteration 1: agent does real work.
      fakeResponse(
        '```tool\n{"tool":"brain_list","args":{},"predicted_outcome":"list brain","reason":"checking"}\n```',
      ),
      // Iteration 2: planning-only text. Should NOT trigger retry because
      // the prior successful tool call sets `priorSuccessfulToolCallsThisTask > 0`.
      fakeResponse("I'll write up a summary of what I found next."),
    ])

    const loop = new AgentLoop({
      identity: fakeIdentity(),
      provider,
      dispatcher,
      taskStore,
      home,
      brainDir: ap.brain,
      availableToolNames: BASELINE_TOOL_NAMES,
    })

    const task = newPendingTask({
      id: newTaskId(),
      agent: 'hobby',
      title: 'summarize brain',
      body: 'Can you check the brain and summarize what you find?',
    })
    await taskStore.save(task)

    const result = await loop.run(task)

    expect(result.kind).toBe('done')
    if (result.kind === 'done') {
      // 2 iterations only: brain_list + planning-only-but-allowed text.
      expect(result.iterations).toBe(2)
      expect(result.summary).toContain('write up a summary')
    }
    // Exactly 2 provider calls; no retry was injected.
    expect(provider.callCount).toBe(2)
  })

  it('does not retry on a non-actionable user message', async () => {
    // The user message is a bare ack; the model is allowed to end
    // the conversation with planning-only prose. The detector should
    // recognize this and not retry.
    const dispatcher = makeDispatcher()
    const taskStore = new TaskStore(home, 'hobby')
    const ap = agentPaths(home, 'hobby')

    const provider = new FakeProvider([fakeResponse("I'll be around if you need anything else.")])

    const loop = new AgentLoop({
      identity: fakeIdentity(),
      provider,
      dispatcher,
      taskStore,
      home,
      brainDir: ap.brain,
      availableToolNames: BASELINE_TOOL_NAMES,
    })

    const task = newPendingTask({
      id: newTaskId(),
      agent: 'hobby',
      title: 'ack',
      body: 'thanks',
    })
    await taskStore.save(task)

    const result = await loop.run(task)

    expect(result.kind).toBe('done')
    if (result.kind === 'done') {
      expect(result.iterations).toBe(1)
    }
    expect(provider.callCount).toBe(1)
  })
})
