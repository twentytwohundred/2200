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
