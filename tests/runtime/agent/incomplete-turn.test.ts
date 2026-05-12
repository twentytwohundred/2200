/**
 * Unit tests for the planning-only resolver. Pure function over inputs;
 * loop integration is covered by tests/runtime/agent/loop-incomplete-turn.test.ts.
 *
 * Reference: wiki/decisions/2026-05-12-incomplete-turn-detector.md
 */
import { describe, expect, it } from 'vitest'
import {
  isActionableUserMessage,
  PLANNING_ONLY_RETRY_INSTRUCTION,
  resolvePlanningOnlyRetry,
} from '../../../src/runtime/agent/incomplete-turn.js'

function baseInput(
  overrides: Partial<Parameters<typeof resolvePlanningOnlyRetry>[0]> = {},
): Parameters<typeof resolvePlanningOnlyRetry>[0] {
  return {
    assistantText: "I'll check the logs and report back.",
    lastUserMessage: 'Can you check the logs and tell me the status?',
    priorToolCallsSucceeded: false,
    ...overrides,
  }
}

describe('resolvePlanningOnlyRetry', () => {
  describe('fires on canonical planning-only patterns', () => {
    it("returns the retry instruction for 'I'll do X' with action verb", () => {
      const result = resolvePlanningOnlyRetry(baseInput())
      expect(result).toBe(PLANNING_ONLY_RETRY_INSTRUCTION)
    })

    it("fires on 'let me check'", () => {
      expect(
        resolvePlanningOnlyRetry(
          baseInput({ assistantText: 'Let me check the brain notes first.' }),
        ),
      ).toBe(PLANNING_ONLY_RETRY_INSTRUCTION)
    })

    it("fires on 'I'm going to investigate'", () => {
      expect(
        resolvePlanningOnlyRetry(
          baseInput({ assistantText: "I'm going to investigate the failure." }),
        ),
      ).toBe(PLANNING_ONLY_RETRY_INSTRUCTION)
    })

    it("fires on 'first I'll'", () => {
      expect(
        resolvePlanningOnlyRetry(
          baseInput({ assistantText: "First I'll read the spec, then write the code." }),
        ),
      ).toBe(PLANNING_ONLY_RETRY_INSTRUCTION)
    })

    it("fires on structured 'Plan:' heading with bullets", () => {
      const text = ['Plan:', '- read the file', '- write the patch', '- run tests'].join('\n')
      expect(resolvePlanningOnlyRetry(baseInput({ assistantText: text }))).toBe(
        PLANNING_ONLY_RETRY_INSTRUCTION,
      )
    })

    it("fires on 'Steps:' heading with numbered list", () => {
      const text = [
        'Steps:',
        '1. inspect the dispatcher',
        '2. add the resolver',
        '3. wire it in',
      ].join('\n')
      expect(resolvePlanningOnlyRetry(baseInput({ assistantText: text }))).toBe(
        PLANNING_ONLY_RETRY_INSTRUCTION,
      )
    })

    it('fires when promise verb appears mid-sentence', () => {
      expect(
        resolvePlanningOnlyRetry(
          baseInput({
            assistantText:
              "Thanks for the request. Next I'll read the dashboard and summarize the findings.",
          }),
        ),
      ).toBe(PLANNING_ONLY_RETRY_INSTRUCTION)
    })
  })

  describe('returns null when completion claims are present', () => {
    it("suppresses when text contains 'done'", () => {
      expect(
        resolvePlanningOnlyRetry(
          baseInput({
            assistantText: "I'll quickly note that the logs check is done; nothing unusual.",
          }),
        ),
      ).toBeNull()
    })

    it("suppresses when text contains 'finished'", () => {
      expect(
        resolvePlanningOnlyRetry(
          baseInput({
            assistantText: 'Let me confirm: I finished reading the logs. All clean.',
          }),
        ),
      ).toBeNull()
    })

    it("suppresses when text contains 'created'", () => {
      expect(
        resolvePlanningOnlyRetry(
          baseInput({
            assistantText: 'Let me show you: I created the playlist and added the tracks.',
          }),
        ),
      ).toBeNull()
    })

    it("suppresses when text contains 'sent'", () => {
      expect(
        resolvePlanningOnlyRetry(
          baseInput({
            assistantText: 'Let me note: I sent the message to Simon already.',
          }),
        ),
      ).toBeNull()
    })
  })

  describe('returns null when prior tool calls succeeded', () => {
    it('suppresses when priorToolCallsSucceeded is true', () => {
      expect(
        resolvePlanningOnlyRetry(
          baseInput({
            assistantText: "I'll now write up the findings.",
            priorToolCallsSucceeded: true,
          }),
        ),
      ).toBeNull()
    })
  })

  describe('returns null when the user message is not actionable', () => {
    it("suppresses for a bare 'ok'", () => {
      expect(
        resolvePlanningOnlyRetry(
          baseInput({
            assistantText: "I'll keep an eye out then.",
            lastUserMessage: 'ok',
          }),
        ),
      ).toBeNull()
    })

    it("suppresses for 'thanks'", () => {
      expect(
        resolvePlanningOnlyRetry(
          baseInput({
            assistantText: "I'll be here if anything changes.",
            lastUserMessage: 'thanks',
          }),
        ),
      ).toBeNull()
    })

    it('suppresses for a statement with no question or directive', () => {
      expect(
        resolvePlanningOnlyRetry(
          baseInput({
            assistantText: "I'll go ahead and start thinking about that next.",
            lastUserMessage: 'just a heads up, the deploy went out an hour ago',
          }),
        ),
      ).toBeNull()
    })
  })

  describe('returns null on shape mismatches', () => {
    it('suppresses on empty text', () => {
      expect(resolvePlanningOnlyRetry(baseInput({ assistantText: '' }))).toBeNull()
    })

    it('suppresses on whitespace-only text', () => {
      expect(resolvePlanningOnlyRetry(baseInput({ assistantText: '   \n  ' }))).toBeNull()
    })

    it('suppresses on text longer than the planning-only cap', () => {
      const long = "I'll check the logs. ".repeat(80)
      expect(resolvePlanningOnlyRetry(baseInput({ assistantText: long }))).toBeNull()
    })

    it('suppresses when text contains a fenced code block (model is mid-response with code)', () => {
      const text = ["I'll write the helper:", '', '```ts', 'function foo() {}', '```'].join('\n')
      expect(resolvePlanningOnlyRetry(baseInput({ assistantText: text }))).toBeNull()
    })

    it('suppresses when text has no promise verb and no plan heading', () => {
      expect(
        resolvePlanningOnlyRetry(
          baseInput({
            assistantText: 'The dashboard shows healthy metrics across the board.',
          }),
        ),
      ).toBeNull()
    })

    it('suppresses when promise verb appears but no action verb is present', () => {
      expect(
        resolvePlanningOnlyRetry(
          baseInput({
            assistantText: "I'll be honest with you ... that's a tricky question.",
          }),
        ),
      ).toBeNull()
    })
  })
})

describe('isActionableUserMessage', () => {
  it("returns true on 'can you' phrasing", () => {
    expect(isActionableUserMessage('can you read the spec and summarize it?')).toBe(true)
  })

  it("returns true on 'please' phrasing", () => {
    expect(isActionableUserMessage('please update the playlist cover')).toBe(true)
  })

  it('returns true on a leading directive verb', () => {
    expect(isActionableUserMessage('check the supervisor logs')).toBe(true)
  })

  it('returns true on a question mark', () => {
    expect(isActionableUserMessage("what's the deploy status?")).toBe(true)
  })

  it("returns false for bare 'ok'", () => {
    expect(isActionableUserMessage('ok')).toBe(false)
  })

  it("returns false for 'thanks'", () => {
    expect(isActionableUserMessage('thanks')).toBe(false)
  })

  it('returns false for empty text', () => {
    expect(isActionableUserMessage('')).toBe(false)
  })

  it('returns false for a statement-only message', () => {
    expect(isActionableUserMessage('the deploy went out an hour ago')).toBe(false)
  })
})
