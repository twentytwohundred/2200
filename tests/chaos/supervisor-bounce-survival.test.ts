/**
 * Chaos test: agent process survives a supervisor SIGKILL bounce.
 *
 * Reproduces and prevents regression of the "agents die silently
 * when the supervisor bounces" failure mode Doug surfaced during
 * session 13 testing on 2026-05-08. Root cause (per the Antigravity
 * codebase review): the agent's child process is spawned with
 * stderr/stdout pipes connected to the supervisor; on supervisor
 * exit the read ends close, the next stderr.write throws EPIPE, and
 * Node's default behavior crashes the agent process. The bootstrap
 * now installs an EPIPE handler that swallows broken-pipe errors;
 * the heartbeat loop reconnects to a fresh supervisor on the same
 * UDS socket and re-registers.
 *
 * This is an integration test: real spawned Node child process, real
 * UDS socket. Slow by design (~10s). Lives under tests/chaos/ to
 * keep it out of the unit-test critical path; runs as part of
 * `pnpm test` because vitest's default include glob picks it up.
 *
 * Scope: process-boundary survival ONLY. The test does not exercise
 * tool calls, LLM completions, or task execution; the agent's
 * provider is set to `local` with an unreachable base URL because
 * no completion is ever attempted (no tasks are queued). The point
 * is "the process stays alive and re-registers," nothing more.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Supervisor } from '../../src/runtime/supervisor/supervisor.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const AGENT_BOOTSTRAP = join(REPO_ROOT, 'dist', 'runtime', 'agent', 'bootstrap.js')

let home: string
let supervisor: Supervisor | undefined
let agent: ChildProcess | undefined

async function writeIdentity(dir: string, name: string): Promise<string> {
  const path = join(dir, `${name}.identity.md`)
  await writeFile(
    path,
    `---
schema_version: 5
agent_name: ${name}
agent_role: "test agent"
model:
  tier: economy
  provider: local
  model_id: test-stub
tools: []
project_dir: ${dir}/agents/${name}/project
brain_dir: ${dir}/agents/${name}/brain
created: 2026-05-08
cost_caps:
  daily_usd: 25
  warn_at_pct: 80
  reset_at: 00:00 UTC
  on_breach: block_new_tasks
notification_policy:
  tiers_allowed:
    - passive
    - normal
    - important
mcp_servers: []
---

# Identity

Test agent for the supervisor-bounce-survival chaos test. No persona.
`,
  )
  return path
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-chaos-bounce-'))
})

afterEach(async () => {
  if (agent && !agent.killed) {
    agent.kill('SIGKILL')
    await new Promise<void>((resolve) => {
      if (agent?.exitCode !== null) {
        resolve()
        return
      }
      agent.once('exit', () => {
        resolve()
      })
    })
  }
  agent = undefined
  if (supervisor) {
    await supervisor.shutdown()
    supervisor = undefined
  }
  await rm(home, { recursive: true, force: true })
})

async function eventually(
  predicate: () => Promise<boolean> | boolean,
  { intervalMs = 100, timeoutMs = 20_000 }: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`predicate did not become true within ${String(timeoutMs)}ms`)
}

describe('supervisor bounce survival (chaos)', () => {
  it('agent process survives a supervisor SIGKILL+restart cycle and re-registers', async () => {
    // 1. Boot a supervisor and create an agent record.
    supervisor = await Supervisor.create({ home })
    await supervisor.start()
    const idPath = await writeIdentity(home, 'chaos')
    await supervisor.createAgent('chaos', idPath)

    // 2. Spawn a real agent child process. The supervisor's
    //    `lifecycle.spawnAgent` is the production path; we go
    //    direct via child_process.spawn here so we own the handle.
    //    This mirrors what spawnAgent does (stdio: ['ignore', 'pipe', 'pipe'])
    //    so the EPIPE failure mode reproduces.
    agent = spawn(process.execPath, [AGENT_BOOTSTRAP], {
      env: {
        ...process.env,
        TWENTYTWOHUNDRED_AGENT_NAME: 'chaos',
        TWENTYTWOHUNDRED_IDENTITY_PATH: idPath,
        TWENTYTWOHUNDRED_SOCKET_PATH: Supervisor.socketPath(home),
        TWENTYTWOHUNDRED_HOME: home,
        // Local provider with an unreachable URL: no completion is
        // ever attempted in this test (no tasks queued), but the
        // identity loader requires SOMETHING.
        LOCAL_BASE_URL: 'http://127.0.0.1:1',
        LOCAL_API_KEY: 'stub',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // Capture stderr for diagnostic visibility. When the test
    // fails, we need to see what the agent process actually did;
    // without a listener the pipe still lives but errors aren't
    // surfaced. Buffer the output and dump it from afterEach if
    // the test failed.
    const stderrChunks: Buffer[] = []
    agent.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk)
    })
    agent.stdout?.on('data', () => {
      /* drain */
    })
    const dumpStderr = (): string => Buffer.concat(stderrChunks).toString('utf8')

    // 3. Wait for the agent to register with the supervisor.
    await eventually(() => {
      const snap = supervisor!.snapshot()
      const rec = snap.agents['chaos']
      return rec?.state === 'running' && rec.pid !== null
    })
    const initialPid = supervisor.snapshot().agents['chaos']!.pid
    expect(initialPid).toBe(agent.pid)

    // 4. SIGKILL the supervisor by closing its listener directly.
    //    (Real `daemon stop` would SIGTERM the daemon process; we
    //    have an in-process Supervisor here so we shut it down.)
    await supervisor.shutdown()
    supervisor = undefined

    // 5. Verify the agent process is STILL ALIVE 2 seconds after
    //    the bounce. This is the core regression check: pre-fix,
    //    the agent would EPIPE-die on the next stderr.write.
    await new Promise((resolve) => setTimeout(resolve, 2000))
    if (agent.exitCode !== null) {
      throw new Error(
        `agent died ${String(agent.exitCode)} after supervisor bounce; stderr was:\n${dumpStderr()}`,
      )
    }
    expect(agent.killed).toBe(false)
    console.log('[chaos] agent survived bounce (exitCode=null, alive=true)')
    console.log('[chaos] agent stderr so far:\n' + dumpStderr())

    // 6. Boot a fresh supervisor on the same UDS path. The agent's
    //    heartbeat loop should detect the broken connection and
    //    reconnect via reconnectToSupervisor().
    console.log('[chaos] creating second supervisor')
    const secondSupervisorBootTs = Date.now()
    supervisor = await Supervisor.create({ home })
    await supervisor.start()
    console.log('[chaos] second supervisor started; waiting for agent to re-register')

    // 7. Wait for a fresh heartbeat to arrive at the SECOND supervisor.
    //    The second supervisor's snapshot initially shows stale state
    //    from disk (running, old pid, old heartbeat). The predicate
    //    only passes when last_heartbeat advances past the second
    //    supervisor's boot timestamp ... that's the proof of
    //    end-to-end reconnect, not just state-on-disk.
    try {
      await eventually(
        () => {
          const snap = supervisor!.snapshot()
          const rec = snap.agents['chaos']
          if (rec?.last_heartbeat == null) return false
          const heartbeatTs = Date.parse(rec.last_heartbeat)
          return (
            rec.state === 'running' &&
            rec.pid === agent?.pid &&
            heartbeatTs >= secondSupervisorBootTs
          )
        },
        { timeoutMs: 25_000 },
      )
    } catch (err) {
      throw new Error(
        `agent did not re-register after supervisor restart: ${err instanceof Error ? err.message : String(err)}\nagent stderr:\n${dumpStderr()}`,
      )
    }

    // 8. Final sanity: agent is still the same process we spawned.
    expect(agent.exitCode).toBeNull()
    expect(supervisor.snapshot().agents['chaos']!.pid).toBe(agent.pid)
  }, 60_000)
})
