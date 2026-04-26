/**
 * Tool dispatcher integration tests.
 *
 * Cover the plan/run/perm wrapping end-to-end: a real tool registered
 * in a real registry with a real records writer; dispatch produces
 * three records on disk and the right output. Also tests the perm
 * denial paths (commons_scope, idempotency_compatible, tool_in_set).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { ToolRegistry } from '../../../src/runtime/mcp/registry.js'
import { createInProcessServer } from '../../../src/runtime/mcp/server.js'
import { defineTool } from '../../../src/runtime/mcp/tool.js'
import {
  ToolDispatcher,
  ToolNotFoundError,
  ToolArgsError,
} from '../../../src/runtime/tools/dispatcher.js'
import { initHome, initAgentDirs } from '../../../src/runtime/storage/init.js'
import { homePaths, agentPaths } from '../../../src/runtime/storage/layout.js'
import { fsTools } from '../../../src/runtime/tools/baseline/fs.js'
import { BASELINE_TOOL_NAMES } from '../../../src/runtime/tools/baseline/index.js'

let home: string
let brainDir: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-dispatcher-'))
  await initHome(home)
  // Set up an agent with the canonical layout so paths resolve.
  const sourceIdentity = join(home, 'src.md')
  await writeFile(
    sourceIdentity,
    `---
schema_version: 1
agent_name: hobby
agent_role: "test"
model:
  tier: frontier
  provider: anthropic
  model_id: claude-opus-4-7
tools: []
project_dir: /unused
brain_dir: /unused
created: 2026-04-26
---

# Identity
`,
  )
  await initAgentDirs(home, 'hobby', sourceIdentity)
  brainDir = agentPaths(home, 'hobby').brain
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function buildDispatcher(
  opts: {
    tools?: typeof fsTools
    allowed?: string[]
    agent?: string
  } = {},
): ToolDispatcher {
  const registry = new ToolRegistry()
  const tools = opts.tools ?? fsTools
  registry.register(createInProcessServer('fs', tools))
  return new ToolDispatcher({
    registry,
    allowedToolNames: new Set(opts.allowed ?? BASELINE_TOOL_NAMES),
    home,
    callingAgent: opts.agent ?? 'hobby',
    brainDir,
    projectDir: agentPaths(home, opts.agent ?? 'hobby').project,
  })
}

describe('ToolDispatcher (happy path)', () => {
  it('dispatches a tool, executes, and writes plan/perm/run records', async () => {
    // Pre-create a file in commons/scratch the dispatcher will read.
    const scratchDir = homePaths(home).commonsScratch
    await writeFile(join(scratchDir, 'note.md'), 'hello from scratch')

    const dispatcher = buildDispatcher()
    const result = await dispatcher.dispatch({
      tool: 'fs.read',
      args: { path: '/commons/scratch/note.md' },
      taskId: 'task_test',
      taskIdempotency: 'pure',
      model: 'anthropic/claude-opus-4-7',
      predictedOutcome: 'reads the note',
      reason: 'integration test',
    })
    expect(result.output).toEqual({ content: 'hello from scratch' })
    expect(result.callId).toMatch(/^call_/)

    // Each record kind landed exactly once under brain/.records/<kind>/<task>/<call>.md
    for (const kind of ['plan', 'perm', 'run']) {
      const recordDir = join(brainDir, '.records', kind, 'task_test')
      const entries = await readdir(recordDir)
      expect(entries).toHaveLength(1)
      const content = await readFile(join(recordDir, entries[0] ?? ''), 'utf8')
      expect(content).toMatch(/^---/)
      expect(content).toContain(`call_id: ${result.callId}`)
    }
  })

  it('routes ad-hoc calls (no taskId) under the _no_task segment', async () => {
    await writeFile(join(homePaths(home).commonsScratch, 'a.md'), 'a')
    const dispatcher = buildDispatcher()
    await dispatcher.dispatch({
      tool: 'fs.read',
      args: { path: '/commons/scratch/a.md' },
      taskId: null,
      taskIdempotency: null,
      model: 'anthropic/claude-opus-4-7',
      predictedOutcome: '',
      reason: '',
    })
    const planEntries = await readdir(join(brainDir, '.records', 'plan', '_no_task'))
    expect(planEntries).toHaveLength(1)
  })
})

describe('ToolDispatcher (perm denials)', () => {
  it('denies fs.write to /commons/reference/ via commons_scope', async () => {
    const dispatcher = buildDispatcher()
    await expect(
      dispatcher.dispatch({
        tool: 'fs.write',
        args: { path: '/commons/reference/brand.md', content: 'tampering' },
        taskId: null,
        taskIdempotency: null,
        model: 'anthropic/claude-opus-4-7',
        predictedOutcome: '',
        reason: '',
      }),
    ).rejects.toMatchObject({ name: 'ToolDeniedError', checkType: 'commons_scope' })

    // The file MUST NOT have been created.
    await expect(stat(join(homePaths(home).commonsReference, 'brand.md'))).rejects.toThrow()

    // A perm record DID land showing the denial.
    const permDir = join(brainDir, '.records', 'perm', '_no_task')
    const entries = await readdir(permDir)
    expect(entries).toHaveLength(1)
    const permContent = await readFile(join(permDir, entries[0] ?? ''), 'utf8')
    expect(permContent).toContain('authorized: false')
    expect(permContent).toContain('check_type: commons_scope')
  })

  it('allows fs.read of /commons/reference/ via commons_scope', async () => {
    const refDir = homePaths(home).commonsReference
    await writeFile(join(refDir, 'brand.md'), 'human-curated content')
    const dispatcher = buildDispatcher()
    const result = await dispatcher.dispatch({
      tool: 'fs.read',
      args: { path: '/commons/reference/brand.md' },
      taskId: null,
      taskIdempotency: null,
      model: 'anthropic/claude-opus-4-7',
      predictedOutcome: '',
      reason: '',
    })
    expect(result.output).toEqual({ content: 'human-curated content' })
  })

  it('denies cross-Agent /agents/<other>/shared/... via shared_scope', async () => {
    // Set up a second Agent so the path resolver has somewhere to point.
    const sourceIdentity = join(home, 'simon.md')
    await writeFile(
      sourceIdentity,
      `---
schema_version: 1
agent_name: simon
agent_role: "another agent"
model:
  tier: frontier
  provider: anthropic
  model_id: claude-opus-4-7
tools: []
project_dir: /unused
brain_dir: /unused
created: 2026-04-26
---

# Identity
`,
    )
    await initAgentDirs(home, 'simon', sourceIdentity)
    await writeFile(join(agentPaths(home, 'simon').shared, 'note.md'), 'simon-only')

    const dispatcher = buildDispatcher()
    await expect(
      dispatcher.dispatch({
        tool: 'fs.read',
        args: { path: '/agents/simon/shared/note.md' },
        taskId: null,
        taskIdempotency: null,
        model: 'anthropic/claude-opus-4-7',
        predictedOutcome: '',
        reason: '',
      }),
    ).rejects.toMatchObject({ name: 'ToolDeniedError', checkType: 'commons_scope' })
  })

  it('denies fs.write inside a `pure` task via idempotency_compatible', async () => {
    const dispatcher = buildDispatcher()
    await expect(
      dispatcher.dispatch({
        tool: 'fs.write',
        args: { path: '/commons/scratch/x.md', content: 'x' },
        taskId: 'task_pure',
        taskIdempotency: 'pure',
        model: 'anthropic/claude-opus-4-7',
        predictedOutcome: '',
        reason: '',
      }),
    ).rejects.toMatchObject({ name: 'ToolDeniedError', checkType: 'idempotency_compatible' })
  })

  it('denies a tool not in the Agent allowlist via tool_in_set', async () => {
    const dispatcher = buildDispatcher({ allowed: [] })
    await expect(
      dispatcher.dispatch({
        tool: 'fs.read',
        args: { path: '/commons/scratch/x.md' },
        taskId: null,
        taskIdempotency: null,
        model: 'anthropic/claude-opus-4-7',
        predictedOutcome: '',
        reason: '',
      }),
    ).rejects.toMatchObject({ name: 'ToolDeniedError', checkType: 'tool_in_set' })
  })
})

describe('ToolDispatcher (failure modes other than perm)', () => {
  it('throws ToolNotFoundError for an unregistered tool', async () => {
    const dispatcher = buildDispatcher()
    await expect(
      dispatcher.dispatch({
        tool: 'fs.no_such_tool',
        args: {},
        taskId: null,
        taskIdempotency: null,
        model: 'anthropic/claude-opus-4-7',
        predictedOutcome: '',
        reason: '',
      }),
    ).rejects.toBeInstanceOf(ToolNotFoundError)
  })

  it('throws ToolArgsError on schema violation', async () => {
    const dispatcher = buildDispatcher()
    await expect(
      dispatcher.dispatch({
        tool: 'fs.read',
        args: { wrong_field: 'x' },
        taskId: null,
        taskIdempotency: null,
        model: 'anthropic/claude-opus-4-7',
        predictedOutcome: '',
        reason: '',
      }),
    ).rejects.toBeInstanceOf(ToolArgsError)
  })

  it('throws ToolArgsError on a malformed virtual path', async () => {
    const dispatcher = buildDispatcher()
    await expect(
      dispatcher.dispatch({
        tool: 'fs.read',
        args: { path: '/etc/passwd' },
        taskId: null,
        taskIdempotency: null,
        model: 'anthropic/claude-opus-4-7',
        predictedOutcome: '',
        reason: '',
      }),
    ).rejects.toBeInstanceOf(ToolArgsError)
  })

  it('writes a run record with an error when execute throws', async () => {
    // Custom server with a tool that always throws.
    const failingTool = defineTool({
      name: 'fs.always_throws',
      description: 'test fixture',
      idempotency: 'pure',
      argsSchema: z.object({}),
      execute: () => {
        throw new Error('boom')
      },
    })
    const registry = new ToolRegistry()
    registry.register(createInProcessServer('fs', [failingTool]))
    const dispatcher = new ToolDispatcher({
      registry,
      allowedToolNames: new Set(['fs.always_throws']),
      home,
      callingAgent: 'hobby',
      brainDir,
      projectDir: agentPaths(home, 'hobby').project,
    })

    await expect(
      dispatcher.dispatch({
        tool: 'fs.always_throws',
        args: {},
        taskId: 'task_e',
        taskIdempotency: 'pure',
        model: 'anthropic/claude-opus-4-7',
        predictedOutcome: '',
        reason: '',
      }),
    ).rejects.toThrow(/boom/)

    const runDir = join(brainDir, '.records', 'run', 'task_e')
    const entries = await readdir(runDir)
    expect(entries).toHaveLength(1)
    const content = await readFile(join(runDir, entries[0] ?? ''), 'utf8')
    expect(content).toContain('class: Error')
    expect(content).toContain('message: boom')
  })
})

describe('ToolDispatcher actually creates side effects', () => {
  it('fs.write creates the file under commons/scratch', async () => {
    const dispatcher = buildDispatcher()
    await dispatcher.dispatch({
      tool: 'fs.write',
      args: { path: '/commons/scratch/draft.md', content: 'agent wrote this' },
      taskId: null,
      taskIdempotency: null,
      model: 'anthropic/claude-opus-4-7',
      predictedOutcome: '',
      reason: '',
    })
    const written = await readFile(join(homePaths(home).commonsScratch, 'draft.md'), 'utf8')
    expect(written).toBe('agent wrote this')
  })

  it('fs.list lists entries under commons/reference', async () => {
    const refDir = homePaths(home).commonsReference
    await writeFile(join(refDir, 'a.md'), '')
    await writeFile(join(refDir, 'b.md'), '')
    await mkdir(join(refDir, 'subdir'))
    const dispatcher = buildDispatcher()
    const result = await dispatcher.dispatch({
      tool: 'fs.list',
      args: { path: '/commons/reference' },
      taskId: null,
      taskIdempotency: null,
      model: 'anthropic/claude-opus-4-7',
      predictedOutcome: '',
      reason: '',
    })
    const out = result.output as { entries: { name: string; kind: string }[] }
    const names = out.entries.map((e) => e.name).sort()
    expect(names).toEqual(['a.md', 'b.md', 'subdir'])
  })
})
