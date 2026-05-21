#!/usr/bin/env node
/**
 * Detached upgrade helper.
 *
 * Spawned by the daemon when the operator triggers a self-upgrade
 * from the web UI. Runs OUTSIDE the daemon's process tree so it
 * survives the daemon's own shutdown.
 *
 * Lifecycle (mirrors the stages in `upgrade-status.ts`):
 *   1. Wait for the daemon PID to disappear  ... stage: stopping_daemon
 *   2. `npm install -g @twentytwohundred/2200@<target>`  ... stage: installing
 *   3. Start the new daemon  ... stage: restarting
 *   4. Done  ... stage: completed
 *
 * On any error in steps 2 or 3, writes stage=failed with an
 * `error` field and attempts to restart the daemon on the prior
 * version so the operator's fleet is not left down.
 *
 * Configuration via env (the daemon sets these at spawn time):
 *   TWENTYTWOHUNDRED_HOME             ... operator's 2200_HOME
 *   TWENTYTWOHUNDRED_DAEMON_PID       ... PID we wait to die
 *   TWENTYTWOHUNDRED_TARGET_VERSION   ... npm dist-tag or exact version
 *
 * This module is intentionally minimal: it does NOT depend on the
 * Supervisor, the HTTP server, the pub, or any other runtime
 * substrate. The helper has to keep running while the daemon is
 * down; pulling in a piece of the daemon would risk a partial-load
 * crash mid-upgrade.
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homePaths } from '../storage/layout.js'
import { advanceUpgradeStage, readUpgradeStatus, writeUpgradeStatus } from './upgrade-status.js'
import { isPidAlive } from '../supervisor/pidfile.js'

const POLL_INTERVAL_MS = 250
const DAEMON_SHUTDOWN_TIMEOUT_MS = 60_000
const DAEMON_BOOT_TIMEOUT_MS = 30_000

/** Resolved configuration for one upgrade attempt. */
interface UpgradeConfig {
  home: string
  daemonPid: number
  targetVersion: string
  packageName: string
}

async function main(): Promise<void> {
  const cfg = resolveConfig()

  // Stage 1: wait for the daemon to exit.
  await advanceUpgradeStage(cfg.home, 'stopping_daemon')
  const daemonStopped = await waitForPidExit(cfg.daemonPid, DAEMON_SHUTDOWN_TIMEOUT_MS)
  if (!daemonStopped) {
    await fail(
      cfg,
      `daemon (pid ${String(cfg.daemonPid)}) did not exit within ${String(DAEMON_SHUTDOWN_TIMEOUT_MS)}ms`,
    )
    return
  }

  // Stage 2: npm install.
  await advanceUpgradeStage(cfg.home, 'installing')
  const installResult = await runNpmInstall(cfg.packageName, cfg.targetVersion)
  if (installResult.code !== 0) {
    await fail(
      cfg,
      `npm install exited ${String(installResult.code)}:\n${installResult.stderr.slice(0, 1000)}`,
    )
    // Try to bring the prior-version daemon back up so the fleet is
    // not down. Best-effort; we already know things are bad.
    await tryRestartDaemon(cfg).catch(() => {
      // best-effort fallback restart; original failure is what we report
    })
    return
  }

  // Stage 3: restart the daemon.
  await advanceUpgradeStage(cfg.home, 'restarting')
  const restarted = await tryRestartDaemon(cfg)
  if (!restarted) {
    await fail(cfg, 'package installed but the new daemon did not start; check supervisor.log')
    return
  }

  // Stage 4: done.
  await advanceUpgradeStage(cfg.home, 'completed')
}

function resolveConfig(): UpgradeConfig {
  const home = requireEnv('TWENTYTWOHUNDRED_HOME')
  const daemonPidStr = requireEnv('TWENTYTWOHUNDRED_DAEMON_PID')
  const targetVersion = requireEnv('TWENTYTWOHUNDRED_TARGET_VERSION')
  const packageName = process.env['TWENTYTWOHUNDRED_PACKAGE_NAME'] ?? '@twentytwohundred/2200'
  const daemonPid = Number.parseInt(daemonPidStr, 10)
  if (!Number.isFinite(daemonPid) || daemonPid <= 0) {
    throw new Error(`TWENTYTWOHUNDRED_DAEMON_PID is not a positive integer: ${daemonPidStr}`)
  }
  return { home, daemonPid, targetVersion, packageName }
}

