import { describe, expect, it, vi } from 'vitest'
import { OnboardingSessionStore } from '../../../src/runtime/onboarding/session-store.js'
import { OnboardingSession } from '../../../src/runtime/onboarding/session.js'
import type { CompletionRequest, CompletionResponse } from '../../../src/runtime/llm/types.js'
import type { LLMProvider } from '../../../src/runtime/llm/provider.js'
import type { QuestionScript } from '../../../src/runtime/onboarding/types.js'

const SCRIPT: QuestionScript = {
  script_schema_version: 1,
  name: 's',
  opening: { id: 'opening', text: 'q', expects: 'free_form' },
  routing: [],
  default_branch: 'b',
  branches: [{ id: 'b', questions: [{ id: 'q1', text: 'q', expects: 'free_form' }] }],
}

const fakeProvider: LLMProvider = {
  name: 'fake',
  baseUrl: 'http://fake',
  complete: (_req: CompletionRequest): Promise<CompletionResponse> =>
    Promise.resolve({
      text: 'summary',
      finishReason: 'stop',
      costMetrics: { inputTokens: 0, outputTokens: 0, estDollars: 0 },
    }),
}

function newSession(id: string): OnboardingSession {
  return new OnboardingSession({
    id,
    script: SCRIPT,
    provider: fakeProvider,
    modelId: 'm',
  })
}

describe('OnboardingSessionStore', () => {
  it('register + touch round-trips a session and refreshes lastActiveAt', () => {
    let now = 1_000
    const store = new OnboardingSessionStore({
      idleTtlMs: 100,
      now: () => now,
    })
    store.register(newSession('s1'))
    expect(store.size()).toBe(1)
    now = 1_050 // within TTL
    expect(store.touch('s1')).not.toBeNull()
    now = 1_140 // 90ms after the touch (within 100ms TTL of refresh)
    expect(store.touch('s1')).not.toBeNull()
    now = 1_300 // 160ms after second touch ... expired
    expect(store.touch('s1')).toBeNull()
    expect(store.size()).toBe(0)
  })

  it('touch returns null for unknown ids', () => {
    const store = new OnboardingSessionStore()
    expect(store.touch('nope')).toBeNull()
  })

  it('peek does NOT refresh lastActiveAt', () => {
    let now = 1_000
    const store = new OnboardingSessionStore({
      idleTtlMs: 100,
      now: () => now,
    })
    store.register(newSession('s2'))
    now = 1_050
    expect(store.peek('s2')).not.toBeNull()
    now = 1_120 // peek did not refresh; entry created at 1000, TTL 100 -> expired at >1100
    expect(store.touch('s2')).toBeNull()
  })

  it('sweep removes expired entries and returns the count', () => {
    let now = 1_000
    const store = new OnboardingSessionStore({
      idleTtlMs: 100,
      now: () => now,
    })
    store.register(newSession('a'))
    store.register(newSession('b'))
    now = 1_050
    expect(store.sweep()).toBe(0)
    now = 1_200
    expect(store.sweep()).toBe(2)
    expect(store.size()).toBe(0)
  })

  it('start / stop installs and removes the cleanup timer', () => {
    const setTimer = vi.fn(() => 99 as unknown as NodeJS.Timeout)
    const clearTimer = vi.fn()
    const store = new OnboardingSessionStore({
      setTimer,
      clearTimer,
    })
    store.start()
    expect(setTimer).toHaveBeenCalledTimes(1)
    store.start() // idempotent
    expect(setTimer).toHaveBeenCalledTimes(1)
    store.stop()
    expect(clearTimer).toHaveBeenCalledTimes(1)
    store.stop() // idempotent
    expect(clearTimer).toHaveBeenCalledTimes(1)
  })

  it('delete removes a session by id', () => {
    const store = new OnboardingSessionStore()
    store.register(newSession('byebye'))
    expect(store.delete('byebye')).toBe(true)
    expect(store.delete('byebye')).toBe(false)
    expect(store.size()).toBe(0)
  })

  it('ids reports current session ids in insertion order', () => {
    const store = new OnboardingSessionStore()
    store.register(newSession('first'))
    store.register(newSession('second'))
    expect(store.ids()).toEqual(['first', 'second'])
  })
})
