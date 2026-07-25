/**
 * Strip other people's words before auditing an Agent's own claims.
 *
 * The claim-evidence audit asks "did this Agent do what it said it
 * did?" That question only makes sense about the Agent's own speech.
 * When an Agent relays a peer ... which is the entire point of the
 * multi-hop relay primitive ... the peer's sentences land inside the
 * Agent's final message, and the extractor happily reads them as
 * claims by the relaying Agent.
 *
 * Field case: Skippy was asked to find out what Jodin was working on.
 * It reported, correctly and usefully:
 *
 *     Jodin replied: "Just migrated in as a fresh agent stub. Reading
 *     continuity-from-migration now to pick up prior context and lane."
 *
 * The audit flagged Skippy for claiming to read a file with no
 * read-class tool call. Skippy claimed nothing of the sort; Jodin did.
 * The flag was not wrong about the transcript, it was wrong about
 * whose transcript to look at.
 *
 * Stripping happens before extraction rather than after, because a
 * claim that never gets extracted cannot be mis-scored later, and
 * because it saves the cheap model tokens on text that is not the
 * Agent's to answer for.
 *
 * **Conservative by construction.** Over-stripping loses a real
 * finding, which is worse than an occasional stray flag, so every
 * pattern here requires an explicit attribution to a named third party.
 * Unattributed quotation marks are left alone: an Agent writing
 * `wrote the header as "Q3 Report"` is quoting itself and must stay
 * auditable.
 */

/**
 * Verbs that introduce reported speech. Deliberately narrow ...
 * "mentioned", "noted" and similar hedges get used by Agents about
 * their own actions often enough that including them would strip
 * first-person claims.
 */
const SPEECH_VERBS = 'replied|said|answered|responded|reported|wrote back|says|writes|told me'

/**
 * `<Name> <speech-verb>[:] "<quoted>"`.
 *
 * The subject must be a capitalized token of at least two characters,
 * which excludes the bare first-person `I` on length alone. `We` and
 * `Our` are excluded explicitly ... an Agent saying "We wrote the file"
 * is still speaking for itself.
 *
 * The quoted span is lazy and bounded so a stray unmatched quote later
 * in a long message cannot swallow the rest of the text.
 */
const ATTRIBUTED_QUOTE_RE = new RegExp(
  String.raw`\b(?!We\b|Our\b)([A-Z][A-Za-z0-9_.'-]{1,30})\s+(?:${SPEECH_VERBS})\b\s*:?\s*["“]([\s\S]{0,2000}?)["”]`,
  'g',
)

/**
 * A markdown blockquote line. The conventional way to render a peer's
 * message, and never how an Agent writes its own claim.
 */
const BLOCKQUOTE_LINE_RE = /^[ \t]*>[^\n]*$/gm

/**
 * The continuation block the substrate itself appends to a task when a
 * peer's reply resumes it. Everything under this heading is by
 * definition someone else's words ... the runtime wrote the heading, so
 * this is an exact marker rather than a heuristic.
 */
const CONTINUATION_HEADING_RE = /^##\s+Continuation:[^\n]*$/gm

export interface StripResult {
  /** The text with third-party speech removed. */
  text: string
  /** How many spans were removed. Zero means the body was untouched. */
  stripped: number
}

/**
 * Remove third-party speech from an Agent's final message.
 *
 * Replaces each removed span with a single space rather than deleting
 * it outright, so surrounding sentences do not fuse into new sentences
 * that were never written.
 */
export function stripQuotedSpeech(body: string): StripResult {
  let stripped = 0

  let text = body.replace(ATTRIBUTED_QUOTE_RE, (_match, subject: string) => {
    stripped += 1
    // Keep the attribution itself. Removing it too would leave a
    // dangling colon and, more importantly, the fact that the Agent
    // relayed something IS its own claim ... just not a claim about
    // reading or writing anything.
    return `${subject} relayed a response. `
  })

  text = text.replace(BLOCKQUOTE_LINE_RE, () => {
    stripped += 1
    return ''
  })

  // Anything after a substrate-authored continuation heading is the
  // peer's message verbatim; drop the remainder of the body.
  const contMatch = CONTINUATION_HEADING_RE.exec(text)
  CONTINUATION_HEADING_RE.lastIndex = 0
  if (contMatch && contMatch.index >= 0) {
    text = text.slice(0, contMatch.index)
    stripped += 1
  }

  return { text, stripped }
}
