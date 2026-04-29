import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { aggregateToolHealth, renderToolHealthMd } from '../../../src/runtime/tools/health.js'
import { recordsRoot } from '../../../src/runtime/tools/records.js'

let brain: string

beforeEach(async () => {
  brain = await mkdtemp(join(tmpdir(), '2200-health-'))
})

afterEach(async () => {
  await rm(brain, { recursive: true, force: true })
})

interface RunArgs {
  taskId: string
  callId: string
  tool: string
  tsEnd: string
  durationMs?: number
  errorClass?: string
}

async function writeRun(args: RunArgs): Promise<void> {
  const dir = join(recordsRoot(brain), 'run', args.taskId)
  await mkdir(dir, { recursive: true })
  const errorBlock = args.errorClass
    ? `error:\n  class: ${args.errorClass}\n  message: it broke\n  retryable: false`
    : 'error: null'
  const fm = `---
schema_version: 1
id: ${args.callId}
ts_start: ${args.tsEnd}
ts_end: ${args.tsEnd}
agent: hobby
task_id: ${args.taskId}
plan_ref: plan-${args.callId}
call_id: ${args.callId}
tool: ${args.tool}
inputs: {}
output: null
output_ref: null
${errorBlock}
duration_ms: ${String(args.durationMs ?? 12)}
cost_metrics: {}
---

# Run ${args.callId}
`
  await writeFile(join(dir, `${args.callId}.md`), fm, 'utf8')
}

describe('aggregateToolHealth', () => {
  it('returns empty summary when there are no records', async () => {
    const s = await aggregateToolHealth(brain, 'hobby')
    expect(s.tools).toEqual([])
    expect(s.dormant).toEqual([])
    expect(s.failing).toEqual([])
    expect(s.total_records).toBe(0)
  })

  it('aggregates calls per tool with success/failure counts', async () => {
    const now = new Date('2026-04-29T20:00:00.000Z')
    await writeRun({
      taskId: 't1',
      callId: 'c1',
      tool: 'fs.read',
      tsEnd: new Date(now.getTime() - 60_000).toISOString(),
    })
    await writeRun({
      taskId: 't1',
      callId: 'c2',
      tool: 'fs.read',
      tsEnd: new Date(now.getTime() - 30_000).toISOString(),
    })
    await writeRun({
      taskId: 't1',
      callId: 'c3',
      tool: 'github.list_issues',
      tsEnd: new Date(now.getTime() - 10_000).toISOString(),
      errorClass: 'NetworkError',
      durationMs: 500,
    })
    const s = await aggregateToolHealth(brain, 'hobby', { now: () => now })
    expect(s.total_records).toBe(3)
    expect(s.tools).toHaveLength(2)
    const fsread = s.tools.find((t) => t.tool === 'fs.read')!
    expect(fsread.total_calls).toBe(2)
    expect(fsread.ok_calls).toBe(2)
    expect(fsread.error_calls).toBe(0)
    const gh = s.tools.find((t) => t.tool === 'github.list_issues')!
    expect(gh.error_calls).toBe(1)
    expect(gh.last_error_at).toBe(new Date(now.getTime() - 10_000).toISOString())
  })

  it('flags tools as dormant past the threshold', async () => {
    const now = new Date('2026-04-29T20:00:00.000Z')
    const longAgo = new Date(now.getTime() - 60 * 24 * 60 * 60_000).toISOString()
    const recent = new Date(now.getTime() - 60_000).toISOString()
    await writeRun({ taskId: 't1', callId: 'old', tool: 'shell.run', tsEnd: longAgo })
    await writeRun({ taskId: 't1', callId: 'new', tool: 'fs.read', tsEnd: recent })
    const s = await aggregateToolHealth(brain, 'hobby', {
      now: () => now,
      dormantThresholdDays: 30,
    })
    const dormantTools = s.dormant.map((t) => t.tool)
    expect(dormantTools).toContain('shell.run')
    expect(dormantTools).not.toContain('fs.read')
  })

  it('reports recent_failure_rate over the configured window', async () => {
    const now = new Date('2026-04-29T20:00:00.000Z')
    // 5 calls; 3 errors; recentFailureRate = 3/5 = 0.6
    for (let i = 0; i < 5; i++) {
      const args: RunArgs = {
        taskId: 't1',
        callId: `c${String(i)}`,
        tool: 'http.fetch',
        tsEnd: new Date(now.getTime() - (5 - i) * 1_000).toISOString(),
      }
      if (i < 3) args.errorClass = 'NetworkError'
      await writeRun(args)
    }
    const s = await aggregateToolHealth(brain, 'hobby', {
      now: () => now,
      recentFailureWindow: 5,
    })
    const t = s.tools.find((x) => x.tool === 'http.fetch')!
    expect(t.recent_failure_rate).toBeCloseTo(0.6, 5)
    expect(s.failing.map((x) => x.tool)).toContain('http.fetch')
  })

  it('does not flag a tool as failing with too few recent calls', async () => {
    const now = new Date('2026-04-29T20:00:00.000Z')
    await writeRun({
      taskId: 't1',
      callId: 'a',
      tool: 'http.fetch',
      tsEnd: new Date(now.getTime() - 1_000).toISOString(),
      errorClass: 'X',
    })
    const s = await aggregateToolHealth(brain, 'hobby', { now: () => now })
    expect(s.failing.map((t) => t.tool)).not.toContain('http.fetch')
  })

  it('walks task subdirectories under .records/run', async () => {
    const now = new Date('2026-04-29T20:00:00.000Z')
    await writeRun({
      taskId: 'task-A',
      callId: 'a',
      tool: 'fs.read',
      tsEnd: new Date(now.getTime() - 1_000).toISOString(),
    })
    await writeRun({
      taskId: 'task-B',
      callId: 'b',
      tool: 'fs.read',
      tsEnd: new Date(now.getTime() - 2_000).toISOString(),
    })
    await writeRun({
      taskId: '_no_task',
      callId: 'c',
      tool: 'fs.read',
      tsEnd: new Date(now.getTime() - 3_000).toISOString(),
    })
    const s = await aggregateToolHealth(brain, 'hobby', { now: () => now })
    const t = s.tools.find((x) => x.tool === 'fs.read')!
    expect(t.total_calls).toBe(3)
  })

  it('skips malformed run records without crashing', async () => {
    const dir = join(recordsRoot(brain), 'run', 'task-A')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'broken.md'), 'not a frontmatter doc', 'utf8')
    const now = new Date('2026-04-29T20:00:00.000Z')
    await writeRun({
      taskId: 'task-A',
      callId: 'good',
      tool: 'fs.read',
      tsEnd: new Date(now.getTime() - 1_000).toISOString(),
    })
    const s = await aggregateToolHealth(brain, 'hobby', { now: () => now })
    expect(s.total_records).toBe(1)
  })
})

