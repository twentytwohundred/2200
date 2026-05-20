/**
 * Trigger a self-upgrade from inside the daemon.
 *
 * Called by the HTTP route `POST /api/v1/system/update`. The shape:
 *   1. Check that we are running from a managed install (not a source
 *      checkout). Source checkouts must be upgraded via `git pull && pnpm build`.
 *   2. Confirm a newer version exists on the registry.
 *   3. Write the initial `upgrade-status.json` with stage=pending.
 *   4. Spawn the `upgrade-runner` as a detached child (it outlives
 *      this daemon's death).
 *   5. Arrange for the daemon to exit shortly (giving the HTTP
 *      response a chance to flush first).
 *
 * The detached helper handles the rest: waits for our PID to clear,
 * runs `npm install -g`, restarts the daemon, advances the status to
 * `completed` (or `failed` with an error message).
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { VERSION } from '../../index.js'
import {
  PACKAGE_NAME,
  checkLatestVersion,
  detectInstallSource,
  type VersionCheck,
} from './update.js'
import { writeUpgradeStatus } from './upgrade-status.js'

/** Result of a trigger call. */
export type TriggerResult =
  | { kind: 'started'; current: string; target: string; daemon_pid: number; helper_pid: number }
  | { kind: 'up-to-date'; current: string }
  | { kind: 'source-checkout'; path: string }
  | { kind: 'registry-error'; message: string }
  | { kind: 'ahead'; current: string; latest: string }

/**
 * Trigger an upgrade. Returns immediately after spawning the helper;
 * the daemon's own self-shutdown is scheduled by the caller (the
 * HTTP route) so the response can flush first.
 *
 * `targetVersion` defaults to the registry's `latest`. Passing an
 * explicit version (e.g., `0.2.0` or `0.2.0-rc.1`) lets the operator
 * pin a specific tag.
 */
export async function triggerUpgrade(opts: {
  home: string
  targetVersion?: string
  /** Override the install-source detection (testing). */
  modulePath?: string
  /** Override the runner-entry path (testing). */
  runnerPath?: string
  /** Override the version-check fetch (testing). */
  versionCheck?: VersionCheck
}): Promise<TriggerResult> {
  const modulePath = opts.modulePath ?? fileURLToPath(import.meta.url)
  const source = detectInstallSource(modulePath)
  if (source.kind === 'source-checkout') {
    return { kind: 'source-checkout', path: source.path }
  }

  const check = opts.versionCheck ?? (await checkLatestVersion(VERSION))
  if (check.kind === 'registry-error') {
    return { kind: 'registry-error', message: check.message }
  }
  if (check.kind === 'ahead') {
    return { kind: 'ahead', current: check.current, latest: check.latest }
  }

  const target = opts.targetVersion ?? check.latest
  if (target === check.current) {
    return { kind: 'up-to-date', current: check.current }
  }

  // Seed the status file BEFORE spawning the helper so the web UI
  // can poll it immediately ... before the helper has even started.
  const now = new Date().toISOString()
  await writeUpgradeStatus(opts.home, {
    schema_version: 1,
    stage: 'pending',
    version_from: check.current,
    version_to: target,
    triggered_at: now,
    updated_at: now,
    finished_at: null,
    error: null,
  })

  const runnerPath = opts.runnerPath ?? defaultRunnerPath(modulePath)
  if (!existsSync(runnerPath)) {
    return {
      kind: 'registry-error',
      message: `upgrade-runner not found at ${runnerPath}. Reinstall the package.`,
    }
  }

  const child = spawn(process.execPath, [runnerPath], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      TWENTYTWOHUNDRED_HOME: opts.home,
      TWENTYTWOHUNDRED_DAEMON_PID: String(process.pid),
      TWENTYTWOHUNDRED_TARGET_VERSION: target,
      TWENTYTWOHUNDRED_PACKAGE_NAME: PACKAGE_NAME,
    },
  })
  child.unref()
  child.on('error', () => {
    // The runner failed to spawn; the status file still says
    // `pending`, which will surface in the UI. Nothing else we can do
    // from inside the (about-to-shut-down) daemon.
  })

  return {
    kind: 'started',
    current: check.current,
    target,
    daemon_pid: process.pid,
    helper_pid: child.pid ?? 0,
  }
}

/**
 * Resolve the bundled upgrade-runner.js path.
 *
 * tsup writes `src/runtime/install/upgrade-runner.ts` to
 * `dist/runtime/install/upgrade-runner.js`. From this file's perspective
 * (also under `dist/runtime/install/`), the runner is a sibling.
 */
function defaultRunnerPath(modulePath: string): string {
  return join(dirname(modulePath), 'upgrade-runner.js')
}
