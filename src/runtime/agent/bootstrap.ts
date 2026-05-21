/**
 * Agent process entry point.
 *
 * Started by the supervisor via `child_process.spawn`. Reads its config from
 * env vars (set by the supervisor), constructs an `AgentProcess`, and runs
 * it until SIGTERM or supervisor disconnect.
 *
 * This file is the bin target for the Agent process; it is bundled by tsup
 * to `dist/runtime/agent/bootstrap.js`. The supervisor's `lifecycle.launchAgentProcess`
 * starts Node with this file as the entry.
 */
import { AgentProcess } from './process.js'
import { createLogger } from '../util/logger.js'
import { agentPaths } from '../storage/layout.js'
import { acquireProcessLock, type ProcessLock } from '../supervisor/process-lock.js'

/**
 * Swallow EPIPE on stdout/stderr so a broken pipe (typical cause:
 * the supervisor that started us bounced and closed its read end of
 * our pipes) does not synchronously crash the agent process. Node's
 * default behavior is to throw EPIPE on the next write, which
 * propagates as an uncaught exception and kills the process
 * silently. The supervisor never sees the death and the agent stays
 * marked `running` against a dead PID.
 *
 * Other stream errors (ENOSPC, EBADF, etc.) still surface so a real
 * disk problem doesn't silently get swallowed.
 *
 * Identified via Antigravity codebase review on 2026-05-08; root
 * cause of the "agents die silently when supervisor bounces"
 * regression Doug surfaced during session 13 testing.
 */
function installPipeErrorHandler(stream: NodeJS.WriteStream): void {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') return
    // Re-emit so legitimate errors surface; without this, listening
    // here would silently swallow them.
    throw err
  })
}
installPipeErrorHandler(process.stdout)
installPipeErrorHandler(process.stderr)

// Defense in depth: if any unhandled rejection slips past a
// per-feature try/catch, log it and keep running rather than
// crashing the agent process. Node's default is to crash on
// unhandled rejection in current versions; we'd rather degrade than
// die. Per-feature handlers (heartbeat reconnect, etc.) remain the
// primary line of defense.
process.on('unhandledRejection', (reason) => {
  const log = createLogger('agent/bootstrap')
  log.error('unhandledRejection (kept running)', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  })
})

async function main(): Promise<void> {
  const name = process.env['TWENTYTWOHUNDRED_AGENT_NAME']
  const identityPath = process.env['TWENTYTWOHUNDRED_IDENTITY_PATH']
  const socketPath = process.env['TWENTYTWOHUNDRED_SOCKET_PATH']
  const home = process.env['TWENTYTWOHUNDRED_HOME']

  if (!name || !identityPath || !socketPath || !home) {
    const log = createLogger('agent/bootstrap')
    log.error('missing required env vars', {
      hasName: !!name,
      hasIdentityPath: !!identityPath,
      hasSocketPath: !!socketPath,
      hasHome: !!home,
    })
    process.exit(64) // EX_USAGE
  }

  // Acquire the Agent's process lock. The supervisor (and any future
  // cross-process liveness query) checks lock holdership on this file
  // to decide whether the Agent is alive ... hazard-free vs.
  // kill(pid, 0) on a recycled PID.
  const pidPath = agentPaths(home, name).pidFile
  let agentLock: ProcessLock
  try {
    agentLock = await acquireProcessLock(pidPath, `${String(process.pid)}\n`)
  } catch (err) {
    const log = createLogger('agent/bootstrap')
    log.error('failed to acquire Agent lock', {
      name,
      error: err instanceof Error ? err.message : String(err),
    })
    process.exit(75) // EX_TEMPFAIL
  }

  // Tests can shorten the heartbeat interval via env to make
  // "is the Agent in steady state?" assertions tractable without
  // adding default-10s waits. Production callers leave it unset.
  const heartbeatRaw = process.env['TWENTYTWOHUNDRED_HEARTBEAT_INTERVAL_MS']
  const heartbeatIntervalMs =
    heartbeatRaw !== undefined && heartbeatRaw.length > 0
      ? Number.parseInt(heartbeatRaw, 10)
      : undefined

  const agent = new AgentProcess({
    name,
    identityPath,
    socketPath,
    home,
    ...(heartbeatIntervalMs !== undefined && Number.isFinite(heartbeatIntervalMs)
      ? { heartbeatIntervalMs }
      : {}),
  })

  const onShutdown = (signal: string): void => {
    void agent
      .shutdown(`signal:${signal}`)
      .then(async () => {
        await agentLock.release()
        process.exit(0)
      })
      .catch(() => {
        process.exit(1)
      })
  }
  process.on('SIGTERM', () => {
    onShutdown('SIGTERM')
  })
  process.on('SIGINT', () => {
    onShutdown('SIGINT')
  })

  try {
    await agent.start()
  } catch (err) {
    const log = createLogger('agent/bootstrap')
    log.error('Agent failed to start', {
      name,
      error: err instanceof Error ? err.message : String(err),
    })
    process.exit(1)
  }

  // Stay alive until the supervisor disconnects or a signal arrives.
  // Heartbeat timer keeps the event loop active.
}

void main().catch((err: unknown) => {
  const log = createLogger('agent/bootstrap')
  log.error('unhandled error in main', {
    error: err instanceof Error ? err.message : String(err),
  })
  process.exit(1)
})
