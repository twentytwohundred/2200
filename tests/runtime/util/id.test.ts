import { describe, expect, it } from 'vitest'
import {
  newAgentId,
  newCallId,
  newDetectorTripId,
  newNotificationId,
  newPermId,
  newPlanId,
  newRunId,
  newTaskId,
} from '../../../src/runtime/util/id.js'

describe('typed IDs', () => {
  it('each constructor produces a string with the expected prefix', () => {
    expect(newAgentId().startsWith('agent_')).toBe(true)
    expect(newTaskId().startsWith('task_')).toBe(true)
    expect(newCallId().startsWith('call_')).toBe(true)
    expect(newPlanId().startsWith('plan_')).toBe(true)
    expect(newRunId().startsWith('run_')).toBe(true)
    expect(newPermId().startsWith('perm_')).toBe(true)
    expect(newNotificationId().startsWith('notif_')).toBe(true)
    expect(newDetectorTripId().startsWith('trip_')).toBe(true)
  })

  it('produces unique values across calls', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 100; i++) {
      seen.add(newTaskId())
    }
    expect(seen.size).toBe(100)
  })

  it('post-prefix portion is hex with no dashes', () => {
    const id = newAgentId()
    const post = id.slice('agent_'.length)
    expect(post).toMatch(/^[0-9a-f]+$/)
    expect(post).not.toContain('-')
  })
})
