/**
 * End-to-end reproduction of the "Agent goes dark after a successful
 * relay" bug.
 *
 * The operator asked Skippy to ask Jodin a question. Skippy parked on
 * `task_await_response`, Jodin replied, the task resumed and completed
 * ... and Skippy went on reporting `blocked_on_agent` indefinitely.
 * Healthy and idle, dark in the fleet view, only recoverable with an
 * explicit stop+start.
 *
 * The unit tests in blocked-state-clearing.test.ts pin the state
 * machine's transition table. This one drives the whole pipe ... park,
 * resume, complete ... and asserts on what the Agent actually TELLS the
 * supervisor afterwards, because the heartbeat is the only thing the
 * operator's fleet view ever sees. A machine that is internally correct
 * but still reporting a stale block would pass the unit tests and
 * reproduce the outage.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

const IDENTITY = `---
schema_version: 1
agent_name: skippy
agent_role: ops agent
model:
  tier: frontier
  provider: anthropic
  model_id: claude-opus-4-7
tools: []
project_dir: /unused
brain_dir: /unused
created: 2026-07-24
---

# Identity
You are skippy.
`

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-blocked-'))
  await initHome(home)
  const src = join(home, '_seed_identity.md')
  await writeFile(src, IDENTITY, 'utf8')
  await initAgentDirs(home, 'skippy', src)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

/**
 * The end-to-end suite's fake connection, with one addition: every
 * `agent.heartbeat` the process sends is recorded. The heartbeat is the
 * only channel through which the supervisor ... and therefore the
 * operator's fleet view ... learns what an Agent thinks it is doing, so
 * it is the right place to assert.
 */
function capturingConnection(): { conn: Connection; states: string[] } {
  const states: string[] = []
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
      const parsed = JSON.parse(line) as {
        id?: number | string
        method?: string
        params?: { state?: string }
      }
      if (parsed.method === 'agent.heartbeat' && typeof parsed.params?.state === 'string') {
        states.push(parsed.params.state)
      }
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
                if (value !== undefined) return Promise.resolve({ value, done: false })
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
        r('')
      }
      return Promise.resolve()
    },
    get closed() {
      return isClosed
    },
  }
  return { conn, states }
}

/** Emits scripted completions in order, repeating the last one forever. */
function scriptedProvider(texts: string[]): LLMProvider {
  let i = 0
  return {
    name: 'fake',
    baseUrl: 'fake://',
    complete(): Promise<CompletionResponse> {
      const text = texts[Math.min(i, texts.length - 1)] ?? ''
      i += 1
      return Promise.resolve({
        text,
        finishReason: 'stop',
        costMetrics: { inputTokens: 10, outputTokens: 10, estDollars: 0 },
        providerResponseId: `fake-${String(i)}`,
      })
    },
  }
}

const PARK_CALL = [
  '```tool',
  JSON.stringify({
    tool: 'task_await_response',
    args: {
      source_kind: 'pub',
      source_ref: { pub: 'studio' },
      expected_from: 'jodin',
      context_note: 'relaying what jodin is working on back to the operator',
      timeout_seconds: 1800,
    },
    predicted_outcome: 'task parks',
    reason: 'asked jodin; waiting for the reply',
  }),
  '```',
].join('\n')

async function waitFor(fn: () => Promise<boolean> | boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('condition not met in time')
}

describe('an Agent that parked, resumed, and finished', () => {
  it('stops reporting blocked_on_agent once the resumed task completes', async () => {
    const store = new TaskStore(home, 'skippy')
    const task = newPendingTask({
      id: newTaskId(),
      agent: 'skippy',
      title: 'Can you ask Jodin what he is working on.',
      body: 'Ask Jodin what he is working on and tell me.',
      idempotency: 'destructive', // await_response is a destructive-class tool
    })
    await store.save(task)

    const { conn, states } = capturingConnection()
    const agent = new AgentProcess({
      name: 'skippy',
      identityPath: agentPaths(home, 'skippy').identity,
      socketPath: '/unused',
      home,
      connection: conn,
      // First turn parks on await_response; every turn after that answers.
      provider: scriptedProvider([PARK_CALL, 'Jodin says he just migrated in. Done.']),
      heartbeatIntervalMs: 40,
      taskPollIntervalMs: 40,
    })
    await agent.start()

    // 1. The Agent parks.
    await waitFor(async () => {
      const r = await store.get(task.frontmatter.id)
      return r?.frontmatter.state === 'blocked_on_agent'
    })
    await waitFor(() => states.includes('blocked_on_agent'))

    // 2. The peer replies. This is what the pub wake source does: flip
    //    the parked task back to pending and clear the wait.
    await store.update(task.frontmatter.id, (fm) => ({
      ...fm,
      state: 'pending',
      wait_for: null,
    }))

    // 3. The task resumes and completes.
    await waitFor(async () => {
      const r = await store.get(task.frontmatter.id)
      return r?.frontmatter.state === 'done'
    })

    // 4. The load-bearing assertion. Everything above worked before the
    //    fix too ... the task completed fine. What was broken is that
    //    the Agent kept telling the supervisor it was blocked, which is
    //    all the operator's fleet view ever sees.
    const seenBefore = states.length
    await waitFor(() => states.length > seenBefore + 2)
    const afterCompletion = states.slice(seenBefore)

    expect(afterCompletion.length).toBeGreaterThan(0)
    expect(afterCompletion).not.toContain('blocked_on_agent')

    await agent.shutdown('test')
  }, 20000)

  // NOTE: there is deliberately no integration test for "shut down while
  // parked" here. The shutdown path swallows an illegal transition
  // (`catch {}`), so such a test passes against the broken code and
  // cannot detect the defect ... it would be decoration. The legality of
  // `blocked_on_agent->stopped` is pinned in blocked-state-clearing.test.ts,
  // where it does fail without the fix.
})