function requireEnv(name: string): string {
  const v = process.env[name]
  if (v === undefined || v.length === 0) {
    throw new Error(`upgrade-runner: required env var ${name} is not set`)
  }
  return v
}

/**
 * Poll `kill(pid, 0)` (a no-op signal that throws ESRCH when the
 * process does not exist). Returns true when the process is gone,
 * false on timeout.
 */
async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true
    await sleep(POLL_INTERVAL_MS)
  }
  return false
}

// isPidAlive imported from the canonical source in pidfile.ts (single
// implementation + full hazard documentation for the PID-reuse / EPERM
// stranger-PID window). The local copy here was the clearest of the three
// duplicates; all now delegate to it.

/**
 * Run `npm install -g <pkg>@<version>`, capturing stderr for the
 * failure path. stdout is discarded; npm's "added N packages" line
 * is not load-bearing for our flow.
 */
async function runNpmInstall(
  packageName: string,
  version: string,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('npm', ['install', '-g', `${packageName}@${version}`], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      stderr += `\nspawn error: ${err.message}`
      resolve({ code: 127, stderr })
    })
    child.on('exit', (code) => {
      resolve({ code: code ?? 1, stderr })
    })
  })
}

/**
 * Resolve and spawn the freshly-installed `2200 daemon start`.
 *
 * After `npm install -g`, the binary lives at `<npm prefix>/bin/2200`.
 * Querying `npm config get prefix` is the canonical way to find it
 * without baking assumptions about the prefix path; the daemon's
 * own PATH may differ from the user's because it was started by
 * a separate process.
 *
 * Returns true when the daemon's PID file appears (the new daemon
 * has booted and bound its UDS), false on timeout.
 */
async function tryRestartDaemon(cfg: UpgradeConfig): Promise<boolean> {
  const prefix = await getNpmPrefix()
  if (prefix === null) return false
  const binaryPath = join(prefix, 'bin', '2200')

  const child = spawn(binaryPath, ['daemon', 'start'], {
    env: { ...process.env, TWENTYTWOHUNDRED_HOME: cfg.home },
    stdio: 'ignore',
    detached: true,
  })
  child.unref()
  child.on('error', () => {
    // Swallow: the wait-for-pidfile loop below is the real signal.
  })

  // Wait for the supervisor pidfile to appear AND the PID inside it
  // to be alive. `2200 daemon start` is itself a short-lived
  // launcher; we cannot trust its child.pid as the daemon PID.
  const pidPath = join(homePaths(cfg.home).state, 'supervisor.pid')
  const deadline = Date.now() + DAEMON_BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const livePid = await readLivePidFile(pidPath)
    if (livePid !== null) return true
    await sleep(POLL_INTERVAL_MS)
  }
  return false
}

async function readLivePidFile(path: string): Promise<number | null> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return null
  }
  const n = Number.parseInt(raw.trim(), 10)
  if (!Number.isFinite(n) || n <= 0) return null
  if (!isPidAlive(n)) return null
  return n
}

async function getNpmPrefix(): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('npm', ['config', 'get', 'prefix'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let buf = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
    })
    child.on('error', () => {
      resolve(null)
    })
    child.on('exit', (code) => {
      if (code !== 0) {
        resolve(null)
        return
      }
      const trimmed = buf.trim()
      resolve(trimmed.length > 0 ? trimmed : null)
    })
  })
}

async function fail(cfg: UpgradeConfig, message: string): Promise<void> {
  // Preserve any partial state by reading the current file rather
  // than overwriting from scratch. `advanceUpgradeStage('failed')`
  // does the right thing here.
  await advanceUpgradeStage(cfg.home, 'failed', { error: message })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

// Run the helper. Any uncaught error is written to the status file
// before the process exits ... the web UI can surface it.
main().catch(async (err: unknown) => {
  const home = process.env['TWENTYTWOHUNDRED_HOME']
  if (home === undefined || home.length === 0) {
    // Cannot write status without a home. Last-ditch: dump to stderr.
    process.stderr.write(
      `upgrade-runner fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    process.exit(1)
  }
  try {
    const current = await readUpgradeStatus(home)
    const now = new Date().toISOString()
    if (current) {
      await writeUpgradeStatus(home, {
        ...current,
        stage: 'failed',
        updated_at: now,
        finished_at: now,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  } catch {
    // Nothing more to do.
  }
  process.exit(1)
})
