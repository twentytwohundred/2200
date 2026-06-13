/**
 * Tests for `runtime/install/upgrade-trigger.ts`.
 *
 * The trigger module is the bridge between the HTTP route and the
 * detached helper. We exercise its decision logic (source-checkout
 * refusal, up-to-date short-circuit, registry-error short-circuit)
 * without spawning a real helper process: we redirect the runner
 * path to a stub binary so the spawn succeeds but does nothing.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, chmod, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { triggerUpgrade } from '../../../src/runtime/install/upgrade-trigger.js'
import {
  readUpgradeStatus,
  writeUpgradeStatus,
} from '../../../src/runtime/install/upgrade-status.js'

describe('triggerUpgrade', () => {
  let home: string
  let runnerPath: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), '2200-ut-'))
    await mkdir(join(home, 'state'), { recursive: true })
    // Stub runner: a do-nothing executable. The trigger spawns it
    // detached; we never observe its output.
    runnerPath = join(home, 'stub-runner.js')
    await writeFile(runnerPath, '#!/usr/bin/env node\nprocess.exit(0)\n', 'utf8')
    await chmod(runnerPath, 0o755)
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it('refuses when running from a source checkout', async () => {
    // A source checkout (no node_modules in modulePath) must not be
    // auto-upgradable: doing so would shadow the dev binary.
    const result = await triggerUpgrade({
      home,
      modulePath: '/Users/me/code/2200/dist/runtime/install/upgrade-trigger.js',
      versionCheck: { kind: 'update-available', current: '0.1.0', latest: '0.2.0' },
      runnerPath,
    })
    expect(result.kind).toBe('source-checkout')
    // No status file should have been written.
    expect(await readUpgradeStatus(home)).toBeNull()
  })

  it('returns up-to-date without writing a status file', async () => {
    // Calling the endpoint when there's no newer version available
    // is a normal case (a curious operator clicking Upgrade). The
    // status file must NOT be touched, or the web app would think
    // an upgrade was queued.
    const result = await triggerUpgrade({
      home,
      modulePath:
        '/lib/node_modules/@twentytwohundred/2200/dist/runtime/install/upgrade-trigger.js',
      versionCheck: { kind: 'up-to-date', current: '0.1.0', latest: '0.1.0' },
      runnerPath,
    })
    expect(result.kind).toBe('up-to-date')
    expect(await readUpgradeStatus(home)).toBeNull()
  })

  it('surfaces registry-error', async () => {
    const result = await triggerUpgrade({
      home,
      modulePath:
        '/lib/node_modules/@twentytwohundred/2200/dist/runtime/install/upgrade-trigger.js',
      versionCheck: { kind: 'registry-error', current: '0.1.0', message: 'offline' },
      runnerPath,
    })
    expect(result.kind).toBe('registry-error')
    if (result.kind === 'registry-error') {
      expect(result.message).toBe('offline')
    }
    expect(await readUpgradeStatus(home)).toBeNull()
  })

  it('writes status=pending and spawns the helper on the happy path', async () => {
    const result = await triggerUpgrade({
      home,
      modulePath:
        '/lib/node_modules/@twentytwohundred/2200/dist/runtime/install/upgrade-trigger.js',
      versionCheck: { kind: 'update-available', current: '0.1.0', latest: '0.2.0' },
      runnerPath,
    })
    expect(result.kind).toBe('started')
    if (result.kind === 'started') {
      expect(result.current).toBe('0.1.0')
      expect(result.target).toBe('0.2.0')
      expect(result.daemon_pid).toBe(process.pid)
      expect(result.helper_pid).toBeGreaterThan(0)
    }

    const status = await readUpgradeStatus(home)
    expect(status).not.toBeNull()
    expect(status?.stage).toBe('pending')
    expect(status?.version_from).toBe('0.1.0')
    expect(status?.version_to).toBe('0.2.0')
    expect(status?.error).toBeNull()
  })

  it('reports registry-error when the runner is missing from dist', async () => {
    // Defensive: if the install tarball did not ship the upgrade
    // helper, the HTTP route must NOT pretend an upgrade is queued.
    // Otherwise the web UI would poll forever for a stage change.
    const result = await triggerUpgrade({
      home,
      modulePath:
        '/lib/node_modules/@twentytwohundred/2200/dist/runtime/install/upgrade-trigger.js',
      versionCheck: { kind: 'update-available', current: '0.1.0', latest: '0.2.0' },
      runnerPath: '/no/such/path/runner.js',
    })
    expect(result.kind).toBe('registry-error')
    if (result.kind === 'registry-error') {
      expect(result.message).toMatch(/upgrade-runner not found/)
    }
  })

  it('resolves the runner from the dist root when invoked from the daemon bundle', async () => {
    // Regression: tsup inlines upgrade-trigger into the supervisor
    // bootstrap bundle, so at runtime `import.meta.url` points at
    // `<dist>/runtime/supervisor/bootstrap.js`, NOT `runtime/install/`.
    // A naive `dirname(modulePath)/upgrade-runner.js` resolved to a
    // non-existent file and bricked the web "click Upgrade" path
    // (2026-06-13 audit). The resolver must walk up to the dist root
    // and find the runner at its real location. Here we build a fake
    // dist layout and pass NO runnerPath override so the default
    // resolution runs.
    const dist = join(home, 'node_modules', '@twentytwohundred', '2200-cli', 'dist')
    await mkdir(join(dist, 'runtime', 'install'), { recursive: true })
    await mkdir(join(dist, 'runtime', 'supervisor'), { recursive: true })
    const realRunner = join(dist, 'runtime', 'install', 'upgrade-runner.js')
    await writeFile(realRunner, '#!/usr/bin/env node\nprocess.exit(0)\n', 'utf8')
    await chmod(realRunner, 0o755)
    const daemonBundle = join(dist, 'runtime', 'supervisor', 'bootstrap.js')

    const result = await triggerUpgrade({
      home,
      modulePath: daemonBundle,
      versionCheck: { kind: 'update-available', current: '0.1.0', latest: '0.2.0' },
      // No runnerPath override: exercise the default resolver.
    })
    // It must NOT be a 'runner not found' registry-error.
    expect(result.kind).toBe('started')
    expect((await readUpgradeStatus(home))?.stage).toBe('pending')
  })

  it('refuses a second concurrent trigger while one is already in flight', async () => {
    // In-flight guard: a rapid second click must not spawn a second
    // detached runner racing the first. A recent non-terminal status
    // means "still upgrading".
    const now = new Date().toISOString()
    await writeUpgradeStatus(home, {
      schema_version: 1,
      stage: 'installing',
      version_from: '0.1.0',
      version_to: '0.2.0',
      triggered_at: now,
      updated_at: now,
      finished_at: null,
      error: null,
    })
    const result = await triggerUpgrade({
      home,
      modulePath:
        '/lib/node_modules/@twentytwohundred/2200/dist/runtime/install/upgrade-trigger.js',
      versionCheck: { kind: 'update-available', current: '0.1.0', latest: '0.2.0' },
      runnerPath,
    })
    expect(result.kind).toBe('already-in-progress')
    if (result.kind === 'already-in-progress') {
      expect(result.stage).toBe('installing')
    }
  })

  it('allows a fresh trigger once a prior upgrade looks stale (crashed runner)', async () => {
    // A non-terminal status that has not advanced for a long time means
    // the prior runner died; a new attempt must be allowed to recover.
    const old = new Date(Date.now() - 10 * 60_000).toISOString()
    await writeUpgradeStatus(home, {
      schema_version: 1,
      stage: 'installing',
      version_from: '0.1.0',
      version_to: '0.2.0',
      triggered_at: old,
      updated_at: old,
      finished_at: null,
      error: null,
    })
    const result = await triggerUpgrade({
      home,
      modulePath:
        '/lib/node_modules/@twentytwohundred/2200/dist/runtime/install/upgrade-trigger.js',
      versionCheck: { kind: 'update-available', current: '0.1.0', latest: '0.2.0' },
      runnerPath,
    })
    expect(result.kind).toBe('started')
  })
})
