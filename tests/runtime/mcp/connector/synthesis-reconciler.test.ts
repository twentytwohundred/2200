/**
 * Tests for the SynthesisReconciler. We stub `submitSynthesisTask`
 * + `isAgentRunning` + the audit emitter to exercise the reconciler's
 * decision logic in isolation (debounce, blocked-skip, primary-missing,
 * failure escalation, completion).
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectorAuditEmitter } from '../../../../src/runtime/mcp/connector/audit.js'
import { writeThreadContribution } from '../../../../src/runtime/mcp/connector/contributions.js'
import {
  SynthesisReconciler,
  DEFAULT_DEBOUNCE_WINDOW_MS,
  FAILURE_BLOCK_THRESHOLD,
} from '../../../../src/runtime/mcp/connector/synthesis-reconciler.js'
import { updateAnchorFrontmatter } from '../../../../src/runtime/mcp/connector/synthesis.js'
import { homePaths } from '../../../../src/runtime/storage/layout.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-synthesis-reconciler-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

async function readEmittedNotifications(): Promise<string[]> {
  const dir = homePaths(home).stateNotifications
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  return Promise.all(entries.map((n) => readFile(join(dir, n), 'utf-8')))
}

describe('SynthesisReconciler.runOnce', () => {
  it('skips threads with no pending synthesis', async () => {
    const submit = vi.fn().mockResolvedValue({ taskId: 't1' })
    const audit = new ConnectorAuditEmitter({ home })
    const r = new SynthesisReconciler({
      home,
      audit,
      isAgentRunning: () => true,
      submitSynthesisTask: submit,
      now: () => new Date('2026-05-23T10:00:00Z'),
    })
    await r.runOnce()
    expect(submit).not.toHaveBeenCalled()
  })

  it('skips when debounce window has not elapsed', async () => {
    await writeThreadContribution({
      home,
      threadSlug: 'fresh',
      primaryAgent: 'hobby',
      payload: { research_findings: 'x', reasoning: 'y', sources: [], open_questions: [] },
      now: () => new Date('2026-05-23T10:00:00Z'),
    })
    const submit = vi.fn().mockResolvedValue({ taskId: 't1' })
    const r = new SynthesisReconciler({
      home,
      audit: new ConnectorAuditEmitter({ home }),
      isAgentRunning: () => true,
      submitSynthesisTask: submit,
      // 10s after contribution — still inside the 60s default debounce.
      now: () => new Date('2026-05-23T10:00:10Z'),
    })
    await r.runOnce()
    expect(submit).not.toHaveBeenCalled()
  })

  it('submits when debounce has elapsed + primary Agent is running', async () => {
    await writeThreadContribution({
      home,
      threadSlug: 'ready',
      primaryAgent: 'hobby',
      payload: { research_findings: 'x', reasoning: 'y', sources: [], open_questions: [] },
      now: () => new Date('2026-05-23T10:00:00Z'),
    })
    const submit = vi.fn().mockResolvedValue({ taskId: 't1' })
    const r = new SynthesisReconciler({
      home,
      audit: new ConnectorAuditEmitter({ home }),
      isAgentRunning: (n: string) => n === 'hobby',
      submitSynthesisTask: submit,
      now: () => new Date('2026-05-23T10:01:30Z'), // 90s later > 60s debounce
    })
    await r.runOnce()
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'hobby', threadSlug: 'ready' }),
    )
  })

  it('skips when primary Agent is not running and emits primary_missing once', async () => {
    await writeThreadContribution({
      home,
      threadSlug: 'offline-primary',
      primaryAgent: 'hobby',
      payload: { research_findings: 'x', reasoning: 'y', sources: [], open_questions: [] },
      now: () => new Date('2026-05-23T10:00:00Z'),
    })
    const submit = vi.fn().mockResolvedValue({ taskId: 't1' })
    const audit = new ConnectorAuditEmitter({ home })
    const r = new SynthesisReconciler({
      home,
      audit,
      isAgentRunning: () => false,
      submitSynthesisTask: submit,
      now: () => new Date('2026-05-23T10:02:00Z'),
    })
    await r.runOnce()
    await r.runOnce() // second tick: do NOT re-emit
    expect(submit).not.toHaveBeenCalled()
    const notes = await readEmittedNotifications()
    const missingNotes = notes.filter((n) =>
      n.includes('kind: connector.synthesis_primary_missing'),
    )
    expect(missingNotes).toHaveLength(1)
  })

  it('skips blocked threads entirely', async () => {
    await writeThreadContribution({
      home,
      threadSlug: 'blocked',
      primaryAgent: 'hobby',
      payload: { research_findings: 'x', reasoning: 'y', sources: [], open_questions: [] },
      now: () => new Date('2026-05-23T10:00:00Z'),
    })
    await updateAnchorFrontmatter({
      home,
      threadSlug: 'blocked',
      updates: { synthesis_blocked: true },
    })
    const submit = vi.fn().mockResolvedValue({ taskId: 't1' })
    const r = new SynthesisReconciler({
      home,
      audit: new ConnectorAuditEmitter({ home }),
      isAgentRunning: () => true,
      submitSynthesisTask: submit,
      now: () => new Date('2026-05-23T10:30:00Z'),
    })
    await r.runOnce()
    expect(submit).not.toHaveBeenCalled()
  })

  it('skips when synthesized_through is at or past pending_synthesis_at', async () => {
    await writeThreadContribution({
      home,
      threadSlug: 'caught-up',
      primaryAgent: 'hobby',
      payload: { research_findings: 'x', reasoning: 'y', sources: [], open_questions: [] },
      now: () => new Date('2026-05-23T10:00:00Z'),
    })
    await updateAnchorFrontmatter({
      home,
      threadSlug: 'caught-up',
      updates: { synthesized_through: '2026-05-23T10:00:00.000Z' },
    })
    const submit = vi.fn().mockResolvedValue({ taskId: 't1' })
    const r = new SynthesisReconciler({
      home,
      audit: new ConnectorAuditEmitter({ home }),
      isAgentRunning: () => true,
      submitSynthesisTask: submit,
      now: () => new Date('2026-05-23T10:30:00Z'),
    })
    await r.runOnce()
    expect(submit).not.toHaveBeenCalled()
  })

  it('does not double-submit while a task is in flight', async () => {
    await writeThreadContribution({
      home,
      threadSlug: 'in-flight',
      primaryAgent: 'hobby',
      payload: { research_findings: 'x', reasoning: 'y', sources: [], open_questions: [] },
      now: () => new Date('2026-05-23T10:00:00Z'),
    })
    const submit = vi.fn().mockResolvedValue({ taskId: 't1' })
    const r = new SynthesisReconciler({
      home,
      audit: new ConnectorAuditEmitter({ home }),
      isAgentRunning: () => true,
      submitSynthesisTask: submit,
      now: () => new Date('2026-05-23T10:05:00Z'),
    })
    await r.runOnce()
    await r.runOnce()
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('respects the global synthesis budget cap', async () => {
    // Two threads, both ready. Budget set so only one fits.
    for (const t of ['thread-a', 'thread-b']) {
      await writeThreadContribution({
        home,
        threadSlug: t,
        primaryAgent: 'hobby',
        payload: { research_findings: 'x', reasoning: 'y', sources: [], open_questions: [] },
        now: () => new Date('2026-05-23T10:00:00Z'),
      })
    }
    const submit = vi.fn().mockResolvedValue({ taskId: 't1' })
    const r = new SynthesisReconciler({
      home,
      audit: new ConnectorAuditEmitter({ home }),
      isAgentRunning: () => true,
      submitSynthesisTask: submit,
      now: () => new Date('2026-05-23T10:05:00Z'),
      perSynthesisBudgetUsd: 0.1,
      globalBudgetUsd: 0.15, // fits one $0.10 submission; second is blocked
    })
    await r.runOnce()
    expect(submit).toHaveBeenCalledTimes(1)
  })
})

describe('SynthesisReconciler.observeTaskOutcome', () => {
  it('on done: emits synthesis_completed with the contribution count', async () => {
    await writeThreadContribution({
      home,
      threadSlug: 'done-thread',
      primaryAgent: 'hobby',
      payload: { research_findings: 'x', reasoning: 'y', sources: [], open_questions: [] },
      now: () => new Date('2026-05-23T10:00:00Z'),
    })
    const submit = vi.fn().mockResolvedValue({ taskId: 'task-99' })
    const audit = new ConnectorAuditEmitter({ home })
    const r = new SynthesisReconciler({
      home,
      audit,
      isAgentRunning: () => true,
      submitSynthesisTask: submit,
      now: () => new Date('2026-05-23T10:05:00Z'),
    })
    await r.runOnce()
    await r.observeTaskOutcome({ taskId: 'task-99', status: 'done', contributionCount: 1 })
    const notes = await readEmittedNotifications()
    expect(notes.some((n) => n.includes('kind: connector.synthesis_completed'))).toBe(true)
  })

  it('on failure: increments the counter and escalates to blocked after threshold', async () => {
    await writeThreadContribution({
      home,
      threadSlug: 'failing',
      primaryAgent: 'hobby',
      payload: { research_findings: 'x', reasoning: 'y', sources: [], open_questions: [] },
      now: () => new Date('2026-05-23T10:00:00Z'),
    })
    const audit = new ConnectorAuditEmitter({ home })
    let submitCounter = 0
    const submit = vi.fn().mockImplementation(() => {
      submitCounter += 1
      return Promise.resolve({ taskId: `task-${String(submitCounter)}` })
    })
    // Clock advances across iterations so re-bumped pending_synthesis_at
    // values are in the past by the time the next runOnce checks debounce.
    let nowMs = Date.parse('2026-05-23T10:05:00Z')
    const r = new SynthesisReconciler({
      home,
      audit,
      isAgentRunning: () => true,
      submitSynthesisTask: submit,
      now: () => new Date(nowMs),
    })
    for (let i = 1; i <= FAILURE_BLOCK_THRESHOLD; i++) {
      await r.runOnce()
      await r.observeTaskOutcome({
        taskId: `task-${String(i)}`,
        status: 'errored',
        errorSummary: 'tool failure x',
      })
      // Bump pending_synthesis_at to "now" and advance the clock past
      // the debounce window so the next tick picks the thread up again.
      await updateAnchorFrontmatter({
        home,
        threadSlug: 'failing',
        updates: { pending_synthesis_at: new Date(nowMs).toISOString() },
      })
      nowMs += DEFAULT_DEBOUNCE_WINDOW_MS + 1_000
    }
    const notes = await readEmittedNotifications()
    const failureNotes = notes.filter((n) => n.includes('kind: connector.synthesis_failed'))
    expect(failureNotes.length).toBeGreaterThanOrEqual(FAILURE_BLOCK_THRESHOLD)
    const blockedNote = failureNotes.find((n) => n.includes('blocked: true'))
    expect(blockedNote).toBeDefined()
  })
})

// Re-export the constant for use above without dead-import warnings.
void DEFAULT_DEBOUNCE_WINDOW_MS
