/**
 * Decide whether the System Update tile shows the upgrade-progress card
 * (the stepper + completed/failed result) versus the version-status view
 * (the "Upgrade to X" action, "up to date" note, etc.).
 *
 * The upgrade status is persisted to a file and survives the daemon
 * restart, so a FINISHED upgrade (completed/failed) lingers. Without this
 * rule, that stale card takes render priority and HIDES the "Upgrade"
 * button when a newer release lands ... so the operator sees "UPDATE
 * AVAILABLE" up top but no way to act on it. The rule:
 *
 *   - an actively-running upgrade always shows its live progress
 *   - otherwise, a newly-available update SUPERSEDES a finished card, so
 *     the new "Upgrade" action surfaces
 *   - a finished card otherwise stays (e.g. "completed" right after an
 *     upgrade while up-to-date, or a "failed" result the operator should
 *     still see)
 */
export function shouldShowUpgradeProgress(args: {
  hasStatus: boolean
  versionStatus: string
  active: boolean
}): boolean {
  if (!args.hasStatus) return false
  return args.active || args.versionStatus !== 'update-available'
}

/**
 * Decide the upgrade-status poll interval (ms), or `false` to stop polling.
 *
 * The status queryFn returns null on a transient daemon-down blip ... the
 * daemon restarts as part of the upgrade ... which is indistinguishable from
 * "idle, no upgrade" by the data alone. Without a latch, that null makes the
 * poller stop FOREVER mid-upgrade: the stepper vanishes and the stale
 * "Upgrade to X" button reappears while the upgrade is still running. So:
 *
 *   - a live (non-terminal) stage → keep polling fast (2s),
 *   - a terminal stage (completed/failed) → stop,
 *   - no status (`hasStatus` false): if we're latched mid-upgrade, treat it as
 *     a blip and KEEP polling so we recover when the daemon returns; otherwise
 *     we're genuinely idle → stop.
 */
export function nextUpgradePollInterval(args: {
  hasStatus: boolean
  terminal: boolean
  latchedUpgrading: boolean
}): number | false {
  if (args.hasStatus) return args.terminal ? false : 2_000
  return args.latchedUpgrading ? 2_000 : false
}
