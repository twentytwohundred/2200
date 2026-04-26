/**
 * End-to-end test for the task pipe: AgentProcess polls the task store,
 * picks up a pending task, runs the loop with a scripted fake provider,
 * writes the outcome back to the task on disk.
 *
 * This is the full vertical slice for Epic 2's "Done When" criterion:
 *
 *   "An Agent can complete a non-trivial task end-to-end (suggested:
 *    'read the wiki/01-vision.md file from disk, summarize it to
 *    brain.write, then exit') with full plan/run/perm records on disk"
 *
 * We do not run a real supervisor here — that adds UDS plumbing without
 * exercising any new code path. The AgentProcess can be constructed
 * directly with a fake connection (the existing supervisor-uds suite covers
 * the UDS roundtrip). The end-to-end pipe we care about is:
 *
 *   task.save() -> poll picks it up -> loop runs -> task.update(done)
 *      with plan/run/perm records on disk
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentProcess } from '../../../src/runtime/agent/process.js'
import { TaskStore } from '../../../src/runtime/agent/task/store.js'
import { newPendingTask } from '../../../src/runtime/agent/task/types.js'
import { newTaskId } from '../../../src/runtime/util/id.js'
import { initHome, initAgentDirs } from '../../../src/runtime/storage/init.js'
import { agentPaths } from '../../../src/runtime/storage/layout.js'
import type { Connection } from '../../../src/runtime/control-plane/transport.js'
import type { LLMProvider } from '../../../src/runtime/llm/provider.js'
import type { CompletionResponse } from '../../../src/runtime/llm/types.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-e2e-'))
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
project_dir: /unused
brain_dir: /unused
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
  private idx = 0
  constructor(private readonly script: CompletionResponse[]) {}
  complete(): Promise<CompletionResponse> {
    const r = this.script[this.idx]
    if (!r) throw new Error('FakeProvider exhausted')
    this.idx += 1
    return Promise.resolve(r)
  }
}

/**
 * A no-op connection that satisfies the AgentProcess registration without a
 * real supervisor. The control-plane RPC is exercised in supervisor-uds.test.ts;
 * the end-to-end test here is about the local task pipe (poll -> loop ->
 * outcome on disk), not the supervisor RPC.
 *
 * Behavior: any outgoing message gets a synthetic JSON-RPC success response
 * matched by id. agent.register returns {accepted:true}; everything else
 * returns {ack:true}.
 */
function fakeConnection(): Connection {
  const incoming: string[] = []
  let resolveNext: ((line: string) => void) | undefined
  let isClosed = false

  function pushIncoming(line: string): void {
    if (resolveNext) {
      const r = resolveNext
      resolveNext = undefined
      r(line)
    } else {
      incoming.push(line)
    }
  }

  const conn: Connection = {
    write(line) {
      const parsed = JSON.parse(line) as { id?: number | string; method?: string }
      if (parsed.id === undefined) return Promise.resolve()
      const reply = {
        jsonrpc: '2.0' as const,
        id: parsed.id,
        result: parsed.method === 'agent.register' ? { accepted: true } : { ack: true as const },
      }
      setImmediate(() => {
        pushIncoming(JSON.stringify(reply))
      })
      return Promise.resolve()
    },
    read(): AsyncIterable<string> {
      return {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<string>> {
              if (incoming.length > 0) {
                const value = incoming.shift()
                if (value !== undefined) {
                  return Promise.resolve({ value, done: false })
                }
              }
              if (isClosed) return Promise.resolve({ value: undefined, done: true })
              return new Promise<string>((resolve) => {
                resolveNext = resolve
              }).then((value) => ({ value, done: false }))
            },
          }
        },
      }
    },
    close() {
      isClosed = true
      if (resolveNext) {
        const r = resolveNext
        resolveNext = undefined
        // Sentinel "" means EOF for the consumer; the client treats parse
        // failures as errors, but the agent shutdown path catches them.
        r('')
      }
      return Promise.resolve()
    },
    get closed() {
      return isClosed
    },
  }
  return conn
}

