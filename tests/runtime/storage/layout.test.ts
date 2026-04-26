/**
 * Tests for the 2200_HOME directory layout helpers.
 *
 * Layout itself is locked in [[2026-04-26-commons-and-storage-root]];
 * these tests pin the path-derivation functions and the slug-validation
 * rule so refactors (renaming dirs, adding subdirs) are deliberate.
 */
import { describe, expect, it } from 'vitest'
import {
  assertPubName,
  agentPaths,
  homePaths,
  pubPaths,
} from '../../../src/runtime/storage/layout.js'

describe('homePaths', () => {
  it('places state.openpub under <home>/state/openpub', () => {
    const p = homePaths('/x/2200_HOME')
    expect(p.stateOpenpub).toBe('/x/2200_HOME/state/openpub')
  })

  it('preserves existing layout fields (regression guard for Epic 2 paths)', () => {
    const p = homePaths('/x/h')
    expect(p.commonsReference).toBe('/x/h/commons/reference')
    expect(p.commonsScratch).toBe('/x/h/commons/scratch')
    expect(p.agents).toBe('/x/h/agents')
    expect(p.stateSupervisorJson).toBe('/x/h/state/supervisor.json')
    expect(p.stateSupervisorSock).toBe('/x/h/state/supervisor.sock')
    expect(p.stateNotifications).toBe('/x/h/state/notifications')
    expect(p.config).toBe('/x/h/config')
  })
})

describe('pubPaths', () => {
  it('roots a pub at <home>/state/openpub/<pub>', () => {
    const p = pubPaths('/x/h', 'ops')
    expect(p.root).toBe('/x/h/state/openpub/ops')
    expect(p.pubMd).toBe('/x/h/state/openpub/ops/PUB.md')
    expect(p.log).toBe('/x/h/state/openpub/ops/pub.log')
    expect(p.pid).toBe('/x/h/state/openpub/ops/pub.pid')
    expect(p.data).toBe('/x/h/state/openpub/ops/data')
  })

  it('handles slug names with dashes', () => {
    const p = pubPaths('/h', 'carl-monday-callsheet')
    expect(p.root).toBe('/h/state/openpub/carl-monday-callsheet')
  })
})

describe('agentPaths (regression)', () => {
  it('still resolves under <home>/agents/<name>', () => {
    const a = agentPaths('/h', 'hobby')
    expect(a.root).toBe('/h/agents/hobby')
    expect(a.identity).toBe('/h/agents/hobby/identity.md')
  })
})

describe('assertPubName', () => {
  it.each(['ops', 'carl-monday', 'pub1', 'a', '0test', 'a-b-c-d'])('accepts %s', (name) => {
    expect(() => {
      assertPubName(name)
    }).not.toThrow()
  })

  it.each([
    ['', 'empty'],
    ['Ops', 'uppercase'],
    ['my pub', 'whitespace'],
    ['pub_name', 'underscore'],
    ['-leading-dash', 'leading dash'],
    ['has.dot', 'dot'],
    ['has/slash', 'slash'],
    ['has\\backslash', 'backslash'],
  ])('rejects %s (%s)', (name, _reason) => {
    expect(() => {
      assertPubName(name)
    }).toThrow(/invalid pub name/)
  })
})
