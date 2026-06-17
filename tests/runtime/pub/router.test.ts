/**
 * Tests for the pub message Router (Epic 3.6 PR J).
 *
 * Uses an injected fake LLMProvider so we can drive the routing
 * decision deterministically. No network calls.
 */
import { describe, expect, it } from 'vitest'
import { Router, RouterCache, type RouterAgent } from '../../../src/runtime/pub/router.js'
import type { LLMProvider } from '../../../src/runtime/llm/provider.js'
import type { CompletionRequest, CompletionResponse } from '../../../src/runtime/llm/types.js'
import { LlmError } from '../../../src/runtime/llm/errors.js'

const HOBBY: RouterAgent = {
  agent_id: 'a-hobby',
  display_name: 'hobby',
  role_blurb: 'primary build agent for the 2200 platform',
}
const SIMON: RouterAgent = {
  agent_id: 'a-simon',
  display_name: 'simon',
  role_blurb: 'devops; deployment, hosting, networking, TLS',
}

function fakeProvider(text: string | (() => string)): LLMProvider {
  return {
    name: 'fake',
    baseUrl: 'fake://',
    complete(_req: CompletionRequest): Promise<CompletionResponse> {
      const t = typeof text === 'function' ? text() : text
      return Promise.resolve({
        text: t,
        finishReason: 'stop',
        costMetrics: { inputTokens: 1, outputTokens: 1 },
        providerResponseId: 'fake-1',
      })
    },
  }
}

function failingProvider(): LLMProvider {
  return {
    name: 'fake',
    baseUrl: 'fake://',
    complete(): Promise<CompletionResponse> {
      return Promise.reject(new LlmError('NETWORK_ERROR', 'simulated', 'fake', 'm'))
    },
  }
}

/** Fails the first `failures` calls with `code`, then returns `successText`. */
function flakyProvider(failures: number, code: 'AUTH_FAILED', successText: string): LLMProvider {
  let calls = 0
  return {
    name: 'fake',
    baseUrl: 'fake://',
    complete(): Promise<CompletionResponse> {
      calls += 1
      if (calls <= failures) {
        return Promise.reject(new LlmError(code, 'simulated transient', 'fake', 'm'))
      }
      return Promise.resolve({
        text: successText,
        finishReason: 'stop',
        costMetrics: { inputTokens: 1, outputTokens: 1 },
        providerResponseId: 'flaky',
      })
    },
  }
}

// Keep router tests fast + deterministic: no real stagger/backoff sleeps and a
// zero stagger jitter.
const noSleep = (): Promise<void> => Promise.resolve()
const noJitter = (): number => 0

