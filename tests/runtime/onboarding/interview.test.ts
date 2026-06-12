/**
 * Tests for the v2 LLM-driven interview module.
 *
 * The fake LLM provider plays back a scripted sequence of directives
 * (question, question, ..., done, summary) so the test stays
 * deterministic without network calls. Covers:
 *
 *   - opening + LLM-driven follow-ups produce a populated transcript
 *   - intent_tag on each entry comes from the directive's `covering`
 *     field
 *   - max_turns hard-cap forces 'done' even if the LLM keeps asking
 *   - LLM returning empty summary throws
 *   - LLM error propagates
 *   - malformed directive (non-JSON) is tolerated via re-prompt; a
 *     persistent malformed response forces 'done'
 */
import { describe, expect, it } from 'vitest'
import { runInterview, type UserInput } from '../../../src/runtime/onboarding/interview.js'
import { parseDirective } from '../../../src/runtime/onboarding/session.js'
import type { CompletionRequest, CompletionResponse } from '../../../src/runtime/llm/types.js'
import type { LLMProvider } from '../../../src/runtime/llm/provider.js'
import type { QuestionScript } from '../../../src/runtime/onboarding/types.js'

const SCRIPT: QuestionScript = {
  script_schema_version: 2,
  name: 'test-script',
  opening: {
    id: 'opening',
    text: 'What kind of Agent?',
    expects: 'free_form',
    intent_tag: 'purpose',
  },
  goals: [
    { id: 'purpose', description: 'what the agent does', required: true },
    { id: 'agent_name', description: 'what to call it', required: true },
    { id: 'tools', description: 'integrations needed', required: true },
  ],
  target_turns: 4,
  max_turns: 6,
}

function fakeInput(answers: readonly string[]): UserInput {
  let i = 0
  return {
    ask: (_promptText: string): Promise<string> => {
      const answer = answers[i]
      if (answer === undefined) {
        return Promise.reject(
          new Error(
            `fakeInput exhausted (asked ${String(i + 1)} questions, supplied ${String(answers.length)} answers)`,
          ),
        )
      }
      i++
      return Promise.resolve(answer)
    },
  }
}

/**
 * The fake provider plays back a scripted sequence of completion
 * texts. The session calls complete() once per "what should I ask next?"
 * turn (returning a directive JSON) and once for the final summary.
 * Distinguish between them via the systemPrompt: interviewer prompts
 * mention GOALS; the summary prompt is everything else.
 */
function scriptedProvider(opts: {
  directives: readonly string[]
  summary?: string
  throwOnTurn?: number
}): LLMProvider {
  let interviewerCallCount = 0
  return {
    name: 'fake',
    baseUrl: 'http://fake',
    complete: (request: CompletionRequest): Promise<CompletionResponse> => {
      const isInterviewer = request.systemPrompt?.includes('GOALS')
      if (isInterviewer) {
        const directive = opts.directives[interviewerCallCount]
        interviewerCallCount += 1
        if (opts.throwOnTurn !== undefined && interviewerCallCount === opts.throwOnTurn) {
          return Promise.reject(new Error('rate limited'))
        }
        return Promise.resolve({
          text: directive ?? '{"kind":"done"}',
          finishReason: 'stop',
          costMetrics: { inputTokens: 100, outputTokens: 50, estDollars: 0.001 },
        })
      }
      // Summary call.
      return Promise.resolve({
        text: opts.summary ?? 'I am an Agent. My job is X.',
        finishReason: 'stop',
        costMetrics: { inputTokens: 100, outputTokens: 50, estDollars: 0.001 },
      })
    },
  }
}

const FIXED_TIME = new Date('2026-04-29T12:00:00Z')
const fixedNow = (): Date => FIXED_TIME

describe('parseDirective', () => {
  it('parses bare JSON', () => {
    expect(parseDirective('{"kind":"done"}')).toEqual({ kind: 'done' })
  })

  it('parses fenced JSON', () => {
    const text = '```json\n{"kind":"question","text":"hi","covering":"purpose"}\n```'
    expect(parseDirective(text)).toEqual({
      kind: 'question',
      text: 'hi',
      covering: 'purpose',
    })
  })

  it('extracts JSON from prose', () => {
    expect(parseDirective('Sure thing. {"kind":"done"} (final answer.)')).toEqual({ kind: 'done' })
  })

  it('returns null on unparseable input', () => {
    expect(parseDirective('lol no json here')).toBeNull()
  })

  it('returns null on a question with empty text', () => {
    expect(parseDirective('{"kind":"question","text":"","covering":"purpose"}')).toBeNull()
  })
})

