/**
 * Tests for `task_create_for_agent` (Capability 3 delegation tool).
 *
 * Focused on the runtime contract:
 *   - args schema rejects malformed input
 *   - target validation rejects missing Agents
 *   - depth cap rejects at 5
 *   - successful delegation writes a properly-shaped task to the target's
 *     store with full provenance
 *   - operator-visibility notification lands in the inbox
 *   - missing-task-context guard fires (the future-proofing invariant)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  makeTaskDelegateTools,
  MAX_DELEGATION_DEPTH,
} from '../../../../src/runtime/tools/baseline/task-delegate.js'
import { TaskStore } from '../../../../src/runtime/agent/task/store.js'
import { newPendingTask } from '../../../../src/runtime/agent/task/types.js'
import { agentPaths } from '../../../../src/runtime/storage/layout.js'
import type { ToolContext, ToolDefinition } from '../../../../src/runtime/mcp/tool.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-task-delegate-'))
  // Provision two agents on disk: a caller and a target. The tool only
  // checks for the identity file's existence.
  for (const name of ['caller', 'target']) {
    const ap = agentPaths(home, name)
    await mkdir(ap.root, { recursive: true })
    await writeFile(
      ap.identity,
      '---\nschema_version: 5\nagent_name: ' + name + '\n---\n# ' + name + '\n',
    )
  }
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function tool(): ToolDefinition {
  const tools = makeTaskDelegateTools()
  const t = tools.find((tt) => tt.name === 'task_create_for_agent')
  if (!t) throw new Error('task_create_for_agent not registered')
  return t
}

function ctx(taskId: string | null, callingAgent = 'caller'): ToolContext {
  return {
    callingAgent,
    home,
    brainDir: join(home, 'agents', callingAgent, 'brain'),
    projectDir: join(home, 'agents', callingAgent, 'project'),
    taskId,
    callId: 'call_test',
  }
}

async function seedCallerTask(depth = 0): Promise<string> {
  const store = new TaskStore(home, 'caller')
  const taskId = 'task_' + 'a'.repeat(32)
  const task = newPendingTask({
    id: taskId,
    agent: 'caller',
    title: 'caller current task',
    body: 'caller is doing some work and wants to delegate',
    delegation_depth: depth,
  })
  await store.save(task)
  return taskId
}

describe('task_create_for_agent: args schema', () => {
  it('rejects empty target_agent', () => {
    expect(() => tool().argsSchema.parse({ target_agent: '', title: 'x', body: 'y' })).toThrow()
  })

  it('rejects empty title', () => {
    expect(() =>
      tool().argsSchema.parse({ target_agent: 'target', title: '', body: 'y' }),
    ).toThrow()
  })

  it('rejects title longer than 200 chars', () => {
    expect(() =>
      tool().argsSchema.parse({ target_agent: 'target', title: 'x'.repeat(201), body: 'y' }),
    ).toThrow()
  })

  it('rejects empty body', () => {
    expect(() =>
      tool().argsSchema.parse({ target_agent: 'target', title: 'x', body: '' }),
    ).toThrow()
  })

  it('rejects unknown idempotency value', () => {
    expect(() =>
      tool().argsSchema.parse({
        target_agent: 'target',
        title: 'x',
        body: 'y',
        idempotency: 'whenever',
      }),
    ).toThrow()
  })

  it('defaults idempotency to destructive and priority to 0', () => {
    const parsed = tool().argsSchema.parse({
      target_agent: 'target',
      title: 'x',
      body: 'y',
    }) as { idempotency: string; priority: number }
    expect(parsed.idempotency).toBe('destructive')
    expect(parsed.priority).toBe(0)
  })
})

describe('task_create_for_agent: execute', () => {
  it('throws when ctx.taskId is null (no task context)', async () => {
    await expect(
      tool().execute({ target_agent: 'target', title: 'x', body: 'y' }, ctx(null)),
    ).rejects.toThrow(/task context.*null/i)
  })

  it('throws when the target Agent does not exist', async () => {
    const callerTaskId = await seedCallerTask()
    await expect(
      tool().execute({ target_agent: 'nonexistent', title: 'x', body: 'y' }, ctx(callerTaskId)),
    ).rejects.toThrow(/does not exist/i)
  })

  it('throws when the caller has no matching task in its store', async () => {
    await expect(
      tool().execute({ target_agent: 'target', title: 'x', body: 'y' }, ctx('task_missing')),
    ).rejects.toThrow(/no task with id/i)
  })

  it('throws at the depth cap', async () => {
    const callerTaskId = await seedCallerTask(MAX_DELEGATION_DEPTH)
    await expect(
      tool().execute({ target_agent: 'target', title: 'x', body: 'y' }, ctx(callerTaskId)),
    ).rejects.toThrow(/depth cap reached/i)
  })

  it('writes a properly-shaped task to the target store with provenance', async () => {
    const callerTaskId = await seedCallerTask(2)
    const result = (await tool().execute(
      {
        target_agent: 'target',
        title: 'do the thing',
        body: 'please curate today',
        idempotency: 'destructive',
        priority: 5,
      },
      ctx(callerTaskId),
    )) as { task_id: string; target_agent: string; delegation_depth: number }

    expect(result.task_id).toMatch(/^task_[a-f0-9]{32}$/)
    expect(result.target_agent).toBe('target')
    expect(result.delegation_depth).toBe(3) // parent depth was 2; child is +1

    const targetStore = new TaskStore(home, 'target')
    const created = await targetStore.get(result.task_id)
    expect(created).not.toBeNull()
    expect(created?.frontmatter.title).toBe('do the thing')
    // TaskStore serializer normalizes body to end with a newline.
    expect(created?.body.trimEnd()).toBe('please curate today')
    expect(created?.frontmatter.idempotency).toBe('destructive')
    expect(created?.frontmatter.priority).toBe(5)
    expect(created?.frontmatter.state).toBe('pending')
    expect(created?.frontmatter.delegated_by).toBe('caller')
    expect(created?.frontmatter.delegating_task_id).toBe(callerTaskId)
    expect(created?.frontmatter.delegation_depth).toBe(3)
  })

  it('emits a delegation_observed notification', async () => {
    const callerTaskId = await seedCallerTask()
    await tool().execute({ target_agent: 'target', title: 'X', body: 'Y' }, ctx(callerTaskId))

    const notifDir = join(home, 'state', 'notifications')
    const files = await readdir(notifDir)
    expect(files.length).toBeGreaterThan(0)
    // Find the delegation_observed notification.
    let found = false
    for (const f of files) {
      const body = await readFile(join(notifDir, f), 'utf8')
      if (body.includes('delegation_observed')) {
        found = true
        expect(body).toContain('caller')
        expect(body).toContain('target')
        expect(body).toContain('tier: passive')
        break
      }
    }
    expect(found).toBe(true)
  })

  it('allows self-delegation (agent delegating to itself) up to the cap', async () => {
    const callerTaskId = await seedCallerTask(0)
    const result = (await tool().execute(
      { target_agent: 'caller', title: 'self-task', body: 'breaking my own work into chunks' },
      ctx(callerTaskId),
    )) as { delegation_depth: number }
    expect(result.delegation_depth).toBe(1)
    // The new task should be in the caller's own store now.
    const callerStore = new TaskStore(home, 'caller')
    const tasks = await callerStore.list()
    expect(tasks.some((t) => t.frontmatter.title === 'self-task')).toBe(true)
  })
})
