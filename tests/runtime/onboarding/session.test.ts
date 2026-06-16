/**
 * Tests for OnboardingSession (v2: LLM-driven).
 *
 * The fake provider plays back a scripted sequence of directive JSONs
 * for the interviewer system-prompt calls; the summary call returns
 * configurable text. We distinguish interviewer vs summary calls by
 * matching on systemPrompt content (the interviewer prompt always
 * contains the literal string "GOALS").
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

  // Resilience: a flaky / local model must NOT 500 onboarding. On any LLM
  // failure the operator still reaches a confirmable preview (built from the
  // transcript), with a synthesized fallback summary they can refine. This is
  // the fix for Dana's "Q7 of 6 -> internal server error" on a local Gemma.
  it('LLM failure during summary degrades to a preview, not a 500', async () => {
    const session = new OnboardingSession({
      id: 'onb_6',
      script: SCRIPT,
      provider: scriptedProvider({
        directives: ['{"kind":"done"}'],
        errorOnSummary: new Error('llm down'),
      }),
      modelId: 'm',
    })
    const r = await session.submitAnswer('email')
    expect(r.kind).toBe('done')
    expect(session.getState()).toBe('done')
    expect(session.getPreview()).not.toBeNull()
    // fallback summary is synthesized from the operator's own answer
    expect(session.getPreview()?.transcript.summary).toContain('email')
  })

  it('empty summary degrades to a preview with a synthesized summary', async () => {
    const session = new OnboardingSession({
      id: 'onb_7',
      script: SCRIPT,
      provider: scriptedProvider({
        directives: ['{"kind":"done"}'],
        emptySummary: true,
      }),
      modelId: 'm',
    })
    const r = await session.submitAnswer('a research Agent')
    expect(r.kind).toBe('done')
    expect(session.getState()).toBe('done')
    expect(session.getPreview()?.transcript.summary).toContain('research Agent')
  })

  it('interviewer LLM error mid-interview forces done, reaching a preview', async () => {
    const session = new OnboardingSession({
      id: 'onb_6b',
      script: SCRIPT,
      // The interviewer call throws on the first follow-up turn ... the session
      // must force-done and build a preview rather than surface a 500.
      provider: scriptedProvider({
        directives: [],
        errorOnInterviewerTurn: 1,
        summary: 'I am here.',
      }),
      modelId: 'm',
    })
    const r = await session.submitAnswer('I want a scheduling Agent')
    expect(r.kind).toBe('done')
    expect(session.getState()).toBe('done')
    expect(session.getPreview()).not.toBeNull()
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

/**
 * Wizard → capabilities[] wire-up (Phase F §8 closing-the-loop).
 *
 * Lives in its own describe block because it needs a temp catalog
 * dir on disk to exercise the loader's real codepath. Confirms that
 * an interview whose intent_tags overlap a catalog entry's tags ends
 * up with that Capability's id auto-applied into the handoff (which
 * the orchestrator then propagates to Identity, which the orientation
 * pre-renderer reads to embed the walkthrough script).
 */
