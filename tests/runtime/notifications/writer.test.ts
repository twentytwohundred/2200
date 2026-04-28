/**
 * Tests for the notification writer + waitForResponse helper
 * (Epic 7 PR D).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  emitNotification,
  waitForResponse,
  NotificationDismissedError,
  NotificationPolicyViolationError,
} from '../../../src/runtime/notifications/writer.js'
import {
  markAnswered,
  markDismissed,
  readNotification,
} from '../../../src/runtime/notifications/reader.js'
import { initHome, initAgentDirs } from '../../../src/runtime/storage/init.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-notif-writer-'))
  await initHome(home)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('emitNotification', () => {
  it('writes a pending notification with canonical frontmatter', async () => {
    const r = await emitNotification({
      home,
      agentName: 'hobby',
      tier: 'normal',
      kind: 'agent_ask',
      body: 'Should I proceed?',
      requiresResponse: true,
      ts: '2026-04-29T10:00:00.000Z',
      id: 'notif_test_1',
    })
    expect(r.id).toBe('notif_test_1')
    const rec = await readNotification(home, 'notif_test_1')
    expect(rec.frontmatter.tier).toBe('normal')
    expect(rec.frontmatter.kind).toBe('agent_ask')
    expect(rec.frontmatter.state).toBe('pending')
    expect(rec.frontmatter.requires_response).toBe(true)
    expect(rec.body.trim()).toBe('Should I proceed?')
  })

  it('preserves emitter-specific extras', async () => {
    const r = await emitNotification({
      home,
      agentName: 'hobby',
      tier: 'important',
      kind: 'budget_warn',
      extras: { cap_usd: 25, cumulative_usd: 20 },
    })
    const rec = await readNotification(home, r.id)
    expect(rec.extras['cap_usd']).toBe(25)
    expect(rec.extras['cumulative_usd']).toBe(20)
  })

  it('does not let extras override canonical fields', async () => {
    const r = await emitNotification({
      home,
      agentName: 'hobby',
      tier: 'passive',
      kind: 'foo',
      extras: { state: 'answered', tier: 'critical', schema_version: 99 },
    })
    const rec = await readNotification(home, r.id)
    expect(rec.frontmatter.state).toBe('pending')
    expect(rec.frontmatter.tier).toBe('passive')
    expect(rec.frontmatter.schema_version).toBe(1)
  })

  it('omits requires_response when not set', async () => {
    const r = await emitNotification({
      home,
      agentName: 'hobby',
      tier: 'passive',
      kind: 'budget_warn',
    })
    const text = await readFile(r.path, 'utf8')
    expect(text).not.toMatch(/requires_response/)
  })
})

describe('waitForResponse', () => {
  it('resolves with the response text when markAnswered runs', async () => {
    const r = await emitNotification({
      home,
      agentName: 'hobby',
      tier: 'important',
      kind: 'agent_ask',
      body: 'go?',
      requiresResponse: true,
    })
    // Schedule the response on the next tick.
    setTimeout(() => {
      void markAnswered(home, r.id, 'yes')
    }, 30)
    const response = await waitForResponse(home, r.id, { pollIntervalMs: 5 })
    expect(response).toBe('yes')
  })

  it('throws NotificationDismissedError when markDismissed runs', async () => {
    const r = await emitNotification({
      home,
      agentName: 'hobby',
      tier: 'important',
      kind: 'agent_ask',
      requiresResponse: true,
    })
    setTimeout(() => {
      void markDismissed(home, r.id)
    }, 30)
    await expect(waitForResponse(home, r.id, { pollIntervalMs: 5 })).rejects.toThrow(
      NotificationDismissedError,
    )
  })

  it('returns "" if the response field is empty', async () => {
    const r = await emitNotification({
      home,
      agentName: 'hobby',
      tier: 'normal',
      kind: 'agent_ask',
      requiresResponse: true,
    })
    setTimeout(() => {
      void markAnswered(home, r.id, '')
    }, 30)
    expect(await waitForResponse(home, r.id, { pollIntervalMs: 5 })).toBe('')
  })

  it('throws on timeout', async () => {
    const r = await emitNotification({
      home,
      agentName: 'hobby',
      tier: 'normal',
      kind: 'agent_ask',
      requiresResponse: true,
    })
    await expect(waitForResponse(home, r.id, { pollIntervalMs: 5, timeoutMs: 50 })).rejects.toThrow(
      /timed out/,
    )
  })

  it('throws on abort', async () => {
    const r = await emitNotification({
      home,
      agentName: 'hobby',
      tier: 'normal',
      kind: 'agent_ask',
      requiresResponse: true,
    })
    const controller = new AbortController()
    setTimeout(() => {
      controller.abort()
    }, 30)
    await expect(
      waitForResponse(home, r.id, { pollIntervalMs: 5, signal: controller.signal }),
    ).rejects.toThrow(/aborted/)
  })

  it('treats file deletion as dismissal', async () => {
    const r = await emitNotification({
      home,
      agentName: 'hobby',
      tier: 'normal',
      kind: 'agent_ask',
      requiresResponse: true,
    })
    setTimeout(() => {
      void rm(r.path).catch(() => undefined)
    }, 30)
    await expect(waitForResponse(home, r.id, { pollIntervalMs: 5 })).rejects.toThrow(
      NotificationDismissedError,
    )
  })
})

describe('emitNotification policy enforcement (Epic 7 PR E)', () => {
  // Seed a real Identity file with the default tier policy so
  // emitNotification can load it when enforcePolicy: true.
  async function seedIdentity(allowedTiers: string[]): Promise<void> {
    const idSrc = join(home, '_seed_identity.md')
    await writeFile(
      idSrc,
      `---
schema_version: 4
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
notification_policy:
  tiers_allowed: [${allowedTiers.join(', ')}]
---

# Identity
hobby
`,
    )
    await initAgentDirs(home, 'hobby', idSrc)
  }

  it('rejects a tier outside tiers_allowed when enforcePolicy: true', async () => {
    await seedIdentity(['passive', 'normal', 'important'])
    await expect(
      emitNotification({
        home,
        agentName: 'hobby',
        tier: 'critical',
        kind: 'agent_ask',
        enforcePolicy: true,
      }),
    ).rejects.toBeInstanceOf(NotificationPolicyViolationError)
  })

  it('allows a tier inside tiers_allowed when enforcePolicy: true', async () => {
    await seedIdentity(['passive', 'normal', 'important'])
    const r = await emitNotification({
      home,
      agentName: 'hobby',
      tier: 'important',
      kind: 'agent_ask',
      enforcePolicy: true,
    })
    expect(r.id).toBeDefined()
  })

  it('skips the policy check when enforcePolicy is omitted (supervisor-driven path)', async () => {
    await seedIdentity(['passive']) // tighter than the supervisor will need
    const r = await emitNotification({
      home,
      agentName: 'hobby',
      tier: 'critical',
      kind: 'budget_block',
      // enforcePolicy omitted: supervisor's BudgetTracker writes critical
      // because the action type warrants it.
    })
    expect(r.id).toBeDefined()
  })

  it('respects an opt-in critical tier in the Identity', async () => {
    await seedIdentity(['passive', 'normal', 'important', 'critical'])
    const r = await emitNotification({
      home,
      agentName: 'hobby',
      tier: 'critical',
      kind: 'agent_ask',
      enforcePolicy: true,
    })
    expect(r.id).toBeDefined()
  })
})
