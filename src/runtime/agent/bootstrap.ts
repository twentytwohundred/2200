/**
 * Agent process entry point.
 *
 * Spawned by the supervisor via `child_process.spawn`. Reads its config from
 * env vars (set by the supervisor), constructs an `AgentProcess`, and runs
 * it until SIGTERM or supervisor disconnect.
 *
 * This file is the bin target for the Agent process; it is bundled by tsup
 * to `dist/runtime/agent/bootstrap.js`. The supervisor's `lifecycle.spawnAgent`
 * spawns Node with this file as the entry.
 */
import { AgentProcess } from './process.js'
import { createLogger } from '../util/logger.js'

async function main(): Promise<void> {
  const name = process.env['TWENTYTWOHUNDRED_AGENT_NAME']
  const identityPath = process.env['TWENTYTWOHUNDRED_IDENTITY_PATH']
  const socketPath = process.env['TWENTYTWOHUNDRED_SOCKET_PATH']

  if (!name || !identityPath || !socketPath) {
    const log = createLogger('agent/bootstrap')
    log.error('missing required env vars', {
      hasName: !!name,
      hasIdentityPath: !!identityPath,
      hasSocketPath: !!socketPath,
    })
    process.exit(64) // EX_USAGE
  }

  const agent = new AgentProcess({
    name,
    identityPath,
    socketPath,
  })

  const onShutdown = (signal: string): void => {
    void agent.shutdown(`signal:${signal}`).then(() => {
      process.exit(0)
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