describe('OnboardingSession: capabilities suggest + auto-apply (Phase F §8)', () => {
  let catalogDir: string
  const TAGS_THAT_MATCH_SCRIPT_GOALS = ['purpose', 'agent_name', 'tools']

  beforeEach(async () => {
    catalogDir = await mkdtemp(join(tmpdir(), '2200-session-cap-'))
    // Fixture with 3 tags that overlap every goal id in SCRIPT.
    // Overlap of 3 >= high_confidence_threshold (2) → default_on.
    const fixture = `---
id: testbed
label: Testbed
category: dev-tooling
description: Synthetic fixture for the session test.
publisher: first-party
auth:
  - name: TESTBED_TOKEN
    kind: api_key
    env_var: TESTBED_TOKEN_REF
    obtain_url: https://example.com/auth
unlocks:
  tools: []
  skills: []
  extensions: []
  providers: []
network_egress:
  domains:
    - example.com
tags:
${TAGS_THAT_MATCH_SCRIPT_GOALS.map((t) => `  - ${t}`).join('\n')}
requires:
  bins: []
  os: []
  capabilities: []
walkthrough:
  estimated_minutes: 5
  difficulty: easy
---

# Setup walkthrough

Body content.
`
    await writeFile(join(catalogDir, 'testbed.md'), fixture, 'utf-8')
    process.env['_2200_CATALOG_DIR'] = catalogDir
  })

  afterEach(async () => {
    delete process.env['_2200_CATALOG_DIR']
    await rm(catalogDir, { recursive: true, force: true })
  })

  it("auto-applies high-confidence Capability suggestions into the handoff's capabilities[]", async () => {
    const session = new OnboardingSession({
      id: 'onb_cap_1',
      script: SCRIPT,
      provider: scriptedProvider({
        directives: [
          // Each LLM response carries a covering: tag that becomes
          // the answer's intent_tag. With 3 overlapping tags, the
          // suggester ranks 'testbed' as high-confidence (default_on).
          '{"kind":"question","text":"Name?","covering":"agent_name"}',
          '{"kind":"question","text":"Tools?","covering":"tools"}',
          '{"kind":"done"}',
        ],
        summary: 'I am a testbed Agent.',
      }),
      modelId: 'm',
      now: () => FIXED,
    })
    await session.submitAnswer('handle some testbed tasks') // intent_tag=purpose (opening)
    await session.submitAnswer('pilot') // intent_tag=agent_name
    const r = await session.submitAnswer('whatever') // intent_tag=tools → done
    if (r.kind !== 'done') throw new Error('expected done')

    // Preview surfaces the ranked suggestions for the (future)
    // operator-override UI.
    expect(r.preview.capabilities).toHaveLength(1)
    expect(r.preview.capabilities[0]?.capability.frontmatter.id).toBe('testbed')
    expect(r.preview.capabilities[0]?.default_on).toBe(true)

    // The load-bearing assertion: the auto-apply baked 'testbed' into
    // the handoff. The orchestrator reads this on confirm → Identity
    // gets capabilities=['testbed'] → orientation embeds the
    // walkthrough script → Agent calls credential_request live.
    expect(r.preview.handoff.frontmatter.capabilities).toEqual(['testbed'])
  })

  it('leaves handoff.capabilities empty when no transcript tag overlaps the catalog', async () => {
    // Override the env to a different empty temp dir so the suggester
    // gets [] back and bypasses auto-apply.
    const emptyDir = await mkdtemp(join(tmpdir(), '2200-session-cap-empty-'))
    process.env['_2200_CATALOG_DIR'] = emptyDir
    try {
      const session = new OnboardingSession({
        id: 'onb_cap_2',
        script: SCRIPT,
        provider: scriptedProvider({
          directives: ['{"kind":"done"}'],
          summary: 'I am the Agent.',
        }),
        modelId: 'm',
        now: () => FIXED,
      })
      const r = await session.submitAnswer('opening')
      if (r.kind !== 'done') throw new Error('expected done')
      expect(r.preview.capabilities).toEqual([])
      expect(r.preview.handoff.frontmatter.capabilities).toEqual([])
    } finally {
      await rm(emptyDir, { recursive: true, force: true })
    }
  })
})

/**
 * Catalog-gap auto-file from the suggest path (Phase F §0a-2 follow-up).
 *
 * Mirrors the catalog fixture from the suggest+auto-apply test above,
 * but routes the suggester through SCRIPT goals whose intent_tags will
 * NOT appear in the catalog's tags[]. Confirms a single gap entry
 * lands in the gaps dir, with the orphan tags surfaced in
 * `related_intent_tags` for tier-2 prioritization. Idempotency on
 * repeat sessions with the same orphan set is also covered.
 */
