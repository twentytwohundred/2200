/**
 * Tests for `buildOrientationTaskBody`. Covers the v0.2 shape after
 * Phase F §8 integration (walkthroughRender is now a first-class
 * argument; Phase 4 is the rendered walkthrough or absent).
 */
import { describe, expect, it } from 'vitest'
import { buildOrientationTaskBody } from '../../../src/runtime/onboarding/starter-pack.js'

const COMMON_ARGS = {
  agentName: 'hobby',
  agentRole: 'build agent',
  operatorAddressing: 'Doug',
}

describe('buildOrientationTaskBody: no walkthrough render', () => {
  it('produces a four-phase body when walkthroughRender is undefined', () => {
    const body = buildOrientationTaskBody(COMMON_ARGS)
    expect(body).toContain('This task has four phases.')
    expect(body).toContain('## Phase 1 ... read the shared brain')
    expect(body).toContain('## Phase 2 ... write to your own brain')
    expect(body).toContain('## Phase 3 ... walk into the Studio')
    expect(body).toContain('## Phase 4 ... report ready to the operator')
    expect(body).not.toContain('## Phase 5')
    expect(body).not.toContain('Phase 4 ... walk the operator through the credentials')
    // The closing brief mentions Studio + brain note, NOT the
    // walkthrough credentials (since none were declared).
    expect(body).toContain(
      'introduced myself in the Studio and written my intro-snapshot brain note',
    )
    expect(body).not.toContain('walked through the credentials')
  })

  it('produces a four-phase body when walkthroughRender is empty string', () => {
    const body = buildOrientationTaskBody({ ...COMMON_ARGS, walkthroughRender: '' })
    expect(body).toContain('This task has four phases.')
    expect(body).not.toContain('## Phase 5')
  })

  it('produces a four-phase body when walkthroughRender is whitespace-only', () => {
    const body = buildOrientationTaskBody({ ...COMMON_ARGS, walkthroughRender: '   \n\t  \n' })
    expect(body).toContain('This task has four phases.')
    expect(body).not.toContain('## Phase 5')
  })
})

describe('buildOrientationTaskBody: with walkthrough render', () => {
  const WT_RENDER = `I need to set up one integration: **Gmail**.

Estimated time: about 8 minutes.

---

## Gmail
Read and label mail.
**What I'll ask for:** 1 credential (\`GMAIL_OAUTH_REF\`).
---
# Setup walkthrough
Step 1...`

  it('produces a five-phase body when walkthroughRender is provided', () => {
    const body = buildOrientationTaskBody({ ...COMMON_ARGS, walkthroughRender: WT_RENDER })
    expect(body).toContain('This task has five phases.')
    expect(body).toContain('## Phase 4 ... walk the operator through the credentials you need')
    expect(body).toContain('## Phase 5 ... report ready to the operator')
  })

  it('embeds the walkthroughRender verbatim under the Phase 4 instructions', () => {
    const body = buildOrientationTaskBody({ ...COMMON_ARGS, walkthroughRender: WT_RENDER })
    expect(body).toContain(WT_RENDER)
    // Sanity: the embedded content appears AFTER Phase 4's instructions
    const phase4Idx = body.indexOf('## Phase 4')
    const embeddedIdx = body.indexOf(WT_RENDER)
    expect(phase4Idx).toBeLessThan(embeddedIdx)
  })

  it('instructs the Agent to chat_send the intro then loop per-Capability section', () => {
    const body = buildOrientationTaskBody({ ...COMMON_ARGS, walkthroughRender: WT_RENDER })
    expect(body).toMatch(/`chat_send` to Doug with the introduction paragraph/)
    expect(body).toMatch(/`credential_request` with: `credential_name`/)
    expect(body).toMatch(/If `fulfilled`: `chat_send` a one-line ack/)
    expect(body).toMatch(/If `declined` or `expired`: `chat_send` a one-line "skipping for now/)
  })

  it('closing brief acknowledges the walkthrough when one ran', () => {
    const body = buildOrientationTaskBody({ ...COMMON_ARGS, walkthroughRender: WT_RENDER })
    expect(body).toContain('walked through the credentials I needed')
  })
})

describe('buildOrientationTaskBody: operatorAddressing substitution', () => {
  it('substitutes operatorAddressing into the orientation phases', () => {
    const body = buildOrientationTaskBody({ ...COMMON_ARGS, operatorAddressing: 'MrDoug' })
    // The embedded seed-note body refers to "the operator" as a
    // generic concept (docs prose, not substituted). What MUST be
    // substituted is the orientation-specific addressing in Phase 3+.
    expect(body).toContain('MrDoug')
    expect(body).toMatch(/`chat_send` to MrDoug/)
  })

  it('substitutes operatorAddressing in the Phase 4 walkthrough instructions too', () => {
    const body = buildOrientationTaskBody({
      ...COMMON_ARGS,
      operatorAddressing: 'MrDoug',
      walkthroughRender: 'walkthrough body here',
    })
    expect(body).toMatch(/`chat_send` to MrDoug with the introduction paragraph/)
  })
})

describe('buildOrientationTaskBody: phase counts', () => {
  it("does NOT contain the PR #207 interim 'ask for the credentials your lane needs' prompt", () => {
    // The structural fix replaces the heuristic; the interim prompt-
    // only flow should be gone (per the interim-patches-don't-
    // accumulate discipline).
    const withWalkthrough = buildOrientationTaskBody({
      ...COMMON_ARGS,
      walkthroughRender: 'wt',
    })
    const noWalkthrough = buildOrientationTaskBody(COMMON_ARGS)
    expect(withWalkthrough).not.toContain('ask for the credentials your lane needs')
    expect(noWalkthrough).not.toContain('ask for the credentials your lane needs')
    // The Phase 4 with walkthrough is the structural version (mentions
    // "walk the operator through").
    expect(withWalkthrough).toContain('walk the operator through the credentials you need')
  })
})