describe('Router.route', () => {
  it('parses a clean JSON decision and returns the named agent_ids', async () => {
    const provider = fakeProvider(
      '{"woken_agent_ids": ["a-hobby"], "rationale": "addressed by name"}',
    )
    const router = new Router({ provider, modelId: 'fast', sleep: noSleep, random: noJitter })
    const decision = await router.route({
      message_id: 'm1',
      sender_display_name: 'Doug',
      content: 'hey hobby what do you think?',
      agents: [HOBBY, SIMON],
    })
    expect(decision.woken_agent_ids).toEqual(['a-hobby'])
    expect(decision.rationale).toBe('addressed by name')
    expect(decision.cached).toBe(false)
  })

  it('returns multiple agent_ids when the model picks more than one', async () => {
    const provider = fakeProvider(
      '{"woken_agent_ids": ["a-hobby", "a-simon"], "rationale": "needs both lanes"}',
    )
    const router = new Router({ provider, modelId: 'fast', sleep: noSleep, random: noJitter })
    const decision = await router.route({
      message_id: 'm2',
      sender_display_name: 'Doug',
      content: 'plan a deploy with the build team',
      agents: [HOBBY, SIMON],
    })
    expect(decision.woken_agent_ids).toEqual(['a-hobby', 'a-simon'])
  })

  it('returns empty when the model picks no one', async () => {
    const provider = fakeProvider('{"woken_agent_ids": [], "rationale": "off-topic chatter"}')
    const router = new Router({ provider, modelId: 'fast', sleep: noSleep, random: noJitter })
    const decision = await router.route({
      message_id: 'm3',
      sender_display_name: 'Doug',
      content: 'just a quick status update for the room',
      agents: [HOBBY, SIMON],
    })
    expect(decision.woken_agent_ids).toEqual([])
  })

  it('skips the LLM call entirely when the agent roster is empty', async () => {
    let called = false
    const provider: LLMProvider = {
      name: 'fake',
      baseUrl: 'fake://',
      complete(): Promise<CompletionResponse> {
        called = true
        return Promise.reject(new Error('should not be called'))
      },
    }
    const router = new Router({ provider, modelId: 'fast', sleep: noSleep, random: noJitter })
    const decision = await router.route({
      message_id: 'm4',
      sender_display_name: 'Doug',
      content: 'anyone home',
      agents: [],
    })
    expect(decision.woken_agent_ids).toEqual([])
    expect(called).toBe(false)
  })

  it('extracts JSON even when the model wraps it in prose / fences', async () => {
    const provider = fakeProvider(
      'Sure! Here is the decision:\n\n```json\n{"woken_agent_ids": ["a-simon"]}\n```\n',
    )
    const router = new Router({ provider, modelId: 'fast', sleep: noSleep, random: noJitter })
    const decision = await router.route({
      message_id: 'm5',
      sender_display_name: 'Doug',
      content: 'simon, what is our deploy story?',
      agents: [HOBBY, SIMON],
    })
    expect(decision.woken_agent_ids).toEqual(['a-simon'])
  })

  it('drops agent_ids the model invents that are not in the roster', async () => {
    const provider = fakeProvider('{"woken_agent_ids": ["a-hobby", "a-not-in-roster"]}')
    const router = new Router({ provider, modelId: 'fast', sleep: noSleep, random: noJitter })
    const decision = await router.route({
      message_id: 'm6',
      sender_display_name: 'Doug',
      content: 'hi everyone',
      agents: [HOBBY, SIMON],
    })
    expect(decision.woken_agent_ids).toEqual(['a-hobby'])
  })

  it('returns an empty decision (not throw) when the model returns malformed output', async () => {
    const provider = fakeProvider('not json at all')
    const router = new Router({ provider, modelId: 'fast', sleep: noSleep, random: noJitter })
    const decision = await router.route({
      message_id: 'm7',
      sender_display_name: 'Doug',
      content: 'whatever',
      agents: [HOBBY, SIMON],
    })
    expect(decision.woken_agent_ids).toEqual([])
  })

  it('returns an empty decision when the LLM call throws', async () => {
    const router = new Router({
      provider: failingProvider(),
      modelId: 'fast',
      sleep: noSleep,
      random: noJitter,
    })
    const decision = await router.route({
      message_id: 'm8',
      sender_display_name: 'Doug',
      content: 'whatever',
      agents: [HOBBY, SIMON],
    })
    expect(decision.woken_agent_ids).toEqual([])
  })

  // The decisive ambient fix: a transient 403 (every Agent routing the same
  // message concurrently hits the subscription's limit) must be RETRIED, not
  // treated as "nobody responds".
  it('retries a transient AUTH_FAILED and returns the recovered decision', async () => {
    const router = new Router({
      provider: flakyProvider(1, 'AUTH_FAILED', '{"woken_agent_ids": ["a-hobby"]}'),
      modelId: 'fast',
      sleep: noSleep,
      random: noJitter,
    })
    const decision = await router.route({
      message_id: 'm-retry',
      sender_display_name: 'Doug',
      content: 'anyone around to weigh in?',
      agents: [HOBBY, SIMON],
    })
    expect(decision.woken_agent_ids).toEqual(['a-hobby'])
  })

  it('does not cache a transient failure ... a later route can still succeed', async () => {
    // Fails the first 3 attempts (one full route's worth), so the first route
    // gives up; the 4th call (the second route) succeeds. Proves the failure
    // was not cached against the message_id.
    const router = new Router({
      provider: flakyProvider(3, 'AUTH_FAILED', '{"woken_agent_ids": ["a-simon"]}'),
      modelId: 'fast',
      sleep: noSleep,
      random: noJitter,
    })
    const input = {
      message_id: 'm-nocache',
      sender_display_name: 'Doug',
      content: 'status?',
      agents: [HOBBY, SIMON],
    }
    const first = await router.route(input)
    expect(first.woken_agent_ids).toEqual([])
    const second = await router.route(input)
    expect(second.woken_agent_ids).toEqual(['a-simon'])
  })

  it('forwards perspective_agent_id into the user prompt as "routing on behalf of"', async () => {
    let captured = ''
    const provider: LLMProvider = {
      name: 'fake',
      baseUrl: 'fake://',
      complete(req: CompletionRequest): Promise<CompletionResponse> {
        captured = req.messages[0]?.content ?? ''
        return Promise.resolve({
          text: '{"woken_agent_ids": []}',
          finishReason: 'stop',
          costMetrics: { inputTokens: 1, outputTokens: 1 },
          providerResponseId: 'x',
        })
      },
    }
    const router = new Router({ provider, modelId: 'fast', sleep: noSleep, random: noJitter })
    await router.route({
      message_id: 'm-perspective',
      sender_display_name: 'Doug',
      content: 'both of you check in',
      agents: [HOBBY, SIMON],
      perspective_agent_id: HOBBY.agent_id,
    })
    expect(captured).toContain('routing on behalf of: hobby')
    expect(captured).toContain('The roster IS the room')
  })

  it('caches by message_id; second call does not re-invoke the provider', async () => {
    let calls = 0
    const provider: LLMProvider = {
      name: 'fake',
      baseUrl: 'fake://',
      complete(): Promise<CompletionResponse> {
        calls += 1
        return Promise.resolve({
          text: '{"woken_agent_ids": ["a-hobby"]}',
          finishReason: 'stop',
          costMetrics: { inputTokens: 1, outputTokens: 1 },
          providerResponseId: 'x',
        })
      },
    }
    const router = new Router({ provider, modelId: 'fast', sleep: noSleep, random: noJitter })
    const a = await router.route({
      message_id: 'm-cache',
      sender_display_name: 'Doug',
      content: 'hi',
      agents: [HOBBY],
    })
    const b = await router.route({
      message_id: 'm-cache',
      sender_display_name: 'Doug',
      content: 'hi',
      agents: [HOBBY],
    })
    expect(calls).toBe(1)
    expect(a.cached).toBe(false)
    expect(b.cached).toBe(true)
    expect(b.woken_agent_ids).toEqual(['a-hobby'])
  })
})

describe('RouterCache', () => {
  it('evicts the oldest entry when capacity is exceeded', () => {
    const cache = new RouterCache(2)
    cache.set('a', { woken_agent_ids: ['x'], cached: false })
    cache.set('b', { woken_agent_ids: ['y'], cached: false })
    cache.set('c', { woken_agent_ids: ['z'], cached: false })
    expect(cache.size()).toBe(2)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBeDefined()
    expect(cache.get('c')).toBeDefined()
  })

  it('LRU bumps a hit so it is no longer the next eviction candidate', () => {
    const cache = new RouterCache(2)
    cache.set('a', { woken_agent_ids: ['x'], cached: false })
    cache.set('b', { woken_agent_ids: ['y'], cached: false })
    // hit 'a' so it bumps to most-recent
    cache.get('a')
    cache.set('c', { woken_agent_ids: ['z'], cached: false })
    // 'b' should be evicted, not 'a'
    expect(cache.get('a')).toBeDefined()
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('c')).toBeDefined()
  })
})
