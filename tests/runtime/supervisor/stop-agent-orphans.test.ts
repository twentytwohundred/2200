/**
 * Regression test for the orphaned-Agent stopAgent bug (2026-06-03).
 *
 * Setup:
 *  - A supervisor was running, then was restarted while an Agent
 *    kept running (e.g., via `daemon restart --preserve-fleet` or
 *    any earlier restart that didn't reap children).
 *  - The new supervisor has no `tracked` entry for that Agent, but
 *    the Agent's pid lock is still held by the orphan process.
 *  - Operator triggers `stopAgent` (directly, or via a model switch
 *    / identity edit / restart flow that calls stopAgent first).
 *
 * Old behavior: stopAgent silently no-ops on the empty tracked map,
 * the orphan keeps running with its stale in-memory bindings, and a
 * subsequent startAgent fails to acquire the still-held lock.
 *
 * New behavior: stopAgent reads the pid file when tracked is empty,
 * detects a live orphan via isLockHeld, SIGTERMs (with SIGKILL
 * escalation), cleans up the lock dir + pid file, and only then
 * marks state stopped.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, mkdir, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Supervisor } from '../../../src/runtime/supervisor/supervisor.js'
import { agentPaths } from '../../../src/runtime/storage/layout.js'
import { isLockHeld } from '../../../src/runtime/supervisor/process-lock.js'
import type { Listener } from '../../../src/runtime/control-plane/transport.js'

let home: string
let sup: Supervisor
const orphans: ChildProcess[] = []

class NullListener implements Listener {
  connections(): AsyncIterable<never> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<never> {
        return { next: () => new Promise<IteratorResult<never>>(() => undefined) }
      },
    }
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}

/**
 * Spawn a small helper that acquires the Agent's pid lock and holds
 * it until it receives SIGTERM. Simulates an orphaned Agent process
 * the supervisor doesn't know about.
 */
async function spawnOrphanHolder(home: string, agentName: string): Promise<ChildProcess> {
  const ap = agentPaths(home, agentName)
  await mkdir(ap.brain, { recursive: true })
  await mkdir(join(home, 'agents', agentName, 'project'), { recursive: true })
  // Inline JS that locks the pid file. Same lockfile lib (`proper-
  // lockfile`) the production code uses, so the lock semantics are
  // identical.
  const script = `
    const lockfile = require('proper-lockfile')
    const { writeFile } = require('node:fs/promises')
    const pidFile = ${JSON.stringify(ap.pidFile)}
    ;(async () => {
      await writeFile(pidFile, String(process.pid) + '\\n')
      const release = await lockfile.lock(pidFile, { stale: 10_000, update: 5_000, realpath: false, retries: 0 })
      // Stay alive until SIGTERM. The supervisor's killOrphanedAgentIfAny
      // path is what should terminate this process.
      const onSignal = () => {
        Promise.resolve(release()).finally(() => process.exit(0))
      }
      process.on('SIGTERM', onSignal)
      process.on('SIGINT', onSignal)
      // Heartbeat to keep the event loop alive.
      setInterval(() => {}, 10_000)
    })().catch((err) => {
      console.error(err)
      process.exit(1)
    })
  `
  const child = spawn('node', ['-e', script], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  orphans.push(child)
  // Wait for the lock to be acquired before returning.
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 50))
    if (await isLockHeld(ap.pidFile).catch(() => false)) return child
  }
  throw new Error('orphan helper failed to acquire lock within 3s')
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-orphan-stop-'))
  sup = await Supervisor.create({ home })
  await sup.start({ home, listener: new NullListener() })
})

afterEach(async () => {
  for (const child of orphans.splice(0)) {
    if (!child.killed && child.exitCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }
  }
  await sup.shutdown()
  await rm(home, { recursive: true, force: true })
})

describe('stopAgent on orphans (regression: 2026-06-03 david model-switch)', () => {
  it('kills an orphan that holds the pid lock when tracked is empty', async () => {
    // Manually create the Agent record so stopAgent's "unknown agent"
    // guard doesn't fire. We deliberately don't go through createAgent
    // here — the orphan case is "supervisor was restarted; state.json
    // has the record but tracked is empty".
    const agentName = 'orphan-test'
    const idPath = join(home, 'orphan-test.identity.md')
    await writeFile(
      idPath,
      [
        '---',
        'schema_version: 5',
        `agent_name: ${agentName}`,
        'agent_role: "orphan test"',
        'model:',
        '  tier: frontier',
        '  provider: anthropic',
        '  model_id: claude-opus-4-7',
        'tools: []',
        `project_dir: ${join(home, 'agents', agentName, 'project')}`,
        `brain_dir: ${join(home, 'agents', agentName, 'brain')}`,
        'created: 2026-06-03',
        '---',
        '',
        '# Identity',
      ].join('\n'),
    )
    await sup.createAgent(agentName, idPath)

    // Stop the Agent the supervisor just created (so `tracked` is
    // empty for the next phase). The supervisor's startAgent in
    // createAgent doesn't actually launch in this test flow — it
    // just registers the record — so we don't need to stop a real
    // process here. Proceed straight to spawning an orphan.

    // Spawn an orphan that holds the pid lock.
    const orphan = await spawnOrphanHolder(home, agentName)
    const ap = agentPaths(home, agentName)
    expect(await isLockHeld(ap.pidFile)).toBe(true)

    // Verify our test setup: the supervisor's tracked map is empty
    // for this agent. (Public API doesn't expose tracked, but we
    // can verify by reading state — pid should be null since we
    // didn't launch through createAgent's start path.)
    // The orphan PID is the source of truth here.

    // Call stopAgent: the orphan must be killed and the lock freed.
    await sup.stopAgent(agentName, 'test')

    // After stopAgent returns: lock is gone, orphan is dead.
    expect(await isLockHeld(ap.pidFile).catch(() => false)).toBe(false)
    // Orphan process is dead (give it a moment to exit).
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      if (orphan.exitCode !== null || orphan.killed) break
      await new Promise<void>((r) => setTimeout(r, 50))
    }
    expect(orphan.exitCode !== null || orphan.killed).toBe(true)
  }, 15_000)

  it('cleans up stale empty lock dir when no orphan is alive', async () => {
    // Simulate the post-crash state: lock dir exists but is empty,
    // no live process holds the lock. stopAgent should still
    // succeed and clean up the leftover.
    const agentName = 'stale-lock-test'
    const idPath = join(home, 'stale.identity.md')
    await writeFile(
      idPath,
      [
        '---',
        'schema_version: 5',
        `agent_name: ${agentName}`,
        'agent_role: "stale lock"',
        'model:',
        '  tier: frontier',
        '  provider: anthropic',
        '  model_id: claude-opus-4-7',
        'tools: []',
        `project_dir: ${join(home, 'agents', agentName, 'project')}`,
        `brain_dir: ${join(home, 'agents', agentName, 'brain')}`,
        'created: 2026-06-03',
        '---',
        '',
        '# Identity',
      ].join('\n'),
    )
    await sup.createAgent(agentName, idPath)

    // Create a stale empty lock dir (the "post-crash leftover" case
    // we hit on 2026-06-03).
    const ap = agentPaths(home, agentName)
    await mkdir(`${ap.pidFile}.lock`, { recursive: true })

    // stopAgent should clean it up without throwing.
    await sup.stopAgent(agentName, 'test')

    // Lock dir is gone.
    await expect(access(`${ap.pidFile}.lock`)).rejects.toThrow()
  })
})
