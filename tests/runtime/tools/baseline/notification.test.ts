/**
 * Tests for the notification.* baseline tools.
 *
 * `notification_ask` is exercised end-to-end via the AgentLoop in
 * loop.test.ts. This file covers `notification_inform` directly
 * because it's the simpler fire-and-forget surface (Epic 7 Phase B).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { notificationTools } from '../../../../src/runtime/tools/baseline/notification.js'
import { initHome, initAgentDirs } from '../../../../src/runtime/storage/init.js'
import { listNotifications } from '../../../../src/runtime/notifications/reader.js'
import { agentPaths } from '../../../../src/runtime/storage/layout.js'
import type { ToolContext } from '../../../../src/runtime/mcp/tool.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-notif-inform-'))
  await initHome(home)
  // Bootstrap a hobby Agent with a default notification policy
  // (passive / normal / important allowed by default).
  const idSrc = join(home, '_seed_identity.md')
  await writeFile(
    idSrc,
    `---
schema_version: 1
agent_name: hobby
agent_role: build agent
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

Test agent.
`,
    'utf8',
  )
  await initAgentDirs(home, 'hobby', idSrc)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function findInformTool() {
  const tool = notificationTools.find((t) => t.name === 'notification_inform')
  if (!tool) throw new Error('notification.inform missing from baseline')
  return tool
}

/**
 * Parse args through the tool's schema (the way the dispatcher does
 * before calling execute) so zod defaults are applied. Calling
 * tool.execute directly with a partial input would skip the parse
 * and lose the defaults.
 */
async function callTool(tool: ReturnType<typeof findInformTool>, raw: unknown) {
  const args = tool.argsSchema.parse(raw)
  return await tool.execute(args, ctx())
}

function ctx(): ToolContext {
  const ap = agentPaths(home, 'hobby')
  return {
    callingAgent: 'hobby',
    home,
    brainDir: ap.brain,
    projectDir: ap.project,
    taskId: 'task_test_1',
    callId: 'call_test_1',
  }
}

describe('notification_inform', () => {
  it('is registered in notificationTools', () => {
    expect(notificationTools.map((t) => t.name)).toContain('notification_inform')
  })

  it('writes a pending non-response notification and returns immediately', async () => {
    const tool = findInformTool()
    const result = (await callTool(tool, {
      tier: 'normal',
      body: 'New message arrived in #ops',
      kind: 'inbox_arrival',
    })) as { notification_id: string; status: 'emitted' }

    expect(result.status).toBe('emitted')
    expect(result.notification_id).toMatch(/^notif_/)

    const list = await listNotifications(home, {})
    expect(list.length).toBe(1)
    const entry = list[0]!
    expect(entry.frontmatter.kind).toBe('inbox_arrival')
    expect(entry.frontmatter.tier).toBe('normal')
    // The writer omits `requires_response` from the frontmatter when
    // false (only writes the field on `true`). Reading it back returns
    // undefined, which is the documented "fire-and-forget" shape.
    expect(entry.frontmatter.requires_response).toBeUndefined()
    expect(entry.frontmatter.state).toBe('pending')
    expect(entry.body.trim()).toBe('New message arrived in #ops')
  })

  it('defaults kind to agent_inform when omitted', async () => {
    const tool = findInformTool()
    await callTool(tool, { tier: 'passive', body: 'Background activity' })
    const list = await listNotifications(home, {})
    expect(list[0]?.frontmatter.kind).toBe('agent_inform')
  })

  it('does NOT block on user response (returns synchronously)', async () => {
    const tool = findInformTool()
    const start = Date.now()
    await callTool(tool, {
      tier: 'passive',
      body: 'fire-and-forget proof',
      kind: 'inbox_arrival',
    })
    const duration = Date.now() - start
    // Generous bound: the call must NOT wait on a user response.
    // notification.ask would block here indefinitely; inform must
    // return in < 200ms even on a slow CI runner.
    expect(duration).toBeLessThan(200)
  })

  it('refuses tiers outside the agents notification_policy.tiers_allowed', async () => {
    // Default policy from initAgentDirs allows passive/normal/important.
    // critical is excluded ... an Agent that tries to escalate must be
    // refused per CLAUDE.md "Agents cannot escalate their own priority".
    const tool = findInformTool()
    await expect(callTool(tool, { tier: 'critical', body: 'tries to escalate' })).rejects.toThrow(
      /policy|critical/i,
    )
  })

  it('passes the calling task_id through to the notification extras', async () => {
    const tool = findInformTool()
    await callTool(tool, { tier: 'normal', body: 'with task ref', kind: 'inbox_arrival' })
    const list = await listNotifications(home, {})
    // task_id lands as a passthrough field; lives on `extras` not the
    // canonical frontmatter (the schema's typed fields).
    expect(list[0]?.extras['task_id']).toBe('task_test_1')
  })

  it('rejects empty body', () => {
    const tool = findInformTool()
    const parsed = tool.argsSchema.safeParse({ tier: 'passive', body: '' })
    expect(parsed.success).toBe(false)
  })
})
