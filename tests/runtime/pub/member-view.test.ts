/**
 * Tests for buildPubMembers ... the member-view collapse that hides the
 * pub-server's undeletable shadow registrations.
 *
 * The canonical case is the live valkyrie state that motivated the fix:
 *   - operator "Doug" (a non-Agent participant, present)
 *   - jodin: a stale shadow ("jodin", id-old) AND the current row ("jodin",
 *     id-new) ... must collapse to ONE jodin at id-new
 *   - skippy: an Agent registered under a relabeled display_name
 *     ("skippy (agent)") ... must show ONCE, labelled by canonical agent_name
 */
import { describe, expect, it } from 'vitest'
import { buildPubMembers } from '../../../src/runtime/pub/member-view.js'

describe('buildPubMembers', () => {
  it('collapses a stale shadow to the current id and keeps one row per Agent', () => {
    const members = buildPubMembers({
      roster: [
        { agent_id: 'jodin-old', agent_name: 'jodin', display_name: 'jodin' }, // shadow
        { agent_id: 'jodin-new', agent_name: 'jodin', display_name: 'jodin' }, // current
        { agent_id: 'skippy-1', agent_name: 'skippy', display_name: 'skippy (agent)' },
      ],
      present: [
        { agent_id: 'jodin-new', display_name: 'jodin', status: 'active' },
        { agent_id: 'jodin-old', display_name: 'jodin', status: 'active' }, // shadow still "joins"
        { agent_id: 'op-1', display_name: 'Doug', status: 'active' }, // operator
      ],
      liveAgents: [
        { name: 'jodin', running: true, currentId: 'jodin-new' },
        { name: 'skippy', running: false, currentId: 'skippy-1' },
      ],
    })

    const byName = (n: string | null): typeof members => members.filter((m) => m.agent_name === n)
    // Exactly one jodin, at the current id.
    expect(byName('jodin')).toHaveLength(1)
    expect(byName('jodin')[0]?.agent_id).toBe('jodin-new')
    // skippy once, canonical name carried (UI renders agent_name, not "(agent)").
    expect(byName('skippy')).toHaveLength(1)
    expect(byName('skippy')[0]?.display_name).toBe('skippy (agent)')
    // The operator (no agent_name) survives.
    expect(byName(null)).toHaveLength(1)
    expect(byName(null)[0]?.display_name).toBe('Doug')
    // The stale shadow id never appears.
    expect(members.some((m) => m.agent_id === 'jodin-old')).toBe(false)
    expect(members).toHaveLength(3)
  })

  it('marks a registered-but-not-present Agent idle/offline by running state', () => {
    const members = buildPubMembers({
      roster: [
        { agent_id: 'a1', agent_name: 'alpha', display_name: 'alpha' },
        { agent_id: 'b1', agent_name: 'bravo', display_name: 'bravo' },
      ],
      present: [],
      liveAgents: [
        { name: 'alpha', running: true, currentId: 'a1' },
        { name: 'bravo', running: false, currentId: 'b1' },
      ],
    })
    expect(members.find((m) => m.agent_name === 'alpha')?.status).toBe('idle')
    expect(members.find((m) => m.agent_name === 'bravo')?.status).toBe('offline')
  })

  it('fails open: a live Agent with an unresolved current id keeps its roster row', () => {
    const members = buildPubMembers({
      roster: [{ agent_id: 'x1', agent_name: 'x', display_name: 'x' }],
      present: [],
      // currentId null = unreadable cred (transient FS error) ... must not hide x.
      liveAgents: [{ name: 'x', running: true, currentId: null }],
    })
    expect(members).toHaveLength(1)
    expect(members[0]?.agent_id).toBe('x1')
    expect(members[0]?.agent_name).toBe('x')
  })

  it('drops roster rows for a deleted/archived Agent', () => {
    const members = buildPubMembers({
      roster: [{ agent_id: 'gone-1', agent_name: 'ghost', display_name: 'ghost' }],
      present: [],
      liveAgents: [], // ghost is not a live Agent
    })
    expect(members).toHaveLength(0)
  })

  it('keeps a genuine non-Agent guest that is present', () => {
    const members = buildPubMembers({
      roster: [{ agent_id: 'a1', agent_name: 'alpha', display_name: 'alpha' }],
      present: [{ agent_id: 'guest-1', display_name: 'Visitor', status: 'active' }],
      liveAgents: [{ name: 'alpha', running: true, currentId: 'a1' }],
    })
    const guest = members.find((m) => m.agent_id === 'guest-1')
    expect(guest).toBeDefined()
    expect(guest?.agent_name).toBeNull()
    expect(guest?.display_name).toBe('Visitor')
  })
})
