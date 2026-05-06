/**
 * Supervisor process entry point.
 *
 * This is the bundled bin target the `2200 daemon start` command spawns
 * detached. It also runs in the foreground when a developer invokes
 * `2200 daemon` (no subcommand) — useful for development, debugging,
 * and tests.
 *
 * Reads `--state-dir <path>` from argv (or `TWENTYTWOHUNDRED_STATE_DIR`
 * env var; argv wins). Instantiates the Supervisor, listens on the UDS,
 * writes the PID file with its own PID, and runs until SIGTERM/SIGINT.
 *
 * On graceful shutdown: stops accepting new connections, sends stop to
 * every running Agent, persists final state, removes the PID file, exits
 * cleanly (code 0).
 */
import { Supervisor } from './supervisor.js'
import { writePidFile, removePidFile } from './pidfile.js'
import { createLogger } from '../util/logger.js'

interface BootstrapArgs {
  home: string
  webPort: number
  webHost: string
}

function parseArgs(argv: string[]): BootstrapArgs {
  let home: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--home' && i + 1 < argv.length) {
      home = argv[i + 1]
      i++
    }
  }
  home ??= process.env['TWENTYTWOHUNDRED_HOME']
  if (!home) {
    throw new Error('--home <path> required (or set TWENTYTWOHUNDRED_HOME)')
  }
  const portRaw = process.env['TWENTYTWOHUNDRED_WEB_PORT']
  const webPort = portRaw ? Number.parseInt(portRaw, 10) : 2200
  const webHost = process.env['TWENTYTWOHUNDRED_WEB_HOST'] ?? '127.0.0.1'
  return { home, webPort, webHost }
}

async function main(): Promise<void> {
  const log = createLogger('supervisor/bootstrap')
  let args: BootstrapArgs
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    log.error('arg parsing failed', { error: err instanceof Error ? err.message : String(err) })
    process.exit(64) // EX_USAGE
  }

  const { resolveRuntimeMode } = await import('../config/runtime-mode.js')
  const runtimeMode = resolveRuntimeMode(process.env)

  const supervisor = await Supervisor.create({
    home: args.home,
    web: { port: args.webPort, host: args.webHost },
    runtimeMode,
  })
  await supervisor.start({
    home: args.home,
    web: { port: args.webPort, host: args.webHost },
    runtimeMode,
  })
  await writePidFile(args.home, process.pid)

  log.info('supervisor daemon up', { pid: process.pid, home: args.home, runtime_mode: runtimeMode })

  let shuttingDown = false
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log.info('shutdown signal received', { signal })
    try {
      await supervisor.shutdown()
      await removePidFile(args.home)
    } catch (err) {
      log.error('error during shutdown', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    process.exit(0)
  }

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })

  // Stay alive until a signal arrives. The supervisor keeps the event
  // loop active via its UDS listener.
}

void main().catch((err: unknown) => {
  const log = createLogger('supervisor/bootstrap')
  log.error('unhandled error in main', {
    error: err instanceof Error ? err.message : String(err),
  })
  process.exit(1)
})
