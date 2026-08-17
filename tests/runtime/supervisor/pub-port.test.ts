/**
 * Pub-server port disposition. This is the fix for the live valkyrie failure
 * (2026.623): a pub-server from a prior supervisor life held the Studio's port,
 * so every relaunch died on EADDRINUSE and the pub record flipped to `errored`
 * ... the Studio then returned HTTP 409 (`pub_not_running`) on send even though
 * a healthy pub-server was sitting right there. `planPubPort` makes `startPub`
 * adopt a healthy listener instead of launching a colliding one.
 */
import { describe, expect, it } from 'vitest'
import { planPubPort, type PubPortProbe } from '../../../src/runtime/supervisor/pub-port.js'

function probe(healthy: boolean, pids: number[]): PubPortProbe {
  return {
    isHealthy: () => Promise.resolve(healthy),
    listeners: () => Promise.resolve(pids),
  }
}

describe('planPubPort', () => {
  it('adopts a healthy pub-server already on the port (the valkyrie fix ... no relaunch, no collision)', async () => {
    const plan = await planPubPort(33029, probe(true, [418700]))
    expect(plan).toEqual({ action: 'adopt', pid: 418700 })
  })

  it('adopts with a null pid when the server is healthy but lsof can not see the pid', async () => {
    // e.g. lsof missing on the host ... we still adopt rather than collide.
    const plan = await planPubPort(33029, probe(true, []))
    expect(plan).toEqual({ action: 'adopt', pid: null })
  })

  it('reclaims a wedged (non-responsive) listener, then launches', async () => {
    const plan = await planPubPort(33029, probe(false, [999]))
    expect(plan).toEqual({ action: 'reclaim-then-launch', killPids: [999] })
  })

  it('just launches when the port is free', async () => {
    const plan = await planPubPort(33029, probe(false, []))
    expect(plan).toEqual({ action: 'launch' })
  })

  it('prefers adopt over reclaim when both healthy and listeners are present', async () => {
    // A healthy server is never killed ... adopt wins, so the agents'
    // WebSockets are not flapped on a routine restart.
    const plan = await planPubPort(33029, probe(true, [111, 222]))
    expect(plan).toEqual({ action: 'adopt', pid: 111 })
  })
})
