/**
 * Onboarding session persistence ... the client half of resume-on-reload.
 *
 * jsdom's sessionStorage in vitest 2.x isn't a full Storage, so we install an
 * in-memory mock (same approach as the ThemeProvider test).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  saveOnboardingSession,
  loadOnboardingSession,
  clearOnboardingSession,
} from '../../src/screens/onboarding/sessionPersistence'
import type { OnboardingTranscriptEntry } from '../../src/lib/api'

function makeMockStorage(): Storage {
  let store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v)
    },
    removeItem: (k: string) => {
      store.delete(k)
    },
    clear: () => {
      store = new Map()
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    },
  }
}

function install(): Storage {
  const mock = makeMockStorage()
  Object.defineProperty(window, 'sessionStorage', {
    value: mock,
    writable: true,
    configurable: true,
  })
  return mock
}

const ENTRY: OnboardingTranscriptEntry = {
  question_id: 'q1',
  question_text: 'What should this Agent do?',
  answer: 'Watch my inbox',
  asked_at: '2026-07-01T00:00:00.000Z',
}

describe('onboarding session persistence', () => {
  beforeEach(() => {
    install()
  })

  it('round-trips the session id and transcript', () => {
    saveOnboardingSession({ sessionId: 'onb_abc', transcript: [ENTRY] })
    const loaded = loadOnboardingSession()
    expect(loaded).toEqual({ sessionId: 'onb_abc', transcript: [ENTRY] })
  })

  it('returns null when nothing is stored', () => {
    expect(loadOnboardingSession()).toBeNull()
  })

  it('clears the stored session', () => {
    saveOnboardingSession({ sessionId: 'onb_abc', transcript: [] })
    clearOnboardingSession()
    expect(loadOnboardingSession()).toBeNull()
  })

  it('returns null (not a throw) on a malformed stored value', () => {
    window.sessionStorage.setItem('2200.onboarding.session', '{ not json')
    expect(loadOnboardingSession()).toBeNull()
  })

  it('tolerates a missing transcript field, defaulting to empty', () => {
    window.sessionStorage.setItem('2200.onboarding.session', JSON.stringify({ sessionId: 'onb_x' }))
    expect(loadOnboardingSession()).toEqual({ sessionId: 'onb_x', transcript: [] })
  })

  it('rejects a stored value with no session id', () => {
    window.sessionStorage.setItem('2200.onboarding.session', JSON.stringify({ transcript: [] }))
    expect(loadOnboardingSession()).toBeNull()
  })
})
