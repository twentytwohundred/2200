/**
 * Tests for the file-handoff system-prompt guidance.
 *
 * These exist because of a specific field failure, and they encode what
 * must not regress rather than the exact prose.
 *
 * The operator half of file handoff shipped first: the web app turns
 * any virtual path an Agent mentions into a link to the file browser.
 * Nothing told the Agents that. Asked directly to "hand me the file",
 * an Agent searched its tool set, found no download tool, and replied
 * that it could not ... twice, to the operator, about a file it had
 * already successfully written and named. The Agent was answering
 * correctly from what it knew; the substrate had simply never told it
 * that naming the path IS the handoff.
 *
 * So the load-bearing assertion here is not "the guidance exists" but
 * "the guidance forbids the specific wrong answer." A future edit that
 * trims this section down to a cheerful "mention the path!" would pass
 * a mere presence check and reintroduce the bug.
 */
import { describe, expect, it } from 'vitest'
import { FILE_HANDOFF_GUIDANCE } from '../../../src/runtime/agent/loop.js'

const text = FILE_HANDOFF_GUIDANCE.join('\n')

describe('file-handoff guidance', () => {
  it('tells the Agent no tool is needed, because it will go looking for one', () => {
    expect(text).toMatch(/no download tool/i)
    expect(text).toMatch(/do not need one/i)
  })

  it('forbids the exact answer that failed in the field', () => {
    // "No download/serve tool in my set ... you can grab it directly
    // from there." Both halves of that reply have to be ruled out.
    expect(text).toMatch(/do NOT tell the user you lack a tool/i)
    expect(text).toMatch(/do NOT tell them to go find it on the filesystem/i)
  })

  it('names every virtual root the linkifier actually matches', () => {
    // Drift here is silent: the Agent would confidently name a path in
    // a root the web app does not linkify, and the handoff dies again.
    for (const root of ['/project', '/shared', '/brain', '/commons']) {
      expect(text).toContain(root)
    }
  })

  it('warns that a backticked path is deliberately not linked', () => {
    // The single most likely way an Agent produces a dead handoff: it
    // formats the path as code because that looks tidy.
    expect(text).toMatch(/bare path/i)
    expect(text).toMatch(/code fence|backticks/i)
  })

  it('is honest that connectors have no clickable link', () => {
    // Promising a Discord user a link that cannot exist is worse than
    // the original silence.
    expect(text).toMatch(/Discord/)
    expect(text).toMatch(/nothing to click/i)
  })

  it('points at the browsable tree so the Agent can describe where files live', () => {
    expect(text).toContain('/agent/<your-name>/files')
  })

  it('reads as a markdown section the prompt builder can splice in', () => {
    expect(FILE_HANDOFF_GUIDANCE[0]).toMatch(/^## /)
    expect(FILE_HANDOFF_GUIDANCE.at(-1)).toBe('')
  })
})
