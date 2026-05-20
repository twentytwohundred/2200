/**
 * Tests for `runtime/install/upgrade-status.ts`.
 *
 * The status file is the single shared surface between the daemon
 * (which seeds it), the detached helper (which advances it), and the
 * new daemon on boot (which reads it). Subtle bugs here would either
 * lose the upgrade record entirely or report a stale stage in the
 * web UI long after the upgrade is done.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  advanceUpgradeStage,
  readUpgradeStatus,
  upgradeStatusPath,
  writeUpgradeStatus,
  type UpgradeStatus,
} from '../../../src/runtime/install/upgrade-status.js'

describe('upgrade-status', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), '2200-us-'))
    await mkdir(join(home, 'state'), { recursive: true })
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  function makeStatus(stage: UpgradeStatus['stage']): UpgradeStatus {
    const now = new Date().toISOString()
    return {
      schema_version: 1,
      stage,
      version_from: '0.1.0',
      version_to: '0.2.0',
      triggered_at: now,
      updated_at: now,
      finished_at: stage === 'completed' || stage === 'failed' ? now : null,
      error: null,
    }
  }

  it('returns null when no status file exists yet', async () => {
    // First-time read on a fresh home must not throw; the web UI
    // polls this endpoint before any upgrade has been triggered.
    const status = await readUpgradeStatus(home)
    expect(status).toBeNull()
  })

  it('writes and reads a status round-trip', async () => {
    const input = makeStatus('pending')
    await writeUpgradeStatus(home, input)
    const out = await readUpgradeStatus(home)
    expect(out).toEqual(input)
  })

  it('throws on a malformed status file', async () => {
    // A torn/corrupted status is a real problem; surfacing it as a
    // throw is better than silently returning null (which would
    // look identical to "no upgrade triggered" in the UI).
    const { writeFile } = await import('node:fs/promises')
    await writeFile(upgradeStatusPath(home), '{not json}', 'utf8')
    await expect(readUpgradeStatus(home)).rejects.toBeTruthy()
  })

  it('advanceUpgradeStage updates only stage + updated_at on non-terminal transitions', async () => {
    const initial = makeStatus('pending')
    await writeUpgradeStatus(home, initial)

    const next = await advanceUpgradeStage(home, 'installing')
    expect(next.stage).toBe('installing')
    expect(next.version_from).toBe(initial.version_from)
    expect(next.version_to).toBe(initial.version_to)
    expect(next.triggered_at).toBe(initial.triggered_at)
    expect(next.finished_at).toBeNull()
    expect(next.updated_at >= initial.updated_at).toBe(true)
  })

  it('advanceUpgradeStage sets finished_at on terminal stages', async () => {
    // The HTTP polling loop in the web app reads `finished_at` to
    // decide when to stop polling; missing this would leave the UI
    // spinning forever even though the upgrade is done.
    const initial = makeStatus('installing')
    await writeUpgradeStatus(home, initial)

    const completed = await advanceUpgradeStage(home, 'completed')
    expect(completed.stage).toBe('completed')
    expect(completed.finished_at).not.toBeNull()
  })

  it('advanceUpgradeStage records the error on failed', async () => {
    // The error field is the only signal the operator gets when an
    // upgrade goes wrong. It must be preserved verbatim.
    const initial = makeStatus('installing')
    await writeUpgradeStatus(home, initial)
    const failed = await advanceUpgradeStage(home, 'failed', {
      error: 'npm install exited 1',
    })
    expect(failed.stage).toBe('failed')
    expect(failed.error).toBe('npm install exited 1')
    expect(failed.finished_at).not.toBeNull()
  })

  it('advanceUpgradeStage throws when called before writeUpgradeStatus', async () => {
    // Defensive guard: the helper should never call advance on a
    // home that the daemon did not pre-seed. If we silently created
    // a new status here, the helper's progress would not be tied
    // back to the user's trigger.
    await expect(advanceUpgradeStage(home, 'installing')).rejects.toThrow(/no current status/)
  })
})