describe('OnboardingSession: catalog-gap auto-file on unsatisfied suggest', () => {
  let catalogDir: string
  let gapsDir: string

  beforeEach(async () => {
    catalogDir = await mkdtemp(join(tmpdir(), '2200-session-gap-cat-'))
    gapsDir = await mkdtemp(join(tmpdir(), '2200-session-gap-gaps-'))
    // Catalog has one Capability with tags that will NOT overlap the
    // script's goal ids (purpose, agent_name, tools).
    const fixture = `---
id: irrelevant
label: Irrelevant
category: misc
description: A Capability whose tags do not overlap the interview.
publisher: first-party
auth: []
unlocks:
  tools: []
  skills: []
  extensions: []
  providers: []
network_egress:
  domains:
    - example.com
tags:
  - far
  - away
requires:
  bins: []
  os: []
  capabilities: []
walkthrough:
  estimated_minutes: 1
---

# walkthrough
`
    await writeFile(join(catalogDir, 'irrelevant.md'), fixture, 'utf-8')
    process.env['_2200_CATALOG_DIR'] = catalogDir
    process.env['_2200_GAPS_DIR'] = gapsDir
  })

  afterEach(async () => {
    delete process.env['_2200_CATALOG_DIR']
    delete process.env['_2200_GAPS_DIR']
    await rm(catalogDir, { recursive: true, force: true })
    await rm(gapsDir, { recursive: true, force: true })
  })

  it('files one gap entry covering all unmatched intent_tags when the suggest returns no satisfying Capability', async () => {
    const { listCatalogGaps } = await import('../../../src/runtime/onboarding/catalog-gap.js')

    const session = new OnboardingSession({
      id: 'onb_gap_1',
      script: SCRIPT,
      provider: scriptedProvider({
        directives: [
          '{"kind":"question","text":"Name?","covering":"agent_name"}',
          '{"kind":"question","text":"Tools?","covering":"tools"}',
          '{"kind":"done"}',
        ],
        summary: 'I am the Agent.',
      }),
      modelId: 'm',
      now: () => FIXED,
    })
    await session.submitAnswer('handle some tasks') // intent_tag=purpose
    await session.submitAnswer('pilot') // intent_tag=agent_name
    const r = await session.submitAnswer('spotify and feedburner') // intent_tag=tools → done
    if (r.kind !== 'done') throw new Error('expected done')

    // None of the catalog's tags (far, away) overlap the script's
    // goal ids ... preview surfaces no suggestion and no auto-apply.
    expect(r.preview.capabilities).toEqual([])
    expect(r.preview.handoff.frontmatter.capabilities).toEqual([])

    // The auto-file path records exactly one gap with the orphan tags.
    const gaps = await listCatalogGaps({ dir: gapsDir })
    expect(gaps).toHaveLength(1)
    const gap = gaps[0]
    if (!gap) throw new Error('expected one gap')
    expect(gap.frontmatter.context).toBe('onboarding')
    expect(gap.frontmatter.status).toBe('open')
    expect(gap.frontmatter.related_intent_tags).toEqual(['agent_name', 'purpose', 'tools'])
    expect(gap.frontmatter.operator_description).toContain('agent_name')
    expect(gap.frontmatter.operator_description).toContain('purpose')
    expect(gap.frontmatter.operator_description).toContain('tools')
  })

  it('does not double-file when a second session surfaces the same orphan tag-set', async () => {
    const { listCatalogGaps } = await import('../../../src/runtime/onboarding/catalog-gap.js')
    for (const id of ['onb_gap_dup_1', 'onb_gap_dup_2']) {
      const session = new OnboardingSession({
        id,
        script: SCRIPT,
        provider: scriptedProvider({
          directives: [
            '{"kind":"question","text":"Name?","covering":"agent_name"}',
            '{"kind":"question","text":"Tools?","covering":"tools"}',
            '{"kind":"done"}',
          ],
          summary: 'I am the Agent.',
        }),
        modelId: 'm',
        now: () => FIXED,
      })
      await session.submitAnswer('handle some tasks')
      await session.submitAnswer('pilot')
      const r = await session.submitAnswer('whatever')
      if (r.kind !== 'done') throw new Error('expected done')
    }

    // Both sessions had the same orphan tag-set. Idempotency kicked in
    // via if_exists: 'skip' ... only one gap on disk.
    const gaps = await listCatalogGaps({ dir: gapsDir })
    expect(gaps).toHaveLength(1)
  })

  it('does not file a gap when no intent_tags surface (nothing to record)', async () => {
    const { listCatalogGaps } = await import('../../../src/runtime/onboarding/catalog-gap.js')
    // The opening is the only directive; its intent_tag is 'purpose'.
    // Without any further LLM-driven follow-ups, the transcript has
    // exactly one tag. Even one orphan tag still files a gap ... so
    // for the "no gap" case we need an interview that produces ZERO
    // intent_tags. The cleanest path is a script whose opening has
    // no intent_tag.
    const noTagScript: QuestionScript = {
      ...SCRIPT,
      opening: {
        ...SCRIPT.opening,
        intent_tag: undefined,
      },
    }
    const session = new OnboardingSession({
      id: 'onb_gap_zero_tags',
      script: noTagScript,
      provider: scriptedProvider({
        directives: ['{"kind":"done"}'],
        summary: 'I am the Agent.',
      }),
      modelId: 'm',
      now: () => FIXED,
    })
    const r = await session.submitAnswer('something untagged')
    if (r.kind !== 'done') throw new Error('expected done')
    const gaps = await listCatalogGaps({ dir: gapsDir })
    expect(gaps).toHaveLength(0)
  })
})
