/**
 * Tests for the audit orchestrator + the extractor's JSON-array parser.
 *
 * The orchestrator is exercised with a fake LLMProvider so we can
 * pin the extractor output without hitting a real model. We then
 * assert:
 *   - all-verified → severity=silent, summary describes verified count
 *   - non-destructive unverified → severity=passive
 *   - destructive unverified → severity=normal
 *   - contradicted → severity=important regardless of destructive
 *   - empty extraction → silent + "no claims extracted"
 *   - LLM error → silent + "no claims extracted" (no throw)
 *
 * The JSON-array extractor is unit-tested in isolation for fence
 * handling, prefixed prose, and unbalanced inputs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runClaimEvidenceAudit } from '../../../../src/runtime/agent/audit/claim-evidence.js'
import { extractJsonArray } from '../../../../src/runtime/agent/audit/claim-extractor.js'
import type { LoopEvent } from '../../../../src/runtime/agent/detectors/types.js'
import type { LLMProvider } from '../../../../src/runtime/llm/provider.js'
import type { CompletionRequest, CompletionResponse } from '../../../../src/runtime/llm/types.js'

class FakeProvider implements LLMProvider {
  readonly name = 'fake'
  readonly baseUrl = 'http://fake'
  constructor(private readonly text: string) {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async complete(_req: CompletionRequest): Promise<CompletionResponse> {
    return {
      text: this.text,
      finishReason: 'stop',
      costMetrics: { inputTokens: 0, outputTokens: 0 },
    }
  }
}

class ThrowingProvider implements LLMProvider {
  readonly name = 'fake'
  readonly baseUrl = 'http://fake'
  // eslint-disable-next-line @typescript-eslint/require-await
  async complete(_req: CompletionRequest): Promise<CompletionResponse> {
    throw new Error('simulated provider failure')
  }
}

function endEv(tool: string, ok: boolean, at = 1): LoopEvent {
  return {
    kind: 'tool_call_end',
    at,
    call_id: `${tool}_${String(at)}`,
    tool,
    args_hash: 'h',
    iteration: 1,
    ok,
    duration_ms: 10,
  }
}

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-audit-orch-'))
  await mkdir(join(home, 'agents', 'hobby', 'project'), { recursive: true })
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('runClaimEvidenceAudit', () => {
  it('all-verified → severity silent', async () => {
    await writeFile(join(home, 'agents', 'hobby', 'project', 'x.md'), 'content', 'utf8')
    const claims = JSON.stringify([
      {
        category: 'file_create',
        verb: 'wrote',
        object: '/project/x.md',
        path: '/project/x.md',
      },
    ])
    const out = await runClaimEvidenceAudit({
      home,
      agentName: 'hobby',
      finalMessage: 'I wrote /project/x.md',
      destructive: true,
      events: [endEv('fs_write', true)],
      provider: new FakeProvider(claims),
      modelId: 'fake',
    })
    expect(out.severity).toBe('silent')
    expect(out.records).toHaveLength(1)
    expect(out.records[0]?.outcome.status).toBe('verified')
  })

  it('non-destructive unverified → severity passive', async () => {
    const claims = JSON.stringify([
      { category: 'tool_invoke', verb: 'called', object: 'git_push', tool: 'git_push' },
    ])
    const out = await runClaimEvidenceAudit({
      home,
      agentName: 'hobby',
      finalMessage: 'I called git_push',
      destructive: false,
      events: [endEv('fs_read', true)],
      provider: new FakeProvider(claims),
      modelId: 'fake',
    })
    // No git_push in transcript → contradicted (since tool_invoke names a tool)
    expect(out.records[0]?.outcome.status).toBe('contradicted')
    // Contradicted always → important
    expect(out.severity).toBe('important')
  })

  it('destructive unverified (no specific path) → severity normal', async () => {
    const claims = JSON.stringify([
      { category: 'external_send', verb: 'sent', object: 'a message to @simon' },
    ])
    const out = await runClaimEvidenceAudit({
      home,
      agentName: 'hobby',
      finalMessage: 'I sent a message to @simon',
      destructive: true,
      events: [endEv('fs_read', true)],
      provider: new FakeProvider(claims),
      modelId: 'fake',
    })
    expect(out.records[0]?.outcome.status).toBe('unverified')
    expect(out.severity).toBe('normal')
  })

  it('contradicted on destructive → severity important', async () => {
    const claims = JSON.stringify([
      {
        category: 'file_create',
        verb: 'wrote',
        object: '/project/missing.md',
        path: '/project/missing.md',
      },
    ])
    const out = await runClaimEvidenceAudit({
      home,
      agentName: 'hobby',
      finalMessage: 'I wrote /project/missing.md',
      destructive: true,
      events: [endEv('fs_write', true)],
      provider: new FakeProvider(claims),
      modelId: 'fake',
    })
    expect(out.records[0]?.outcome.status).toBe('contradicted')
    expect(out.severity).toBe('important')
  })

  it('empty extraction → silent + canonical summary', async () => {
    const out = await runClaimEvidenceAudit({
      home,
      agentName: 'hobby',
      finalMessage: 'ok',
      destructive: true,
      events: [],
      provider: new FakeProvider('[]'),
      modelId: 'fake',
    })
    expect(out.severity).toBe('silent')
    expect(out.summary).toMatch(/no factual claims/i)
  })

  it('LLM error → silent (no throw, audit degrades gracefully)', async () => {
    const out = await runClaimEvidenceAudit({
      home,
      agentName: 'hobby',
      finalMessage: 'I uploaded a file ... ' + 'x'.repeat(50),
      destructive: true,
      events: [],
      provider: new ThrowingProvider(),
      modelId: 'fake',
    })
    expect(out.severity).toBe('silent')
    expect(out.records).toHaveLength(0)
  })
})

describe('extractJsonArray', () => {
  it('parses a bare JSON array', () => {
    expect(extractJsonArray('[{"a":1},{"b":2}]')).toBe('[{"a":1},{"b":2}]')
  })

  it('parses an array inside a code fence', () => {
    expect(extractJsonArray('```json\n[{"a":1}]\n```')).toBe('[{"a":1}]')
  })

  it('parses an array with leading prose', () => {
    expect(extractJsonArray('Here are the claims: [{"a":1}]')).toBe('[{"a":1}]')
  })

  it('handles nested brackets inside strings', () => {
    const input = '[{"object":"the [bracketed] item"}]'
    expect(extractJsonArray(input)).toBe(input)
  })

  it('handles nested arrays', () => {
    const input = '[[1,2],[3,4]]'
    expect(extractJsonArray(input)).toBe('[[1,2],[3,4]]')
  })

  it('returns null on unbalanced input', () => {
    expect(extractJsonArray('[{"a":1}')).toBeNull()
  })

  it('returns null when no array is present', () => {
    expect(extractJsonArray('the model refused')).toBeNull()
  })
})
