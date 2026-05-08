/**
 * Tests for OnboardingSession (v2: LLM-driven).
 *
 * The fake provider plays back a scripted sequence of directive JSONs
 * for the interviewer system-prompt calls; the summary call returns
 * configurable text. We distinguish interviewer vs summary calls by
 * matching on systemPrompt content (the interviewer prompt always
 * contains the literal string "GOALS").
 */
import { describe, expect, it } from 'vitest'
import {
  OnboardingSession,
  OnboardingSessionError,
} from '../../../src/runtime/onboarding/session.js'
import type { CompletionRequest, CompletionResponse } from '../../../src/runtime/llm/types.js'
import type { LLMProvider } from '../../../src/runtime/llm/provider.js'
import type { QuestionScript } from '../../../src/runtime/onboarding/types.js'

const SCRIPT: QuestionScript = {
  script_schema_version: 2,
  name: 'test-session-script',
  opening: {
    id: 'opening',
    text: 'What kind of Agent?',
    expects: 'free_form',
    intent_tag: 'purpose',
  },
  goals: [
    { id: 'purpose', description: 'what it does', required: true },
    { id: 'agent_name', description: 'name', required: true },
    { id: 'tools', description: 'integrations', required: true },
  ],
  target_turns: 4,
  max_turns: 6,
}

interface ScriptedProviderOpts {
  directives: readonly string[]
  summary?: string
  emptySummary?: boolean
  errorOnSummary?: Error
  errorOnInterviewerTurn?: number
}

function scriptedProvider(opts: ScriptedProviderOpts): LLMProvider {
  let interviewerCalls = 0
  return {
    name: 'fake',
    baseUrl: 'http://fake',
    complete: (request: CompletionRequest): Promise<CompletionResponse> => {
      const isInterviewer = request.systemPrompt?.includes('GOALS')
      if (isInterviewer) {
        interviewerCalls += 1
        if (
          opts.errorOnInterviewerTurn !== undefined &&
          interviewerCalls === opts.errorOnInterviewerTurn
        ) {
          return Promise.reject(new Error('llm down'))
        }
        const directive = opts.directives[interviewerCalls - 1] ?? '{"kind":"done"}'
        return Promise.resolve({
          text: directive,
          finishReason: 'stop',
          costMetrics: { inputTokens: 100, outputTokens: 50, estDollars: 0.001 },
        })
      }
      // Summary call.
      if (opts.errorOnSummary) return Promise.reject(opts.errorOnSummary)
      const text = opts.emptySummary === true ? '' : (opts.summary ?? 'I am the Agent.')
      return Promise.resolve({
        text,
        finishReason: 'stop',
        costMetrics: { inputTokens: 100, outputTokens: 50, estDollars: 0.001 },
      })
    },
  }
}

const FIXED = new Date('2026-05-06T12:00:00.000Z')