describe('renderToolHealthMd', () => {
  it('renders empty summary placeholder', () => {
    const md = renderToolHealthMd({
      agent: 'hobby',
      generated_at: '2026-04-29T20:00:00.000Z',
      total_records: 0,
      tools: [],
      dormant: [],
      failing: [],
      options: { dormant_threshold_days: 30, recent_failure_window: 20 },
    })
    expect(md).toMatch(/# Tool health for hobby/)
    expect(md).toMatch(/no tool calls recorded yet/)
  })

  it('renders failing + dormant + all-tools sections when populated', async () => {
    const now = new Date('2026-04-29T20:00:00.000Z')
    await writeRun({
      taskId: 't1',
      callId: 'a',
      tool: 'fs.read',
      tsEnd: new Date(now.getTime() - 1_000).toISOString(),
    })
    for (let i = 0; i < 5; i++) {
      await writeRun({
        taskId: 't1',
        callId: `f${String(i)}`,
        tool: 'http.fetch',
        tsEnd: new Date(now.getTime() - (5 - i) * 100).toISOString(),
        errorClass: 'X',
      })
    }
    await writeRun({
      taskId: 't1',
      callId: 'old',
      tool: 'shell.run',
      tsEnd: new Date(now.getTime() - 90 * 24 * 60 * 60_000).toISOString(),
    })
    const s = await aggregateToolHealth(brain, 'hobby', { now: () => now })
    const md = renderToolHealthMd(s)
    expect(md).toMatch(/## Failing/)
    expect(md).toMatch(/`http.fetch`/)
    expect(md).toMatch(/## Dormant/)
    expect(md).toMatch(/`shell.run`/)
    expect(md).toMatch(/## All tools/)
  })
})
