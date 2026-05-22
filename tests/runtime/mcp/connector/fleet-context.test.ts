/**
 * Tests for `buildFleetContext`. Exercise the shape of the orientation
 * packet across the small + empty + populated cases.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFleetContext } from '../../../../src/runtime/mcp/connector/fleet-context.js'
import { writeThreadContribution } from '../../../../src/runtime/mcp/connector/contributions.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-fleet-context-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

const emptySnapshot = (): {
  schema_version: 1
  home: string
  state_dir: string
  agents: Record<string, never>
  pubs: Record<string, never>
} => ({
  schema_version: 1,
  home,
  state_dir: home + '/state',
  agents: {},
  pubs: {},
})

describe('buildFleetContext', () => {
  it('returns an empty-but-well-shaped packet on a fresh home', async () => {
    const packet = await buildFleetContext({
      home,
      snapshot: emptySnapshot,
    })
    expect(packet.schema_version).toBe(1)
    expect(packet.agents).toEqual([])
    expect(packet.threads).toEqual([])
    expect(packet.recent_activity).toEqual([])
    expect(packet.served_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('lists active research threads sorted by last_contribution_at descending', async () => {
    await writeThreadContribution({
      home,
      threadSlug: 'first-thread',
      displayName: 'First thread',
      payload: { research_findings: 'a', reasoning: 'b', sources: [], open_questions: [] },
      now: () => new Date('2026-05-22T10:00:00.000Z'),
    })
    await writeThreadContribution({
      home,
      threadSlug: 'second-thread',
      displayName: 'Second thread',
      payload: { research_findings: 'c', reasoning: 'd', sources: [], open_questions: [] },
      now: () => new Date('2026-05-22T11:00:00.000Z'),
    })
    const packet = await buildFleetContext({ home, snapshot: emptySnapshot })
    expect(packet.threads.map((t) => t.slug)).toEqual(['second-thread', 'first-thread'])
    expect(packet.threads[0]?.display_name).toBe('Second thread')
    expect(packet.threads[0]?.contribution_count).toBe(1)
  })

  it('summarizes Agents from the supervisor snapshot', async () => {
    const packet = await buildFleetContext({
      home,
      snapshot: () => ({
        schema_version: 1 as const,
        home,
        state_dir: home + '/state',
        agents: {
          hobby: {
            name: 'hobby',
            identity_path: '/x',
            state: 'running' as const,
            pid: 123,
            created_at: '2026-05-22T10:00:00Z',
            last_heartbeat: '2026-05-22T10:05:00Z',
            errored_at: null,
            errored_reason: null,
            current_task_id: 'task_x',
          },
        },
        pubs: {},
      }),
    })
    expect(packet.agents).toHaveLength(1)
    expect(packet.agents[0]).toMatchObject({
      name: 'hobby',
      state: 'running',
      current_task_id: 'task_x',
      last_heartbeat: '2026-05-22T10:05:00Z',
    })
  })
})
