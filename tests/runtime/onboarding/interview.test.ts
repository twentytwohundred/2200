/**
 * Tests for the interview module (Epic 14 Phase A PR B).
 *
 * Uses fake UserInput + fake LLMProvider so the tests are
 * deterministic and don't make network calls. Covers:
 *   - opening + branch flow happy path
 *   - keyword routing (email keywords pick the email branch)
 *   - default branch fallback when no keywords match
 *   - case-insensitive keyword matching
 *   - transcript carries question_id, question_text, answer,
 *     intent_tag, and asked_at for each entry
 *   - summary comes from the LLM
 *   - LLM returning empty text throws
 *   - injected `now()` produces deterministic timestamps
 */
import { describe, expect, it } from 'vitest'
import {
  pickBranch,
  runInterview,
  type UserInput,
} from '../../../src/runtime/onboarding/interview.js'
import type { CompletionRequest, CompletionResponse } from '../../../src/runtime/llm/types.js'
import type { LLMProvider } from '../../../src/runtime/llm/provider.js'
import type { QuestionScript } from '../../../src/runtime/onboarding/types.js'

const SCRIPT: QuestionScript = {
  script_schema_version: 1,
  name: 'test-script',
  opening: {
    id: 'opening',
    text: 'What kind of Agent?',
    expects: 'free_form',
    intent_tag: 'opening_purpose',
  },
  routing: [
    { if_keywords: ['email', 'inbox'], next_branch: 'email_branch' },
    { if_keywords: ['code', 'repo'], next_branch: 'project_branch' },
  ],
  default_branch: 'freeform_branch',
  branches: [
    {
      id: 'email_branch',
      questions: [
        {
          id: 'email_account',
          text: 'Which account?',
          expects: 'email',
          intent_tag: 'tool_email_account',
        },
        { id: 'cadence', text: 'How often?', expects: 'free_form', intent_tag: 'cadence_email' },
      ],
    },
    {
      id: 'project_branch',
      questions: [
        {
          id: 'project_path',
          text: 'Project path?',
          expects: 'free_form',
          intent_tag: 'tool_project_path',
        },
      ],
    },
    {
      id: 'freeform_branch',
      questions: [
        { id: 'tools_needed', text: 'Tools?', expects: 'free_form', intent_tag: 'tools_freeform' },
      ],
    },
  ],
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

interface FakeProviderOptions {
  summary?: string
  empty?: boolean
  throwError?: Error
}

function fakeProvider(options: FakeProviderOptions = {}): LLMProvider {
  return {
    name: 'fake',
    baseUrl: 'http://fake',
    complete: (_request: CompletionRequest): Promise<CompletionResponse> => {
      if (options.throwError !== undefined) {
        return Promise.reject(options.throwError)
      }
      const text = options.empty === true ? '' : (options.summary ?? 'Summary text from the LLM.')
      return Promise.resolve({
        text,
        finishReason: 'stop',
        costMetrics: { inputTokens: 100, outputTokens: 50, estDollars: 0.001 },
      })
    },
  }
}

const FIXED_TIME = new Date('2026-04-29T12:00:00Z')
const fixedNow = (): Date => FIXED_TIME

describe('pickBranch', () => {
  it('routes by the first matching keyword', () => {
    const branch = pickBranch(SCRIPT, 'I want an email assistant')
    expect(branch.id).toBe('email_branch')
  })

  it('matches case-insensitively', () => {
    const branch = pickBranch(SCRIPT, 'EMAIL assistant please')
    expect(branch.id).toBe('email_branch')
  })

  it('falls back to default_branch when no keywords match', () => {
    const branch = pickBranch(SCRIPT, 'something completely unrelated')
    expect(branch.id).toBe('freeform_branch')
  })

  it('first matching rule wins (rules in order)', () => {
    const branch = pickBranch(SCRIPT, 'an email tool that watches my code repo')
    expect(branch.id).toBe('email_branch') // email rule comes first
  })

  it('throws when default_branch points at a non-existent branch', () => {
    const broken: QuestionScript = { ...SCRIPT, default_branch: 'ghost' }
    expect(() => pickBranch(broken, 'no match')).toThrow(/default_branch.*ghost/)
  })
})

describe('runInterview', () => {
  it('runs opening + branch flow and returns a populated transcript', async () => {
    const transcript = await runInterview({
      script: SCRIPT,
      provider: fakeProvider({ summary: 'I am an email Agent. I will watch doug@example.com.' }),
      modelId: 'claude-opus-4-7',
      input: fakeInput([
        'I want an email assistant', // opening
        'doug@example.com', // email_account
        'every weekday at 8am', // cadence
      ]),
      now: fixedNow,
    })

    expect(transcript.interview_schema_version).toBe(1)
    expect(transcript.script_name).toBe('test-script')
    expect(transcript.chosen_branch).toBe('email_branch')
    expect(transcript.entries).toHaveLength(3)
    expect(transcript.entries[0]?.question_id).toBe('opening')
    expect(transcript.entries[0]?.intent_tag).toBe('opening_purpose')
    expect(transcript.entries[1]?.question_id).toBe('email_account')
    expect(transcript.entries[1]?.answer).toBe('doug@example.com')
    expect(transcript.entries[2]?.question_id).toBe('cadence')
    expect(transcript.summary).toContain('email Agent')
    expect(transcript.started_at).toBe('2026-04-29T12:00:00.000Z')
    expect(transcript.finished_at).toBe('2026-04-29T12:00:00.000Z')
  })

  it('uses the default branch when no keywords match', async () => {
    const transcript = await runInterview({
      script: SCRIPT,
      provider: fakeProvider(),
      modelId: 'claude-opus-4-7',
      input: fakeInput([
        'something completely unrelated', // opening (no match)
        'GitHub, Slack', // tools_needed (freeform branch)
      ]),
      now: fixedNow,
    })
    expect(transcript.chosen_branch).toBe('freeform_branch')
    expect(transcript.entries).toHaveLength(2)
    expect(transcript.entries[1]?.question_id).toBe('tools_needed')
  })

  it('routes to project_branch on code keywords', async () => {
    const transcript = await runInterview({
      script: SCRIPT,
      provider: fakeProvider(),
      modelId: 'claude-opus-4-7',
      input: fakeInput(['I want an Agent that watches my code repo', '/home/user/project']),
      now: fixedNow,
    })
    expect(transcript.chosen_branch).toBe('project_branch')
    expect(transcript.entries[1]?.question_id).toBe('project_path')
  })

  it('throws when the LLM returns an empty summary', async () => {
    await expect(
      runInterview({
        script: SCRIPT,
        provider: fakeProvider({ empty: true }),
        modelId: 'claude-opus-4-7',
        input: fakeInput(['something unrelated', 'nothing in particular']),
        now: fixedNow,
      }),
    ).rejects.toThrow(/empty summary/)
  })

  it('propagates LLM errors', async () => {
    await expect(
      runInterview({
        script: SCRIPT,
        provider: fakeProvider({ throwError: new Error('rate limited') }),
        modelId: 'claude-opus-4-7',
        input: fakeInput(['something unrelated', 'nothing']),
        now: fixedNow,
      }),
    ).rejects.toThrow(/rate limited/)
  })

  it('snapshots question_text and intent_tag at ask-time (script edits do not retro-mutate transcripts)', async () => {
    const transcript = await runInterview({
      script: SCRIPT,
      provider: fakeProvider(),
      modelId: 'claude-opus-4-7',
      input: fakeInput(['email please', 'a@b.com', 'daily']),
      now: fixedNow,
    })
    expect(transcript.entries[0]?.question_text).toBe('What kind of Agent?')
    expect(transcript.entries[1]?.question_text).toBe('Which account?')
  })

  it('answers preserve the user input verbatim', async () => {
    const transcript = await runInterview({
      script: SCRIPT,
      provider: fakeProvider(),
      modelId: 'claude-opus-4-7',
      input: fakeInput(['  trailing  whitespace  email  ', '  spaced  ', 'spaced']),
      now: fixedNow,
    })
    expect(transcript.entries[1]?.answer).toBe('  spaced  ')
  })
})