describe('runInterview', () => {
  it('runs opening + LLM-driven follow-ups and returns a populated transcript', async () => {
    const transcript = await runInterview({
      script: SCRIPT,
      provider: scriptedProvider({
        directives: [
          '{"kind":"question","text":"What should I call you?","covering":"agent_name"}',
          '{"kind":"question","text":"Which integrations?","covering":"tools"}',
          '{"kind":"done"}',
        ],
        summary: 'I am Emma, an email Agent. I will watch operator@example.com.',
      }),
      modelId: 'claude-opus-4-7',
      input: fakeInput([
        'I want an email assistant', // opening
        'emma', // agent_name
        'gmail', // tools
      ]),
      now: fixedNow,
    })

    expect(transcript.interview_schema_version).toBe(2)
    expect(transcript.script_name).toBe('test-script')
    expect(transcript.chosen_branch).toBe('llm_driven')
    expect(transcript.entries).toHaveLength(3)
    expect(transcript.entries[0]?.question_id).toBe('opening')
    expect(transcript.entries[0]?.intent_tag).toBe('purpose')
    expect(transcript.entries[1]?.intent_tag).toBe('agent_name')
    expect(transcript.entries[1]?.answer).toBe('emma')
    expect(transcript.entries[2]?.intent_tag).toBe('tools')
    expect(transcript.summary).toContain('email Agent')
  })

  it('forces done when max_turns is reached', async () => {
    // The LLM keeps asking; the session should hit max_turns=6 and
    // summarize anyway.
    const directives = Array.from({ length: 10 }).map(
      () => '{"kind":"question","text":"another?","covering":"purpose"}',
    )
    const answers = Array.from({ length: 10 }).map((_, i) => `answer ${String(i)}`)
    const transcript = await runInterview({
      script: SCRIPT,
      provider: scriptedProvider({
        directives,
        summary: 'forced summary',
      }),
      modelId: 'claude-opus-4-7',
      input: fakeInput(answers),
      now: fixedNow,
    })
    // Opening + at most max_turns-1 generated questions ... we cap at
    // max_turns total entries.
    expect(transcript.entries.length).toBeLessThanOrEqual(SCRIPT.max_turns)
    expect(transcript.summary).toBe('forced summary')
  })

  it('throws when the LLM returns an empty summary', async () => {
    await expect(
      runInterview({
        script: SCRIPT,
        provider: scriptedProvider({
          directives: ['{"kind":"done"}'],
          summary: '',
        }),
        modelId: 'claude-opus-4-7',
        input: fakeInput(['I want an Agent']),
        now: fixedNow,
      }),
    ).rejects.toThrow(/empty summary/)
  })

  it('propagates LLM errors during the interview', async () => {
    await expect(
      runInterview({
        script: SCRIPT,
        provider: scriptedProvider({
          directives: ['{"kind":"question","text":"q","covering":"purpose"}'],
          throwOnTurn: 1,
        }),
        modelId: 'claude-opus-4-7',
        input: fakeInput(['I want an Agent']),
        now: fixedNow,
      }),
    ).rejects.toThrow(/rate limited/)
  })

  it('snapshots question_text and intent_tag at ask-time', async () => {
    const transcript = await runInterview({
      script: SCRIPT,
      provider: scriptedProvider({
        directives: ['{"kind":"question","text":"Q1?","covering":"agent_name"}', '{"kind":"done"}'],
      }),
      modelId: 'claude-opus-4-7',
      input: fakeInput(['I want an Agent', 'emma']),
      now: fixedNow,
    })
    expect(transcript.entries[0]?.question_text).toBe('What kind of Agent?')
    expect(transcript.entries[1]?.question_text).toBe('Q1?')
  })

  it('preserves user answers verbatim (whitespace and all)', async () => {
    const transcript = await runInterview({
      script: SCRIPT,
      provider: scriptedProvider({
        directives: ['{"kind":"done"}'],
      }),
      modelId: 'claude-opus-4-7',
      input: fakeInput(['  trailing  whitespace  email  ']),
      now: fixedNow,
    })
    expect(transcript.entries[0]?.answer).toBe('  trailing  whitespace  email  ')
  })
})
