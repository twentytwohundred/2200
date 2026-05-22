/**
 * Tests for the connector Inbox audit emitter.
 *
 * Covers: passive-tier emission on success, normal-tier emission on
 * auth rejection, the per-source-IP 10-minute throttle for failed-auth
 * events (only one notification per window; the suppressed count is
 * carried into the next emission body), and listener lifecycle events.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ConnectorAuditEmitter,
  CONNECTOR_EMITTER,
} from '../../../../src/runtime/mcp/connector/audit.js'
import { homePaths } from '../../../../src/runtime/storage/layout.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-connector-audit-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

async function readEmittedNotifications(): Promise<{ name: string; raw: string }[]> {
  const dir = homePaths(home).stateNotifications
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  return Promise.all(
    entries.map(async (name) => ({
      name,
      raw: await readFile(join(dir, name), 'utf-8'),
    })),
  )
}

describe('ConnectorAuditEmitter.emitCallReceived', () => {
  it('emits a passive-tier notification with method and source_ip', async () => {
    const audit = new ConnectorAuditEmitter({ home })
    await audit.emitCallReceived({
      sourceIp: '203.0.113.7',
      method: 'tools/list',
    })
    const notes = await readEmittedNotifications()
    expect(notes).toHaveLength(1)
    expect(notes[0]?.raw).toContain('tier: passive')
    expect(notes[0]?.raw).toContain(`agent: ${CONNECTOR_EMITTER}`)
    expect(notes[0]?.raw).toContain('kind: connector.call_received')
    expect(notes[0]?.raw).toContain('source_ip: 203.0.113.7')
    expect(notes[0]?.raw).toContain('method: tools/list')
  })

  it('includes tool_name and latency when provided', async () => {
    const audit = new ConnectorAuditEmitter({ home })
    await audit.emitCallReceived({
      sourceIp: '203.0.113.7',
      method: 'tools/call',
      toolName: 'liveness',
      latencyMs: 42,
    })
    const [note] = await readEmittedNotifications()
    expect(note?.raw).toContain('tool_name: liveness')
    expect(note?.raw).toContain('latency_ms: 42')
  })
})

describe('ConnectorAuditEmitter.emitAuthRejected throttle', () => {
  it('emits the first rejection from a source IP', async () => {
    const audit = new ConnectorAuditEmitter({ home, now: () => 1000 })
    const emitted = await audit.emitAuthRejected({
      sourceIp: '198.51.100.4',
      reason: 'value_mismatch',
    })
    expect(emitted).toBe(true)
    const notes = await readEmittedNotifications()
    expect(notes).toHaveLength(1)
    expect(notes[0]?.raw).toContain('tier: normal')
    expect(notes[0]?.raw).toContain('reason: value_mismatch')
    expect(notes[0]?.raw).toContain('source_ip: 198.51.100.4')
  })

  it('suppresses repeats within the 10-minute window from the same IP', async () => {
    let t = 1000
    const audit = new ConnectorAuditEmitter({ home, now: () => t })
    expect(await audit.emitAuthRejected({ sourceIp: '1.2.3.4', reason: 'missing_header' })).toBe(
      true,
    )
    // Five more attempts within the window: each suppressed.
    for (let i = 0; i < 5; i++) {
      t += 30_000 // 30s steps; 5 × 30s = 2.5min, well under the 10min window
      expect(await audit.emitAuthRejected({ sourceIp: '1.2.3.4', reason: 'missing_header' })).toBe(
        false,
      )
    }
    const notes = await readEmittedNotifications()
    expect(notes).toHaveLength(1)
  })

  it('lets a new emission through once the window elapses, and reports the suppressed count', async () => {
    let t = 1000
    const audit = new ConnectorAuditEmitter({ home, now: () => t })
    await audit.emitAuthRejected({ sourceIp: '1.2.3.4', reason: 'missing_header' })
    // Two suppressed in-window.
    t += 60_000
    await audit.emitAuthRejected({ sourceIp: '1.2.3.4', reason: 'missing_header' })
    t += 60_000
    await audit.emitAuthRejected({ sourceIp: '1.2.3.4', reason: 'missing_header' })
    // Now jump past the 10-minute window.
    t += 10 * 60 * 1000 + 1
    const emitted = await audit.emitAuthRejected({ sourceIp: '1.2.3.4', reason: 'value_mismatch' })
    expect(emitted).toBe(true)
    const notes = await readEmittedNotifications()
    expect(notes).toHaveLength(2)
    // The second notification should reference the suppressed count.
    const second = notes.find((n) => n.raw.includes('value_mismatch'))
    expect(second?.raw).toContain('2 similar attempts suppressed')
    expect(second?.raw).toContain('suppressed_since_last: 2')
  })

  it('throttles independently per source IP', async () => {
    const audit = new ConnectorAuditEmitter({ home, now: () => 1000 })
    expect(await audit.emitAuthRejected({ sourceIp: '1.1.1.1', reason: 'missing_header' })).toBe(
      true,
    )
    expect(await audit.emitAuthRejected({ sourceIp: '2.2.2.2', reason: 'missing_header' })).toBe(
      true,
    )
    expect(await audit.emitAuthRejected({ sourceIp: '3.3.3.3', reason: 'missing_header' })).toBe(
      true,
    )
    const notes = await readEmittedNotifications()
    expect(notes).toHaveLength(3)
  })
})

describe('ConnectorAuditEmitter.emitListenerStateChanged', () => {
  it('emits a passive event with the state and port', async () => {
    const audit = new ConnectorAuditEmitter({ home })
    await audit.emitListenerStateChanged({ state: 'started', port: 2201 })
    const [note] = await readEmittedNotifications()
    expect(note?.raw).toContain('tier: passive')
    expect(note?.raw).toContain('kind: connector.listener_state_changed')
    expect(note?.raw).toContain('listener_state: started')
    expect(note?.raw).toContain('port: 2201')
  })

  it('includes an explanatory reason when provided', async () => {
    const audit = new ConnectorAuditEmitter({ home })
    await audit.emitListenerStateChanged({
      state: 'stopped',
      reason: 'user_disabled',
    })
    const [note] = await readEmittedNotifications()
    expect(note?.raw).toContain('reason: user_disabled')
  })
})
