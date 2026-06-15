/**
 * Tests for LLM-extracted onboarding setup parsing.
 *
 * Why this matters: the curated schedule/tool tables only fire for the
 * scripted archetypes, so the free-form interview produced 0 schedules and
 * 0 tools even when the operator clearly stated a daily cadence and named
 * integrations. This pass reads the interview instead. The parse must:
 *   - turn a stated cadence into a real, VALID cron (and reject garbage)
 *   - default a missing timezone to UTC
 *   - extract named external integrations (deduped)
 *   - tolerate code fences / prose around the JSON, and never throw
 */
import { describe, expect, it } from 'vitest'
import { parseExtraction } from '../../../src/runtime/onboarding/interview-extract'

describe('parseExtraction', () => {
  it('parses a stated cadence into a valid cron schedule (the Jodin case)', () => {
    const raw = JSON.stringify({
      schedules: [
        {
          cron: '30 6 * * *',
          tz: 'America/New_York',
          task: 'publish the daily ten-track playlist + cover art',
          rationale: 'you said 6:30am EDT daily',
        },
      ],
      integrations: [],
    })
    const got = parseExtraction(raw)
    expect(got.schedules).toHaveLength(1)
    expect(got.schedules[0]).toMatchObject({
      cron: '30 6 * * *',
      tz: 'America/New_York',
      source_tag: 'llm_extracted',
    })
    expect(got.schedules[0]?.task).toMatch(/playlist/)
  })

  it('rejects an invalid cron and defaults a missing tz to UTC', () => {
    const raw = JSON.stringify({
      schedules: [
        { cron: 'not a cron', tz: 'UTC', task: 'x' },
        { cron: '*/5 * * * *', task: 'ops poll' }, // no tz
      ],
      integrations: [],
    })
    const got = parseExtraction(raw)
    expect(got.schedules).toHaveLength(1)
    expect(got.schedules[0]).toMatchObject({ cron: '*/5 * * * *', tz: 'UTC' })
  })

  it('drops a schedule with no task even if the cron is valid', () => {
    const got = parseExtraction(
      JSON.stringify({ schedules: [{ cron: '0 9 * * *', tz: 'UTC', task: '' }], integrations: [] }),
    )
    expect(got.schedules).toHaveLength(0)
  })

  it('extracts named integrations, deduped, dropping empties', () => {
    const raw = JSON.stringify({
      schedules: [],
      integrations: [
        { name: 'Spotify', purpose: 'create/update the daily playlist' },
        { name: 'Instagram', purpose: 'post the list + art' },
        { name: 'spotify', purpose: 'dup, different case' },
        { name: '', purpose: 'no name' },
      ],
    })
    const got = parseExtraction(raw)
    expect(got.integrations.map((i) => i.name)).toEqual(['Spotify', 'Instagram'])
  })

  it('tolerates code fences and surrounding prose', () => {
    const raw =
      'Here is the setup:\n```json\n' +
      JSON.stringify({
        schedules: [{ cron: '0 8 * * 1-5', tz: 'UTC', task: 'weekday digest' }],
        integrations: [{ name: 'Slack', purpose: 'post the digest' }],
      }) +
      '\n```\nThat is all.'
    const got = parseExtraction(raw)
    expect(got.schedules).toHaveLength(1)
    expect(got.integrations).toHaveLength(1)
  })

  it('returns empty arrays for malformed or empty input', () => {
    expect(parseExtraction('not json at all')).toEqual({ schedules: [], integrations: [] })
    expect(parseExtraction('')).toEqual({ schedules: [], integrations: [] })
    expect(parseExtraction('{}')).toEqual({ schedules: [], integrations: [] })
  })
})