describe('end-to-end: submit -> poll -> loop -> done', () => {
  it('runs a happy-path task and persists the outcome', async () => {
    const ap = agentPaths(home, 'hobby')
    await mkdir(ap.project, { recursive: true })
    await writeFile(join(ap.project, 'input.md'), 'INPUT_CONTENT')

    const provider = new FakeProvider([
      {
        text: '```tool\n{"tool":"fs.read","args":{"path":"/project/input.md"},"predicted_outcome":"text","reason":"reading input"}\n```',
        finishReason: 'stop',
        costMetrics: { inputTokens: 50, outputTokens: 30, estDollars: 0.001 },
      },
      {
        text: 'I read the file. INPUT_CONTENT noted. Done.',
        finishReason: 'stop',
        costMetrics: { inputTokens: 80, outputTokens: 30, estDollars: 0.001 },
      },
    ])

    // Submit the task before starting the agent so the first poll picks it up.
    const taskStore = new TaskStore(home, 'hobby')
    const task = newPendingTask({
      id: newTaskId(),
      agent: 'hobby',
      title: 'read input',
      body: 'Read /project/input.md and tell me what is in it.',
      idempotency: 'pure',
    })
    await taskStore.save(task)

    const agent = new AgentProcess({
      name: 'hobby',
      identityPath: join(ap.root, 'identity.md'),
      socketPath: '/unused',
      home,
      connection: fakeConnection(),
      provider,
      heartbeatIntervalMs: 999_999,
      taskPollIntervalMs: 50,
    })
    await agent.start()

    // Wait for the task to reach a terminal state. Poll the on-disk record.
    let final
    for (let i = 0; i < 100; i++) {
      const r = await taskStore.get(task.frontmatter.id)
      if (r && (r.frontmatter.state === 'done' || r.frontmatter.state === 'errored')) {
        final = r
        break
      }
      await new Promise((res) => setTimeout(res, 50))
    }
    await agent.shutdown('test')

    expect(final).toBeDefined()
    expect(final?.frontmatter.state).toBe('done')
    expect(final?.frontmatter.outcome?.summary).toContain('Done')
    expect(final?.frontmatter.outcome?.iterations).toBe(2)

    // Plan/run/perm records landed on disk.
    const planDir = join(ap.brain, '.records', 'plan', task.frontmatter.id)
    const runDir = join(ap.brain, '.records', 'run', task.frontmatter.id)
    const permDir = join(ap.brain, '.records', 'perm', task.frontmatter.id)
    const planEntries = await readdir(planDir)
    const runEntries = await readdir(runDir)
    const permEntries = await readdir(permDir)
    expect(planEntries.length).toBeGreaterThanOrEqual(1)
    expect(runEntries.length).toBeGreaterThanOrEqual(1)
    expect(permEntries.length).toBeGreaterThanOrEqual(1)
    const aRun = await readFile(join(runDir, runEntries[0]!), 'utf8')
    expect(aRun).toContain('schema_version: 1')
    expect(aRun).toContain('tool: fs.read')
  })

  it('marks the task blocked_on_detector when a trip fires', async () => {
    const ap = agentPaths(home, 'hobby')
    await mkdir(ap.project, { recursive: true })
    await writeFile(join(ap.project, 'input.md'), 'A')

    // Script the provider to call the same tool 5 times consecutively.
    const script: CompletionResponse[] = []
    for (let i = 0; i < 6; i++) {
      script.push({
        text: '```tool\n{"tool":"fs.read","args":{"path":"/project/input.md"},"predicted_outcome":"text","reason":"r"}\n```',
        finishReason: 'stop',
        costMetrics: { inputTokens: 50, outputTokens: 20, estDollars: 0.001 },
      })
    }
    const provider = new FakeProvider(script)

    const taskStore = new TaskStore(home, 'hobby')
    const task = newPendingTask({
      id: newTaskId(),
      agent: 'hobby',
      title: 'loopy',
      body: 'read repeatedly',
      idempotency: 'pure',
    })
    await taskStore.save(task)

    const agent = new AgentProcess({
      name: 'hobby',
      identityPath: join(ap.root, 'identity.md'),
      socketPath: '/unused',
      home,
      connection: fakeConnection(),
      provider,
      heartbeatIntervalMs: 999_999,
      taskPollIntervalMs: 50,
    })
    await agent.start()

    let final
    for (let i = 0; i < 100; i++) {
      const r = await taskStore.get(task.frontmatter.id)
      if (r?.frontmatter.state === 'blocked_on_detector') {
        final = r
        break
      }
      await new Promise((res) => setTimeout(res, 50))
    }
    await agent.shutdown('test')

    expect(final).toBeDefined()
    expect(final?.frontmatter.state).toBe('blocked_on_detector')
    expect(final?.frontmatter.detector_block?.kind).toBe('tool_repetition')
  })
})
