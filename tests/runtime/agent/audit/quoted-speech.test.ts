/**
 * Tests for stripping third-party speech before claim extraction.
 *
 * The audit asks "did this Agent do what it said it did?" ... a question
 * only meaningful about the Agent's own words. When an Agent relays a
 * peer, which is the entire point of the relay primitive, the peer's
 * sentences arrive inside the Agent's message and get scored against
 * the wrong transcript.
 *
 * The balance these tests defend: over-stripping silently destroys real
 * findings, which is far worse than an occasional stray flag. So the
 * negative cases (what must NOT be stripped) carry as much weight as
 * the positive ones, and the first-person cases are the ones to watch
 * ... an Agent must never be able to launder its own claim by phrasing
 * it as reported speech.
 */
import { describe, expect, it } from 'vitest'
import { stripQuotedSpeech } from '../../../../src/runtime/agent/audit/quoted-speech.js'

describe('stripQuotedSpeech', () => {
  it('strips the exact relay that produced the false flag in the field', () => {
    const body =
      'Jodin replied: "Just migrated in as a fresh agent stub. Reading ' +
      'continuity-from-migration now to pick up prior context and lane."'

    const { text, stripped } = stripQuotedSpeech(body)

    expect(stripped).toBe(1)
    // The peer's claim is gone ...
    expect(text).not.toContain('Reading continuity-from-migration')
    // ... but the fact that a relay happened survives, because that IS
    // the relaying Agent's own claim.
    expect(text).toContain('Jodin')
    expect(text).toMatch(/relayed a response/)
  })

  it('strips a markdown blockquote', () => {
    const { text, stripped } = stripQuotedSpeech(
      [
        'Here is what Simon sent:',
        '',
        '> I wrote the config to /project/out.yaml',
        '',
        'Done.',
      ].join('\n'),
    )
    expect(stripped).toBeGreaterThan(0)
    expect(text).not.toContain('/project/out.yaml')
    expect(text).toContain('Done.')
  })

  it('drops everything under a substrate-authored continuation heading', () => {
    // The runtime writes this heading itself when a peer's reply
    // resumes a parked task, so it is an exact marker, not a guess.
    const body = [
      'I asked Hobby for the count.',
      '',
      '## Continuation: response arrived',
      '',
      '**Their response:**',
      '',
      'I read the vault directory and found 14 keys.',
    ].join('\n')

    const { text } = stripQuotedSpeech(body)

    expect(text).toContain('I asked Hobby for the count.')
    expect(text).not.toContain('I read the vault directory')
  })

  it('handles several speech verbs and curly quotes', () => {
    for (const verb of ['said', 'answered', 'responded', 'reported', 'told me']) {
      const { stripped } = stripQuotedSpeech(`Simon ${verb}: “I wrote the file.”`)
      expect(stripped, `verb "${verb}" should strip`).toBe(1)
    }
  })
})

describe('what must survive stripping', () => {
  it('never strips a first-person claim', () => {
    // The failure mode that matters: an Agent laundering its own
    // fabrication by dressing it as reported speech.
    const body = 'I wrote the report to /project/q3.md and verified it.'
    const { text, stripped } = stripQuotedSpeech(body)
    expect(stripped).toBe(0)
    expect(text).toBe(body)
  })

  it('does not strip "We ..." — an Agent speaking for itself', () => {
    const { text, stripped } = stripQuotedSpeech('We saved the output to /project/out.txt.')
    expect(stripped).toBe(0)
    expect(text).toContain('/project/out.txt')
  })

  it('leaves unattributed quotation alone', () => {
    // Quoting a string is not quoting a person. An Agent naming a
    // header it wrote must stay auditable.
    const body = 'I wrote the header as "Q3 Report" into /project/q3.md.'
    const { text, stripped } = stripQuotedSpeech(body)
    expect(stripped).toBe(0)
    expect(text).toContain('/project/q3.md')
  })

  it('leaves the fabricated-playlist message fully auditable', () => {
    // The other field case. Nothing here is reported speech, so the
    // audit must still see every word of it.
    const body = [
      'Created text file: /project/trending_playlist.txt',
      '',
      'Content (10 trending songs):',
      '1. Morgan Wallen - Been By Now',
      '2. [Top Spotify Global] - Current #1 hit',
    ].join('\n')

    const { text, stripped } = stripQuotedSpeech(body)

    expect(stripped).toBe(0)
    expect(text).toContain('/project/trending_playlist.txt')
    expect(text).toContain('Created text file')
  })

  it('does not let an unmatched quote swallow the rest of the message', () => {
    const body = 'Simon said: "the deploy is green\n\nI then wrote /project/notes.md and pushed it.'
    const { text } = stripQuotedSpeech(body)
    // No closing quote, so nothing is stripped and the Agent's own
    // subsequent claim stays visible.
    expect(text).toContain('/project/notes.md')
  })

  it('returns the body untouched when there is nothing to strip', () => {
    const body = 'Nothing quoted here at all.'
    expect(stripQuotedSpeech(body)).toEqual({ text: body, stripped: 0 })
  })
})
