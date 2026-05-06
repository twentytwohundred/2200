import { describe, expect, it } from 'vitest'
import {
  OnboardingSession,
  OnboardingSessionError,
} from '../../../src/runtime/onboarding/session.js'
import type { CompletionRequest, CompletionResponse } from '../../../src/runtime/llm/types.js'
import type { LLMProvider } from '../../../src/runtime/llm/provider.js'
import type { QuestionScript } from '../../../src/runtime/onboarding/types.js'

const SCRIPT: QuestionScript = {
  script_schema_version: 1,
  name: 'test-session-script',
  opening: {
    id: 'opening',
    text: 'What kind of Agent?',
    expects: 'free_form',
    intent_tag: 'opening_purpose',
  },
  routing: [{ if_keywords: ['email', 'inbox'], next_branch: 'email_branch' }],
  default_branch: 'freeform_branch',
  branches: [
    {
      id: 'email_branch',
      questions: [
        { id: 'q_name', text: 'Name?', expects: 'free_form', intent_tag: 'agent_name' },
        { id: 'q_account', text: 'Which account?', expects: 'free_form' },
        { id: 'q_cadence', text: 'How often?', expects: 'free_form' },
      ],
    },
    {
      id: 'freeform_branch',
      questions: [
        { id: 'q_name', text: 'Name?', expects: 'free_form', intent_tag: 'agent_name' },
        { id: 'q_freeform', text: 'Tools?', expects: 'free_form' },
      ],
    },
  ],
}

function fakeProvider(
  opts: { summary?: string; empty?: boolean; error?: Error } = {},
): LLMProvider {
  return {
    name: 'fake',
    baseUrl: 'http://fake',
    complete: (_req: CompletionRequest): Promise<CompletionResponse> => {
      if (opts.error) return Promise.reject(opts.error)
      const text = opts.empty ? '' : (opts.summary ?? 'I am the Agent. I help with email.')
      return Promise.resolve({
        text,
        finishReason: 'stop',
        costMetrics: { inputTokens: 100, outputTokens: 50, estDollars: 0.001 },
      })
    },
  }
}

const FIXED = new Date('2026-05-06T12:00:00.000Z')

