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
import { readUpgradeStatus, writeUpgradeStatus } from './upgrade-status.js'

/**
 * How recent a non-terminal upgrade-status must be to count as "still
 * in flight". Beyond this the prior runner is assumed dead (crashed
 * mid-upgrade) and a fresh trigger is allowed to recover. Generous
 * enough to cover the npm-install + daemon-boot window.
 */
const IN_FLIGHT_STALENESS_MS = 180_000

/** Result of a trigger call. */
export type TriggerResult =
  | { kind: 'started'; current: string; target: string; daemon_pid: number; helper_pid: number }
  | { kind: 'up-to-date'; current: string }
  | { kind: 'source-checkout'; path: string }
  | { kind: 'registry-error'; message: string }
  | { kind: 'ahead'; current: string; latest: string }
  | { kind: 'already-in-progress'; stage: string; version_to: string }

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

  // In-flight guard: a rapid second click (or a stuck UI) must not
  // spawn a second detached runner racing the first. Refuse when a
  // non-terminal upgrade was updated recently; allow a fresh attempt
  // once it looks stale (the prior runner crashed).
  const existing = await readUpgradeStatus(opts.home).catch(() => null)
  if (existing && existing.stage !== 'completed' && existing.stage !== 'failed') {
    const age = Date.now() - Date.parse(existing.updated_at)
    if (Number.isFinite(age) && age < IN_FLIGHT_STALENESS_MS) {
      return {
        kind: 'already-in-progress',
        stage: existing.stage,
        version_to: existing.version_to,
      }
    }
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

  // `detached: true` gives the helper its own process group, which is
  // enough to survive a plain parent exit ... and NOT enough under
  // systemd. A unit's cgroup contains every descendant regardless of
  // process group, and the default KillMode=control-group SIGKILLs
  // whatever is left in it when the unit stops. So on a systemd-managed
  // instance the helper was killed the instant the daemon it had just
  // asked to exit finished exiting: the upgrade died at
  // `stopping_daemon` 100% of the time, never a race. That is the
  // recommended production deployment (Type=simple + `daemon run`), so
  // the web upgrade button was broken for exactly the setup we tell
  // operators to use.
  //
  // `systemd-run --scope` puts the helper in its own transient scope,
  // i.e. its own cgroup, so the unit's teardown cannot reach it.
  const escape = systemdScopeCommand()
  const [cmd, ...prefixArgs] = escape ?? []
  const child = spawn(cmd ?? process.execPath, [...prefixArgs, process.execPath, runnerPath], {
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
 * Resolve the bundled `upgrade-runner.js` path.
 *
 * tsup emits the runner as a standalone entry at
 * `<distRoot>/runtime/install/upgrade-runner.js`. This trigger module,
 * however, is NOT emitted standalone ... tsup inlines it into the
 * bundles that import it (`<distRoot>/cli/main.js` and, critically,
 * `<distRoot>/runtime/supervisor/bootstrap.js`, which is the daemon
 * process that actually calls `triggerUpgrade` from the HTTP route).
 * So `import.meta.url` here points at the host bundle, NOT at
 * `runtime/install/`, and a naive `dirname(modulePath)/upgrade-runner.js`
 * resolves to a file that does not exist ... which silently bricked the
 * web "click Upgrade" path (found in the 2026-06-13 update-mechanism
 * audit). Instead, walk up from the host bundle to the dist root and
 * resolve the runner at its known stable location.
 */
function defaultRunnerPath(modulePath: string): string {
  const RUNNER_REL = join('runtime', 'install', 'upgrade-runner.js')
  // Walk up at most a few levels looking for <ancestor>/runtime/install/
  // upgrade-runner.js. The daemon bundle is `<dist>/runtime/supervisor/
  // bootstrap.js` (3 levels under dist) and the CLI bundle is
  // `<dist>/cli/main.js` (2 levels), so a small bound covers both.
  let dir = dirname(modulePath)
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, RUNNER_REL)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // Fall back to the legacy sibling guess so the existsSync check in
  // the caller still produces a clear "runner not found" error rather
  // than throwing here.
  return join(dirname(modulePath), 'upgrade-runner.js')
}

/**
 * Build the `systemd-run --scope` prefix used to launch the upgrade
 * helper outside the daemon's unit cgroup, or null when we are not
 * running under systemd (or `systemd-run` is unavailable).
 *
 * Detection is `INVOCATION_ID`, which systemd sets in the environment
 * of every service it starts and which nothing else sets. Checking for
 * the binary alone would be wrong ... plenty of systemd boxes run the
 * daemon by hand, and wrapping that case in a transient scope would
 * change process ownership for no reason.
 *
 * `--user` matches how the daemon unit is deployed (a `--user` unit, so
 * there is no system-bus access to make a system scope). `--collect`
 * garbage-collects the transient unit if the helper fails, so a botched
 * upgrade does not leave a failed scope behind for the operator to
 * clean up. `--quiet` keeps systemd-run's own chatter out of the
 * helper's (ignored) stdio.
 */
export function systemdScopeCommand(
  env: NodeJS.ProcessEnv = process.env,
  lookup: (bin: string) => boolean = binaryExists,
  platform: NodeJS.Platform = process.platform,
): string[] | null {
  if (platform !== 'linux') return null
  if (typeof env['INVOCATION_ID'] !== 'string' || env['INVOCATION_ID'].length === 0) return null
  if (!lookup('systemd-run')) return null
  return ['systemd-run', '--user', '--scope', '--collect', '--quiet']
}

function binaryExists(bin: string): boolean {
  const pathVar = process.env['PATH'] ?? ''
  return pathVar
    .split(':')
    .filter((p) => p.length > 0)
    .some((dir) => existsSync(join(dir, bin)))
}