describe('OnboardingSession (v2)', () => {
  it('starts in awaiting_opening with the opening question', () => {
    const session = new OnboardingSession({
      id: 'onb_1',
      script: SCRIPT,
      provider: scriptedProvider({ directives: ['{"kind":"done"}'] }),
      modelId: 'm',
      now: () => FIXED,
    })
    expect(session.getState()).toBe('awaiting_opening')
    const q = session.currentQuestion()
    expect(q?.question.id).toBe('opening')
    expect(q?.index).toBe(1)
    expect(q?.total).toBe(SCRIPT.target_turns)
  })

  it('walks the LLM-driven follow-ups until the LLM signals done', async () => {
    const session = new OnboardingSession({
      id: 'onb_2',
      script: SCRIPT,
      provider: scriptedProvider({
        directives: [
          '{"kind":"question","text":"What should I call you?","covering":"agent_name"}',
          '{"kind":"question","text":"Which integrations?","covering":"tools"}',
          '{"kind":"done"}',
        ],
        summary: 'I am Emma.',
      }),
      modelId: 'm',
      now: () => FIXED,
    })
    const r1 = await session.submitAnswer('I want an email Agent')
    expect(r1.kind).toBe('next')
    if (r1.kind !== 'next') throw new Error('expected next')
    expect(r1.question.question.text).toBe('What should I call you?')
    expect(r1.question.question.intent_tag).toBe('agent_name')
    expect(session.getState()).toBe('awaiting_response')

    const r2 = await session.submitAnswer('emma')
    if (r2.kind !== 'next') throw new Error('expected next')
    expect(r2.question.question.text).toBe('Which integrations?')

    const r3 = await session.submitAnswer('gmail')
    expect(r3.kind).toBe('done')
    expect(session.getState()).toBe('done')
  })

  it('forces done at max_turns even when the LLM keeps asking', async () => {
    const directives = Array.from({ length: 10 }).map(
      () => '{"kind":"question","text":"another?","covering":"purpose"}',
    )
    const session = new OnboardingSession({
      id: 'onb_3',
      script: SCRIPT,
      provider: scriptedProvider({
        directives,
        summary: 'capped summary',
      }),
      modelId: 'm',
      now: () => FIXED,
    })
    for (let i = 0; i < SCRIPT.max_turns; i++) {
      const r = await session.submitAnswer(`answer ${String(i)}`)
      if (r.kind === 'done') {
        expect(i).toBeGreaterThanOrEqual(SCRIPT.max_turns - 1)
        return
      }
    }
    expect(session.getState()).toBe('done')
  })

  it('builds a transcript with intent_tag from the directive covering field', async () => {
    const session = new OnboardingSession({
      id: 'onb_4',
      script: SCRIPT,
      provider: scriptedProvider({
        directives: [
          '{"kind":"question","text":"Name?","covering":"agent_name"}',
          '{"kind":"done"}',
        ],
        summary: 'I am Emma.',
      }),
      modelId: 'm',
      now: () => FIXED,
    })
    await session.submitAnswer('email Agent')
    await session.submitAnswer('emma')
    const t = session.getTranscript()
    expect(t.chosen_branch).toBe('llm_driven')
    expect(t.entries.map((e) => e.intent_tag)).toEqual(['purpose', 'agent_name'])
    expect(t.entries.map((e) => e.answer)).toEqual(['email Agent', 'emma'])
    expect(t.summary).toBe('I am Emma.')
  })

  it('produces a preview with handoff + tools + schedules + agent_name on done', async () => {
    const session = new OnboardingSession({
      id: 'onb_5',
      script: SCRIPT,
      provider: scriptedProvider({
        directives: [
          '{"kind":"question","text":"Name?","covering":"agent_name"}',
          '{"kind":"done"}',
        ],
        summary: 'I am Emma.',
      }),
      modelId: 'm',
      now: () => FIXED,
    })
    await session.submitAnswer('email')
    const r = await session.submitAnswer('emma')
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
      provider: scriptedProvider({
        directives: ['{"kind":"done"}'],
        errorOnSummary: new Error('llm down'),
      }),
      modelId: 'm',
    })
    await expect(session.submitAnswer('email')).rejects.toThrow(/llm down/)
    expect(session.getState()).toBe('errored')
  })

  it('transitions to errored on empty summary', async () => {
    const session = new OnboardingSession({
      id: 'onb_7',
      script: SCRIPT,
      provider: scriptedProvider({
        directives: ['{"kind":"done"}'],
        emptySummary: true,
      }),
      modelId: 'm',
    })
    await expect(session.submitAnswer('email')).rejects.toThrow(/empty summary/)
    expect(session.getState()).toBe('errored')
  })

  it('refuses submitAnswer in terminal states', async () => {
    const session = new OnboardingSession({
      id: 'onb_8',
      script: SCRIPT,
      provider: scriptedProvider({
        directives: ['{"kind":"done"}'],
      }),
      modelId: 'm',
    })
    await session.submitAnswer('email')
    expect(session.getState()).toBe('done')
    await expect(session.submitAnswer('extra')).rejects.toBeInstanceOf(OnboardingSessionError)
  })

  it('cancel marks the session and refuses re-confirm', () => {
    const session = new OnboardingSession({
      id: 'onb_9',
      script: SCRIPT,
      provider: scriptedProvider({ directives: ['{"kind":"done"}'] }),
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
      provider: scriptedProvider({
        directives: ['{"kind":"done"}'],
      }),
      modelId: 'm',
    })
    await session.submitAnswer('email')
    expect(session.getState()).toBe('done')
    session.markConfirmed()
    expect(session.getState()).toBe('confirmed')
    expect(() => {
      session.markConfirmed()
    }).toThrow(OnboardingSessionError)
  })

  it('forces done after a malformed directive even on re-prompt', async () => {
    const session = new OnboardingSession({
      id: 'onb_11',
      script: SCRIPT,
      provider: scriptedProvider({
        directives: ['lol no json', 'still not json'],
        summary: 'fallback summary',
      }),
      modelId: 'm',
    })
    const r = await session.submitAnswer('I want an Agent')
    expect(r.kind).toBe('done')
  })
})