describe('OnboardingSession', () => {
  it('starts in awaiting_opening with the opening question', () => {
    const session = new OnboardingSession({
      id: 'onb_1',
      script: SCRIPT,
      provider: fakeProvider(),
      modelId: 'm',
      now: () => FIXED,
    })
    expect(session.getState()).toBe('awaiting_opening')
    const q = session.currentQuestion()
    expect(q?.question.id).toBe('opening')
    expect(q?.index).toBe(0)
    expect(q?.total).toBeNull()
  })

  it('routes via opening keyword and walks the branch questions in order', async () => {
    const session = new OnboardingSession({
      id: 'onb_2',
      script: SCRIPT,
      provider: fakeProvider(),
      modelId: 'm',
      now: () => FIXED,
    })
    const r1 = await session.submitAnswer('I want an email Agent')
    expect(r1.kind).toBe('next')
    if (r1.kind !== 'next') throw new Error('expected next')
    expect(r1.question.question.id).toBe('q_name')
    expect(r1.question.index).toBe(1)
    expect(r1.question.total).toBe(4)
    expect(session.getState()).toBe('awaiting_branch_question')

    const r2 = await session.submitAnswer('emma')
    if (r2.kind !== 'next') throw new Error('expected next')
    expect(r2.question.question.id).toBe('q_account')

    const r3 = await session.submitAnswer('user@example.com')
    if (r3.kind !== 'next') throw new Error('expected next')
    expect(r3.question.question.id).toBe('q_cadence')

    const r4 = await session.submitAnswer('Every morning')
    expect(r4.kind).toBe('done')
    expect(session.getState()).toBe('done')
  })

  it('falls back to default_branch when no keyword matches', async () => {
    const session = new OnboardingSession({
      id: 'onb_3',
      script: SCRIPT,
      provider: fakeProvider(),
      modelId: 'm',
      now: () => FIXED,
    })
    const r1 = await session.submitAnswer('something completely unrelated')
    if (r1.kind !== 'next') throw new Error('expected next')
    expect(r1.question.question.id).toBe('q_name')
  })

  it('builds a transcript with the captured Q&A and chosen branch', async () => {
    const session = new OnboardingSession({
      id: 'onb_4',
      script: SCRIPT,
      provider: fakeProvider({ summary: 'I track email.' }),
      modelId: 'm',
      now: () => FIXED,
    })
    await session.submitAnswer('email')
    await session.submitAnswer('emma')
    await session.submitAnswer('user@example.com')
    await session.submitAnswer('daily')
    const t = session.getTranscript()
    expect(t.chosen_branch).toBe('email_branch')
    expect(t.entries.map((e) => e.question_id)).toEqual([
      'opening',
      'q_name',
      'q_account',
      'q_cadence',
    ])
    expect(t.entries.map((e) => e.answer)).toEqual(['email', 'emma', 'user@example.com', 'daily'])
    expect(t.summary).toBe('I track email.')
  })

  it('produces a preview with handoff + tools + schedules + agent_name on done', async () => {
    const session = new OnboardingSession({
      id: 'onb_5',
      script: SCRIPT,
      provider: fakeProvider({ summary: 'I am the email agent.' }),
      modelId: 'm',
      now: () => FIXED,
    })
    await session.submitAnswer('email')
    await session.submitAnswer('emma')
    await session.submitAnswer('user@example.com')
    const r = await session.submitAnswer('daily')
    if (r.kind !== 'done') throw new Error('expected done')
    expect(r.preview.agent_name).toBeTypeOf('string')
    expect(r.preview.agent_name.length).toBeGreaterThan(0)
    expect(r.preview.handoff.frontmatter.agent_name).toBe(r.preview.agent_name)
    expect(Array.isArray(r.preview.tools)).toBe(true)
    expect(Array.isArray(r.preview.schedules)).toBe(true)
    expect(session.getPreview()).toBe(r.preview)
  })

  it('transitions to errored on LLM failure during summary', async () => {
    const session = new OnboardingSession({
      id: 'onb_6',
      script: SCRIPT,
      provider: fakeProvider({ error: new Error('llm down') }),
      modelId: 'm',
    })
    await session.submitAnswer('email')
    await session.submitAnswer('emma')
    await session.submitAnswer('user@example.com')
    await expect(session.submitAnswer('daily')).rejects.toThrow(/llm down/)
    expect(session.getState()).toBe('errored')
  })

  it('transitions to errored on empty summary', async () => {
    const session = new OnboardingSession({
      id: 'onb_7',
      script: SCRIPT,
      provider: fakeProvider({ empty: true }),
      modelId: 'm',
    })
    await session.submitAnswer('email')
    await session.submitAnswer('emma')
    await session.submitAnswer('user@example.com')
    await expect(session.submitAnswer('daily')).rejects.toThrow(/empty summary/)
    expect(session.getState()).toBe('errored')
  })

  it('refuses submitAnswer in terminal states', async () => {
    const session = new OnboardingSession({
      id: 'onb_8',
      script: SCRIPT,
      provider: fakeProvider(),
      modelId: 'm',
    })
    // freeform branch: opening -> name -> tools (2 branch q + 1 opening = 3 answers)
    await session.submitAnswer('something else')
    await session.submitAnswer('emma')
    await session.submitAnswer('answer')
    expect(session.getState()).toBe('done')
    await expect(session.submitAnswer('extra')).rejects.toBeInstanceOf(OnboardingSessionError)
  })

  it('cancel marks the session and refuses re-confirm', () => {
    const session = new OnboardingSession({
      id: 'onb_9',
      script: SCRIPT,
      provider: fakeProvider(),
      modelId: 'm',
    })
    session.cancel()
    expect(session.getState()).toBe('cancelled')
    expect(() => {
      session.markConfirmed()
    }).toThrow(OnboardingSessionError)
  })

  it('markConfirmed locks the session into confirmed', async () => {
    const session = new OnboardingSession({
      id: 'onb_10',
      script: SCRIPT,
      provider: fakeProvider(),
      modelId: 'm',
    })
    await session.submitAnswer('email')
    await session.submitAnswer('emma')
    await session.submitAnswer('user@example.com')
    await session.submitAnswer('daily')
    expect(session.getState()).toBe('done')
    session.markConfirmed()
    expect(session.getState()).toBe('confirmed')
    expect(() => {
      session.markConfirmed()
    }).toThrow(OnboardingSessionError)
  })
})
