/**
 * Tests for suggestSchedules (Epic 14 Phase A PR C).
 *
 * Curated mapping per the Phase A locked decision; no LLM parsing.
 */
import { describe, expect, it } from 'vitest'
import { suggestSchedules } from '../../../src/runtime/onboarding/schedule-suggestions.js'
import type { InterviewTranscript } from '../../../src/runtime/onboarding/types.js'

function makeTranscript(
  entries: { id: string; tag?: string; answer: string }[],
): InterviewTranscript {
  return {
    interview_schema_version: 1,
    script_name: 'test',
    chosen_branch: 'test_branch',
    entries: entries.map((e) => ({
      question_id: e.id,
      question_text: `q for ${e.id}`,
      answer: e.answer,
      ...(e.tag !== undefined ? { intent_tag: e.tag } : {}),
      asked_at: '2026-04-29T12:00:00.000Z',
    })),
    summary: 'summary',
    started_at: '2026-04-29T12:00:00.000Z',
    finished_at: '2026-04-29T12:05:00.000Z',
  }
}

describe('suggestSchedules', () => {
  it('suggests daily 08:00 UTC for cadence_email', () => {
    const t = makeTranscript([
      { id: 'cadence', tag: 'cadence_email', answer: 'every weekday morning' },
    ])
    const suggestions = suggestSchedules(t)
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]?.id).toBe('morning_email_triage')
    expect(suggestions[0]?.cron).toBe('0 8 * * *')
    expect(suggestions[0]?.tz).toBe('UTC')
    expect(suggestions[0]?.source_tag).toBe('cadence_email')
    expect(suggestions[0]?.rationale).toContain('every weekday morning')
  })

  it('suggests every-5-minutes for cadence_ops', () => {
    const t = makeTranscript([{ id: 'cadence', tag: 'cadence_ops', answer: 'tight loop' }])
    const suggestions = suggestSchedules(t)
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]?.id).toBe('ops_poll')
    expect(suggestions[0]?.cron).toBe('*/5 * * * *')
  })

  it('returns no suggestions for cadence_project (project Agents are typically event-driven)', () => {
    const t = makeTranscript([{ id: 'cadence', tag: 'cadence_project', answer: 'always-on' }])
    const suggestions = suggestSchedules(t)
    expect(suggestions).toEqual([])
  })

  it('returns no suggestions for cadence_freeform (too varied for a default)', () => {
    const t = makeTranscript([
      { id: 'cadence', tag: 'cadence_freeform', answer: 'whenever something happens' },
    ])
    const suggestions = suggestSchedules(t)
    expect(suggestions).toEqual([])
  })

  it('truncates long answers in the rationale', () => {
    const longAnswer = 'a'.repeat(200)
    const t = makeTranscript([{ id: 'cadence', tag: 'cadence_email', answer: longAnswer }])
    const suggestions = suggestSchedules(t)
    expect(suggestions[0]?.rationale.length).toBeLessThan(150)
  })

  it('skips entries without a tagged cadence intent', () => {
    const t = makeTranscript([{ id: 'opening', tag: 'opening_purpose', answer: 'something' }])
    const suggestions = suggestSchedules(t)
    expect(suggestions).toEqual([])
  })

  it('returns multiple suggestions when multiple cadence intents are present', () => {
    const t = makeTranscript([
      { id: 'c1', tag: 'cadence_email', answer: 'morning' },
      { id: 'c2', tag: 'cadence_ops', answer: 'tight loop' },
    ])
    const suggestions = suggestSchedules(t)
    expect(suggestions).toHaveLength(2)
    const ids = suggestions.map((s) => s.id).sort()
    expect(ids).toEqual(['morning_email_triage', 'ops_poll'])
  })

  it('deduplicates by id when the same tag appears twice', () => {
    const t = makeTranscript([
      { id: 'c1', tag: 'cadence_email', answer: 'first' },
      { id: 'c2', tag: 'cadence_email', answer: 'second' },
    ])
    const suggestions = suggestSchedules(t)
    expect(suggestions).toHaveLength(1)
  })
})
