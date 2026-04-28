/**
 * Tests for the AgentLoop: parse tool blocks, run a happy-path task,
 * fire detectors mid-loop, surface tool failures back to the model.
 *
 * Uses a fake LLM provider that returns scripted responses so tests can
 * deterministically simulate model behavior. The dispatcher and tool
 * registry are real; the loop's interaction with them is verified
 * end-to-end (dispatcher writes plan/run/perm records to the brain dir,
 * the loop reads back the result via history).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop, hashArgs, parseToolCalls } from '../../../src/runtime/agent/loop.js'
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
  home = await mkdtemp(join(tmpdir(), '2200-loop-'))
  await initHome(home)
  // Bootstrap an Identity file at a temp source path, then copy it in so
  // initAgentDirs can take its canonical place at <home>/agents/hobby/identity.md.
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

You are hobby, the test agent.
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
  private idx = 0
  constructor(private readonly script: CompletionResponse[]) {}
  complete(): Promise<CompletionResponse> {
    const r = this.script[this.idx]
    if (!r) {
      throw new Error(
        `FakeProvider exhausted at call ${String(this.idx)}; provide more script entries`,
      )
    }
    this.idx += 1
    return Promise.resolve(r)
  }
}

function fakeIdentity(): IdentityRecord {
  return {
    source_path: '/unused-at-test',
    frontmatter: {
      schema_version: 4,
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
    },
    body: 'You are hobby, the test agent.',
  }
}

function makeDispatcher(): { dispatcher: ToolDispatcher; registry: ToolRegistry } {
  const registry = new ToolRegistry()
  for (const server of baselineServers()) {
    registry.register(server)
  }
  const ap = agentPaths(home, 'hobby')
  const dispatcher = new ToolDispatcher({
    registry,
    allowedToolNames: new Set(BASELINE_TOOL_NAMES),
    home,
    callingAgent: 'hobby',
    brainDir: ap.brain,
    projectDir: ap.project,
  })
  return { dispatcher, registry }
}

function fakeResponse(text: string, cost = 0): CompletionResponse {
  return {
    text,
    finishReason: 'stop',
    costMetrics: { inputTokens: 100, outputTokens: 50, estDollars: cost },
  }
}

describe('parseToolCalls', () => {
  it('extracts a single tool block', () => {
    const text = 'Reading the file...\n```tool\n{"tool":"fs.read","args":{"path":"/x"}}\n```'
    const r = parseToolCalls(text)
    expect(r.calls.length).toBe(1)
    expect(r.calls[0]?.tool).toBe('fs.read')
    expect(r.errors.length).toBe(0)
  })

  it('extracts multiple blocks in order', () => {
    const text =
      '```tool\n{"tool":"fs.read","args":{"path":"/a"}}\n```\nthen\n```tool\n{"tool":"fs.write","args":{"path":"/b","content":"x"}}\n```'
    const r = parseToolCalls(text)
    expect(r.calls.map((c) => c.tool)).toEqual(['fs.read', 'fs.write'])
  })

  it('returns errors on bad JSON', () => {
    const text = '```tool\nnot-json\n```'
    const r = parseToolCalls(text)
    expect(r.calls.length).toBe(0)
    expect(r.errors.length).toBe(1)
  })

  it('returns errors on schema mismatch', () => {
    const text = '```tool\n{"args":{}}\n```'
    const r = parseToolCalls(text)
    expect(r.calls.length).toBe(0)
    expect(r.errors.length).toBe(1)
  })

  it('returns no calls and no errors on empty response', () => {
    const r = parseToolCalls('Just a final answer with no tool blocks.')
    expect(r.calls.length).toBe(0)
    expect(r.errors.length).toBe(0)
  })

  it('falls back to <function_calls> XML with tool name in the invoke', () => {
    // Native Anthropic-style: <invoke name="<actual tool>">.
    const text = [
      '<function_calls>',
      '<invoke name="pub.read">',
      '<parameter name="args">{"pub_name": "ops"}</parameter>',
      '<parameter name="predicted_outcome">recent messages</parameter>',
      '<parameter name="reason">need context</parameter>',
      '</invoke>',
      '</function_calls>',
    ].join('\n')
    const r = parseToolCalls(text)
    expect(r.errors).toEqual([])
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0]?.tool).toBe('pub.read')
    expect(r.calls[0]?.args).toEqual({ pub_name: 'ops' })
    expect(r.calls[0]?.predicted_outcome).toBe('recent messages')
  })

  it('falls back to <function_calls> XML with tool name in a "tool" parameter', () => {
    // Claude-Code-trained Haiku reflex: <invoke name="tool_code"> with the
    // real tool nested as a parameter.
    const text = [
      '<function_calls>',
      '<invoke name="tool_code">',
      '<parameter name="tool">pub.send</parameter>',
      '<parameter name="args">{"pub_name": "ops", "content": "hi"}</parameter>',
      '<parameter name="predicted_outcome">delivered</parameter>',
      '<parameter name="reason">replying</parameter>',
      '</invoke>',
      '</function_calls>',
    ].join('\n')
    const r = parseToolCalls(text)
    expect(r.errors).toEqual([])
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0]?.tool).toBe('pub.send')
    expect(r.calls[0]?.args).toEqual({ pub_name: 'ops', content: 'hi' })
  })

  it('parses both fenced and XML calls in the same response, fenced first', () => {
    const text = [
      '```tool',
      '{"tool":"pub.read","args":{"pub_name":"ops"}}',
      '```',
      'Then I want to send:',
      '<function_calls>',
      '<invoke name="pub.send">',
      '<parameter name="args">{"pub_name": "ops", "content": "hi"}</parameter>',
      '</invoke>',
      '</function_calls>',
    ].join('\n')
    const r = parseToolCalls(text)
    expect(r.errors).toEqual([])
    expect(r.calls.map((c) => c.tool)).toEqual(['pub.read', 'pub.send'])
  })

  it('reports errors on XML blocks with malformed args JSON', () => {
    const text = [
      '<function_calls>',
      '<invoke name="pub.read">',
      '<parameter name="args">not-json</parameter>',
      '</invoke>',
      '</function_calls>',
    ].join('\n')
    const r = parseToolCalls(text)
    expect(r.calls).toHaveLength(0)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toContain('xml tool block args JSON parse failed')
  })
})

describe('hashArgs', () => {
  it('is stable across key order', () => {
    const a = hashArgs('fs.read', { path: '/a', max_bytes: 100 })
    const b = hashArgs('fs.read', { max_bytes: 100, path: '/a' })
    expect(a).toBe(b)
  })

  it('differs across tool names', () => {
    const a = hashArgs('fs.read', { path: '/a' })
    const b = hashArgs('fs.write', { path: '/a' })
    expect(a).not.toBe(b)
  })
})

describe('AgentLoop model selection (followup_model_id)', () => {
  class CapturingProvider implements LLMProvider {
    readonly name = 'fake'
    readonly baseUrl = 'http://fake'
    readonly modelIdsSeen: string[] = []
    private idx = 0
    constructor(private readonly script: CompletionResponse[]) {}
    complete(req: { modelId: string }): Promise<CompletionResponse> {
      this.modelIdsSeen.push(req.modelId)
      const r = this.script[this.idx]
      if (!r) throw new Error('script exhausted')
      this.idx += 1
      return Promise.resolve(r)
    }
  }

  it('uses model_id for iteration 1 and followup_model_id for iterations 2+', async () => {
    const { dispatcher } = makeDispatcher()
    const taskStore = new TaskStore(home, 'hobby')
    const ap = agentPaths(home, 'hobby')
    await mkdir(ap.project, { recursive: true })

    const provider = new CapturingProvider([
      fakeResponse(
        '```tool\n{"tool":"fs.write","args":{"path":"/project/x.md","content":"y"},"predicted_outcome":"ok","reason":"x"}\n```',
      ),
      fakeResponse(
        '```tool\n{"tool":"fs.write","args":{"path":"/project/y.md","content":"y"},"predicted_outcome":"ok","reason":"x"}\n```',
      ),
      fakeResponse('Done.'),
    ])

    const identity = fakeIdentity()
    identity.frontmatter.model = {
      tier: 'frontier',
      provider: 'deepseek',
      model_id: 'deepseek-chat',
      followup_model_id: 'deepseek-reasoner',
    }
    const loop = new AgentLoop({
      identity,
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
      title: 't',
      body: 'do work',
      idempotency: 'checkpointed',
      priority: 0,
    })

    await loop.run(task)
    expect(provider.modelIdsSeen).toEqual([
      'deepseek-chat',
      'deepseek-reasoner',
      'deepseek-reasoner',
    ])
  })

  it('falls back to model_id for all iterations when followup_model_id is not set', async () => {
    const { dispatcher } = makeDispatcher()
    const taskStore = new TaskStore(home, 'hobby')
    const ap = agentPaths(home, 'hobby')
    await mkdir(ap.project, { recursive: true })

    const provider = new CapturingProvider([
      fakeResponse(
        '```tool\n{"tool":"fs.write","args":{"path":"/project/a.md","content":"y"},"predicted_outcome":"ok","reason":"x"}\n```',
      ),
      fakeResponse('Done.'),
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
      title: 't',
      body: 'do work',
      idempotency: 'checkpointed',
      priority: 0,
    })

    await loop.run(task)
    expect(provider.modelIdsSeen).toEqual(['claude-opus-4-7', 'claude-opus-4-7'])
  })
})

describe('AgentLoop happy path', () => {
  it('runs a task that uses fs.write and then a final answer', async () => {
    const { dispatcher } = makeDispatcher()
    const taskStore = new TaskStore(home, 'hobby')
    const ap = agentPaths(home, 'hobby')

    // Pre-create the project dir so fs.write can land.
    await mkdir(ap.project, { recursive: true })

    const provider = new FakeProvider([
      fakeResponse(
        'Writing a file.\n```tool\n{"tool":"fs.write","args":{"path":"/project/note.md","content":"hello"},"predicted_outcome":"file written","reason":"persist"}\n```',
        0.01,
      ),
      fakeResponse('Done. Wrote note.md.', 0.005),
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
      title: 'write note',
      body: 'Write hello to /project/note.md and then summarize.',
      idempotency: 'checkpointed',
    })
    await taskStore.save(task)

    const result = await loop.run(task)
    expect(result.kind).toBe('done')
    if (result.kind === 'done') {
      expect(result.summary).toContain('Done')
      expect(result.iterations).toBe(2)
    }

    // The file actually landed.
    const written = await readFile(join(ap.project, 'note.md'), 'utf8')
    expect(written).toBe('hello')
  })

  it('terminates immediately on a response with no tool blocks', async () => {
    const { dispatcher } = makeDispatcher()
    const taskStore = new TaskStore(home, 'hobby')
    const ap = agentPaths(home, 'hobby')
    const provider = new FakeProvider([fakeResponse('Final answer immediately.')])
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
      title: 't',
      body: 'just answer',
    })
    await taskStore.save(task)
    const r = await loop.run(task)
    expect(r.kind).toBe('done')
    if (r.kind === 'done') expect(r.iterations).toBe(1)
  })
})

describe('AgentLoop telemetry integration', () => {
  it('appends one JSONL telemetry record per model call when a TelemetryWriter is configured', async () => {
    const { dispatcher } = makeDispatcher()
    const taskStore = new TaskStore(home, 'hobby')
    const ap = agentPaths(home, 'hobby')
    const { TelemetryWriter } = await import('../../../src/runtime/telemetry/writer.js')
    const writer = new TelemetryWriter(home, 'hobby')

    const provider = new FakeProvider([fakeResponse('Done in one shot.')])
    const fixedTime = new Date('2026-04-28T12:00:00.000Z')
    const loop = new AgentLoop({
      identity: fakeIdentity(),
      provider,
      dispatcher,
      taskStore,
      home,
      brainDir: ap.brain,
      availableToolNames: BASELINE_TOOL_NAMES,
      telemetryWriter: writer,
      now: () => fixedTime,
    })
    const task = newPendingTask({
      id: newTaskId(),
      agent: 'hobby',
      title: 't',
      body: 'one shot',
    })
    await taskStore.save(task)
    await loop.run(task)

    const path = join(home, 'state', 'telemetry', 'hobby', '2026-04-28.jsonl')
    const text = await readFile(path, 'utf8')
    const records = text
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(records).toHaveLength(1)
    const r = records[0]!
    expect(r['agent_id']).toBe('hobby')
    expect(r['provider']).toBe('anthropic')
    expect(r['model_id']).toBe('claude-opus-4-7')
    expect(r['status']).toBe('ok')
    expect(r['input_tokens']).toBe(100)
    expect(r['output_tokens']).toBe(50)
    // Default pricing computes 100/1M * $15 + 50/1M * $75 = $0.00525.
    expect(r['cost_usd']).toBeCloseTo(0.00525, 6)
    expect(r['task_id']).toBe(task.frontmatter.id)
  })

  it('records an error-status telemetry record when complete() throws', async () => {
    const { dispatcher } = makeDispatcher()
    const taskStore = new TaskStore(home, 'hobby')
    const ap = agentPaths(home, 'hobby')
    const { TelemetryWriter } = await import('../../../src/runtime/telemetry/writer.js')
    const writer = new TelemetryWriter(home, 'hobby')

    class ThrowingProvider implements LLMProvider {
      readonly name = 'fake'
      readonly baseUrl = 'http://fake'
      complete(): Promise<CompletionResponse> {
        return Promise.reject(new Error('simulated network failure'))
      }
    }
    const fixedTime = new Date('2026-04-28T12:00:00.000Z')
    const loop = new AgentLoop({
      identity: fakeIdentity(),
      provider: new ThrowingProvider(),
      dispatcher,
      taskStore,
      home,
      brainDir: ap.brain,
      availableToolNames: BASELINE_TOOL_NAMES,
      telemetryWriter: writer,
      now: () => fixedTime,
    })
    const task = newPendingTask({
      id: newTaskId(),
      agent: 'hobby',
      title: 't',
      body: 'will fail',
    })
    await taskStore.save(task)
    const result = await loop.run(task)
    expect(result.kind).toBe('errored')

    const path = join(home, 'state', 'telemetry', 'hobby', '2026-04-28.jsonl')
    const text = await readFile(path, 'utf8')
    const records = text
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(records).toHaveLength(1)
    expect(records[0]!['status']).toBe('error')
    expect(records[0]!['cost_usd']).toBeNull()
    expect(records[0]!['input_tokens']).toBe(0)
  })
})

describe('AgentLoop detector trips', () => {
  it('fires tool_repetition after N identical fs.read calls', async () => {
    const { dispatcher } = makeDispatcher()
    const taskStore = new TaskStore(home, 'hobby')
    const ap = agentPaths(home, 'hobby')

    // Place a target file the model can read.
    await mkdir(ap.project, { recursive: true })
    await writeFile(join(ap.project, 'target.md'), 'content')

    // Script the model to call fs.read with identical args every time.
    const script: CompletionResponse[] = []
    for (let i = 0; i < 6; i++) {
      script.push(
        fakeResponse(
          '```tool\n{"tool":"fs.read","args":{"path":"/project/target.md"},"predicted_outcome":"read","reason":"r"}\n```',
        ),
      )
    }

    const provider = new FakeProvider(script)
    const loop = new AgentLoop({
      identity: fakeIdentity(),
      provider,
      dispatcher,
      taskStore,
      home,
      brainDir: ap.brain,
      availableToolNames: BASELINE_TOOL_NAMES,
      thresholds: {
        tool_repetition_n: 5,
        no_progress_iterations: 1000,
        tool_timeout_ms: 1_000_000,
        cost_burst_window_ms: 600_000,
        cost_burst_usd: 1000,
        error_storm_n: 1000,
      },
    })
    const task = newPendingTask({
      id: newTaskId(),
      agent: 'hobby',
      title: 'loopy',
      body: 'read the file',
      idempotency: 'pure',
    })
    await taskStore.save(task)

    const result = await loop.run(task)
    expect(result.kind).toBe('tripped')
    if (result.kind === 'tripped') {
      expect(result.verdict.kind).toBe('tool_repetition')
      // Trip record should be on disk.
      const tripRaw = await readFile(result.trip.trip_path, 'utf8')
      expect(tripRaw).toContain('tool_repetition')
      // Task should be flipped to blocked_on_detector with detector_block context.
      const refreshed = await taskStore.get(task.frontmatter.id)
      expect(refreshed?.frontmatter.state).toBe('blocked_on_detector')
      expect(refreshed?.frontmatter.detector_block?.kind).toBe('tool_repetition')
    }
  })

  it('feeds dispatch failure back into the model history without crashing', async () => {
    const { dispatcher } = makeDispatcher()
    const taskStore = new TaskStore(home, 'hobby')
    const ap = agentPaths(home, 'hobby')
    const provider = new FakeProvider([
      // First turn: try to read a non-existent file.
      fakeResponse(
        '```tool\n{"tool":"fs.read","args":{"path":"/project/missing.md"},"predicted_outcome":"text","reason":"r"}\n```',
      ),
      // Second turn: model recovers, gives a final answer.
      fakeResponse('I tried to read but the file was missing. Stopping.'),
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
      title: 't',
      body: 'try to read missing',
    })
    await taskStore.save(task)
    const r = await loop.run(task)
    expect(r.kind).toBe('done')
  })

  it('respects max_iterations as a safety belt', async () => {
    const { dispatcher } = makeDispatcher()
    const taskStore = new TaskStore(home, 'hobby')
    const ap = agentPaths(home, 'hobby')
    await mkdir(ap.project, { recursive: true })
    await writeFile(join(ap.project, 'a.md'), 'a')

    // Each turn calls fs.read with a different arg so tool_repetition does not
    // fire; loop relies on the maxIterations belt to terminate.
    const script: CompletionResponse[] = []
    for (let i = 0; i < 10; i++) {
      script.push(
        fakeResponse(
          `\`\`\`tool\n{"tool":"fs.read","args":{"path":"/project/a.md","max_bytes":${String(i + 1)}},"predicted_outcome":"text","reason":"r"}\n\`\`\``,
        ),
      )
    }
    const provider = new FakeProvider(script)
    const loop = new AgentLoop({
      identity: fakeIdentity(),
      provider,
      dispatcher,
      taskStore,
      home,
      brainDir: ap.brain,
      availableToolNames: BASELINE_TOOL_NAMES,
      maxIterations: 3,
    })
    const task = newPendingTask({ id: newTaskId(), agent: 'hobby', title: 't', body: 'read' })
    await taskStore.save(task)
    const r = await loop.run(task)
    expect(r.kind).toBe('tripped')
    if (r.kind === 'tripped') {
      expect(r.verdict.kind).toBe('no_progress')
      expect(r.verdict.detail).toContain('max iterations')
    }
  })
})
