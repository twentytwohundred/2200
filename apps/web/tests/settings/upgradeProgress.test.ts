/**
 * Tests for the System Update tile's progress-vs-action decision.
 *
 * Why this matters: the upgrade status is persisted and survives the
 * daemon restart, so a finished (completed/failed) upgrade card lingers.
 * The bug it caused: that stale card hid the "Upgrade" button when a newer
 * release landed, so the operator saw "UPDATE AVAILABLE" with no way to
 * act. These pin that a newly-available update supersedes a finished card,
 * while an actively-running upgrade still shows its live progress.
 */
import { describe, expect, it } from 'vitest'
import {
  shouldShowUpgradeProgress,
  nextUpgradePollInterval,
} from '../../src/screens/settings/upgradeProgress'

describe('shouldShowUpgradeProgress', () => {
  it('hides a finished card when a newer update is available (the bug)', () => {
    // completed 1725->1751 persisted, but 1813 is now available.
    expect(
      shouldShowUpgradeProgress({
        hasStatus: true,
        versionStatus: 'update-available',
        active: false,
      }),
    ).toBe(false)
  })

  it('always shows live progress while an upgrade is actively running', () => {
    expect(
      shouldShowUpgradeProgress({
        hasStatus: true,
        versionStatus: 'update-available',
        active: true,
      }),
    ).toBe(true)
  })

  it('shows the finished card when up to date (post-upgrade confirmation)', () => {
    expect(
      shouldShowUpgradeProgress({ hasStatus: true, versionStatus: 'up-to-date', active: false }),
    ).toBe(true)
  })

  it('shows a finished card when ahead of the registry', () => {
    expect(
      shouldShowUpgradeProgress({ hasStatus: true, versionStatus: 'ahead', active: false }),
    ).toBe(true)
  })

  it('shows nothing when there is no upgrade status at all', () => {
    expect(
      shouldShowUpgradeProgress({ hasStatus: false, versionStatus: 'up-to-date', active: false }),
    ).toBe(false)
  })
})

describe('nextUpgradePollInterval', () => {
  it('polls fast while a live stage is running', () => {
    expect(
      nextUpgradePollInterval({ hasStatus: true, terminal: false, latchedUpgrading: true }),
    ).toBe(2_000)
  })

  it('stops once a terminal stage lands', () => {
    expect(
      nextUpgradePollInterval({ hasStatus: true, terminal: true, latchedUpgrading: true }),
    ).toBe(false)
  })

  it('KEEPS polling through a daemon-down blip when latched mid-upgrade (the bug)', () => {
    // status went null because the daemon restarted mid-upgrade. Before the
    // fix this stopped the poller forever and the stale button reappeared.
    expect(
      nextUpgradePollInterval({ hasStatus: false, terminal: false, latchedUpgrading: true }),
    ).toBe(2_000)
  })

  it('stops when there is no status and we are not mid-upgrade (genuinely idle)', () => {
    expect(
      nextUpgradePollInterval({ hasStatus: false, terminal: false, latchedUpgrading: false }),
    ).toBe(false)
  })
})
