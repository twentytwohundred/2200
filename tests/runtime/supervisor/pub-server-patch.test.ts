/**
 * The pub-server patch-overlay decision. This is the logic that shipped broken
 * TWICE (2026.617.327 then .342) because the shipped-patch path was probed at
 * the wrong bundle depth, so the overlay logged "no shipped patch found" and
 * Agents kept getting dropped from the Studio ~60s after joining. These tests
 * pin the path-probing + marker behavior so that can't silently regress again.
 */
import { describe, expect, it } from 'vitest'
import {
  planPubServerPatch,
  PUB_SERVER_PATCH_MARKER,
  type PatchFs,
} from '../../../src/runtime/supervisor/pub-lifecycle.js'

const PATCHED = `// header\n// ${PUB_SERVER_PATCH_MARKER}\nmodule.exports = {}\n`
const UNPATCHED = `// header\nmodule.exports = {}\n`

/** Build a fake fs from a path -> contents map (missing key = does not exist). */
function fakeFs(files: Record<string, string | null>): PatchFs {
  return {
    exists: (p) => p in files,
    read: (p) => {
      const v = files[p]
      return v === undefined ? null : v
    },
  }
}

const INSTALLED_PATH = '/a/node_modules/@openpub-ai/pub-server/dist/server.js'
// Mirrors shippedPatchCandidates: increasing `..` depth.
const SHIPPED_SHALLOW = '/x/vendor/openpub-pub-server/server.js'
const SHIPPED_MID = '/y/vendor/openpub-pub-server/server.js'
const SHIPPED_DEEP = '/z/vendor/openpub-pub-server/server.js'
const INSTALLED = [INSTALLED_PATH]
const SHIPPED = [SHIPPED_SHALLOW, SHIPPED_MID, SHIPPED_DEEP]

describe('planPubServerPatch', () => {
  it('applies the shipped patch when the installed pub-server is unpatched', () => {
    const fs = fakeFs({ [INSTALLED_PATH]: UNPATCHED, [SHIPPED_SHALLOW]: PATCHED })
    const plan = planPubServerPatch(INSTALLED, SHIPPED, fs)
    expect(plan.action).toBe('apply')
    if (plan.action === 'apply') {
      expect(plan.installed).toBe(INSTALLED_PATH)
      expect(plan.content).toBe(PATCHED)
    }
  })

  it('finds the shipped patch at a DEEPER candidate depth (the .342 regression)', () => {
    // Only the third shipped candidate exists ... the exact failure mode where
    // the bundled entry sat deeper than the first probed path.
    const fs = fakeFs({ [INSTALLED_PATH]: UNPATCHED, [SHIPPED_DEEP]: PATCHED })
    const plan = planPubServerPatch(INSTALLED, SHIPPED, fs)
    expect(plan.action).toBe('apply')
    if (plan.action === 'apply') expect(plan.shipped).toBe(SHIPPED_DEEP)
  })

  it('is a no-op when the installed pub-server is already patched (idempotent)', () => {
    const fs = fakeFs({ [INSTALLED_PATH]: PATCHED, [SHIPPED_SHALLOW]: PATCHED })
    expect(planPubServerPatch(INSTALLED, SHIPPED, fs).action).toBe('already-patched')
  })

  it('warns (no-shipped) when no shipped patch exists at any depth', () => {
    const fs = fakeFs({ [INSTALLED_PATH]: UNPATCHED })
    expect(planPubServerPatch(INSTALLED, SHIPPED, fs).action).toBe('no-shipped')
  })

  it('never overwrites with a shipped copy that lacks the marker', () => {
    const fs = fakeFs({ [INSTALLED_PATH]: UNPATCHED, [SHIPPED_SHALLOW]: UNPATCHED })
    expect(planPubServerPatch(INSTALLED, SHIPPED, fs).action).toBe('shipped-unpatched')
  })

  it('does nothing when there is no installed pub-server', () => {
    expect(planPubServerPatch(INSTALLED, SHIPPED, fakeFs({})).action).toBe('no-installed')
  })

  it('does nothing when the installed file is unreadable', () => {
    const fs = fakeFs({ [INSTALLED_PATH]: null, [SHIPPED_SHALLOW]: PATCHED })
    expect(planPubServerPatch(INSTALLED, SHIPPED, fs).action).toBe('installed-unreadable')
  })

  it('picks the first existing installed candidate', () => {
    const candidates = ['/missing/server.js', INSTALLED_PATH]
    const fs = fakeFs({ [INSTALLED_PATH]: UNPATCHED, [SHIPPED_SHALLOW]: PATCHED })
    const plan = planPubServerPatch(candidates, SHIPPED, fs)
    expect(plan.action).toBe('apply')
    if (plan.action === 'apply') expect(plan.installed).toBe(INSTALLED_PATH)
  })
})
