#!/usr/bin/env node
/**
 * 2200 CLI entry point.
 *
 * Wires the supervisor and Agent lifecycle into the public CLI surface
 * locked in the Epic 2 spec. v1 implements: init, daemon (start/stop/
 * status/foreground), agent create, agent start, agent stop, agent status.
 * The remaining subcommands (agent resume, task *, notification *) are
 * stubs awaiting their respective subsystems (detectors, task state,
 * notification system) to land.
 *
 * Architecturally, the CLI is a thin client over the supervisor's JSON-RPC
 * API. When a daemon is running on the configured state directory, write
 * commands route through it via UDS RPC so the daemon's in-memory state
 * stays consistent. When no daemon is running, in-process operations are
 * used for state-only commands (`init`, `agent create`, `agent status`),
 * and process-spawning commands (`agent start`, `agent stop`) error with
 * a clear "start the daemon first" message.
 *
 * See https://github.com/twentytwohundred/.github/wiki/02-agent-runtime-minimum
 * for the locked Epic 2 spec.
 */
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { VERSION } from '../index.js'
import { Supervisor } from '../runtime/supervisor/supervisor.js'
import { JsonRpcClient } from '../runtime/control-plane/client.js'
import { connectUds } from '../runtime/control-plane/transport-uds.js'
import type { StateSnapshotResult } from '../runtime/control-plane/protocol.js'
import { spawnDaemon, killDaemon, logFilePath } from '../runtime/supervisor/daemon.js'
import { readLivePid } from '../runtime/supervisor/pidfile.js'
import { resolveHome, saveUserConfig } from '../runtime/config/loader.js'

interface TopLevelOpts {
  home?: string
}

async function resolveHomeFromOpts(program: Command): Promise<string> {
  const opts = program.opts<TopLevelOpts>()
  return resolveHome(opts.home)
}

function notYetImplemented(command: string, lands: string): never {
  console.error(`2200 ${command}: not yet implemented.`)
  console.error('')
  console.error(`This command lands in ${lands}.`)
  console.error(
    'See https://github.com/twentytwohundred/.github/wiki/02-agent-runtime-minimum for the locked Epic 2 spec.',
  )
  process.exit(2)
}

/**
 * Connect to a running supervisor daemon if one is live on the given
 * 2200_HOME. Returns null if no daemon is running. Throws on UDS
 * connect failure even when the PID file says a daemon should be there
 * (likely a stale socket or permissions issue).
 */
async function connectToDaemon(home: string): Promise<JsonRpcClient | null> {
  const pid = await readLivePid(home)
  if (pid === null) return null
  const conn = await connectUds(Supervisor.socketPath(home))
  return new JsonRpcClient(conn)
}

/**
 * Read the current state snapshot. If a daemon is running, RPC to it for
 * the freshest in-memory view; otherwise read directly from disk.
 */
async function readSnapshot(home: string): Promise<StateSnapshotResult> {
  const client = await connectToDaemon(home)
  if (client) {
    try {
      return await client.call('state.snapshot', {})
    } finally {
      await client.close()
    }
  }
  const supervisor = await Supervisor.create({ home })
  return supervisor.snapshot()
}

/**
 * Build the commander program for 2200's CLI.
 *
 * Exported so tests can verify command structure without invoking the parser.
 */
export function buildProgram(): Command {
  const program = new Command()

  program
    .name('2200')
    .description('A platform for hosting your fleet of always-on Agents.')
    .version(VERSION, '-v, --version', 'output the current version')
    .helpOption('-h, --help', 'display help for command')
    .option(
      '--home <path>',
      'override 2200_HOME (defaults: $TWENTYTWOHUNDRED_HOME, then user config, then $XDG_DATA_HOME/2200/ -> ~/.local/share/2200/)',
    )

  // ---------------------------------------------------------------------------
  // Top-level: init
  // ---------------------------------------------------------------------------

  program
    .command('init')
    .description('initialize 2200_HOME (creates the directory layout and writes user config)')
    .action(async () => {
      const home = await resolveHomeFromOpts(program)
      // Persist `home` to the user config so subsequent invocations
      // resolve it without --home or env. Per the commons-and-storage-root
      // spec addendum.
      await saveUserConfig({ schema_version: 1, home })
      const supervisor = await Supervisor.create({ home })
      const snapshot = supervisor.snapshot()
      console.log(`Initialized 2200_HOME at ${snapshot.home}`)
      console.log(`  state dir:   ${snapshot.state_dir}`)
      console.log(`  schema:      v${String(snapshot.schema_version)}`)
      console.log(`  agents:      ${String(Object.keys(snapshot.agents).length)}`)
      console.log(`Layout: commons/{reference,scratch}, agents/, state/, config/`)
    })

  // ---------------------------------------------------------------------------
  // 2200 daemon <subcommand>
  // ---------------------------------------------------------------------------

  const daemon = program
    .command('daemon')
    .description('manage the long-running supervisor daemon (start, stop, status)')

  daemon
    .command('start')
    .description('start the supervisor as a detached background daemon')
    .action(async () => {
      const home = await resolveHomeFromOpts(program)
      const pid = await spawnDaemon({ home })
      console.log(`supervisor daemon started`)
      console.log(`  pid:        ${String(pid)}`)
      console.log(`  home:       ${home}`)
      console.log(`  log file:   ${logFilePath(home)}`)
      console.log(`  socket:     ${Supervisor.socketPath(home)}`)
    })

  daemon
    .command('stop')
    .description('stop the running supervisor daemon (SIGTERM, then SIGKILL on timeout)')
    .action(async () => {
      const home = await resolveHomeFromOpts(program)
      const stopped = await killDaemon(home)
      if (stopped) {
        console.log('supervisor daemon stopped')
      } else {
        console.log('no supervisor daemon was running')
      }
    })

  daemon
    .command('status')
    .description('show whether a supervisor daemon is running on the configured 2200_HOME')
    .action(async () => {
      const home = await resolveHomeFromOpts(program)
      const pid = await readLivePid(home)
      if (pid === null) {
        console.log(`supervisor daemon: not running (home: ${home})`)
        process.exit(1)
      }
      console.log(`supervisor daemon: running`)
      console.log(`  pid:        ${String(pid)}`)
      console.log(`  home:       ${home}`)
      console.log(`  log file:   ${logFilePath(home)}`)
      console.log(`  socket:     ${Supervisor.socketPath(home)}`)
    })

  // ---------------------------------------------------------------------------
  // 2200 agent <subcommand>
  // ---------------------------------------------------------------------------

  const agent = program.command('agent').description('manage Agents (create, start, stop, status)')

  agent
    .command('create <name>')
    .description('register a new Agent with the supervisor')
    .requiredOption('--identity <path>', 'path to the Agent Identity markdown file')
    .action(async (name: string, opts: { identity: string }) => {
      const home = await resolveHomeFromOpts(program)
      const client = await connectToDaemon(home)
      if (client) {
        try {
          await client.call('cli.agent.create', { name, identity_path: opts.identity })
        } finally {
          await client.close()
        }
      } else {
        const supervisor = await Supervisor.create({ home })
        await supervisor.createAgent(name, opts.identity)
      }
      console.log(`Agent "${name}" created.`)
      console.log(`Run "2200 agent start ${name}" to bring it up.`)
    })

  agent
    .command('start <name>')
    .description('start an Agent process (requires a running daemon)')
    .action(async (name: string) => {
      const home = await resolveHomeFromOpts(program)
      const client = await connectToDaemon(home)
      if (!client) {
        console.error(
          `agent start requires a running supervisor daemon. Start one with "2200 daemon start" first.`,
        )
        process.exit(1)
      }
      try {
        const result = await client.call('cli.agent.start', { name })
        console.log(`Agent "${name}" started (pid ${String(result.pid)}).`)
      } finally {
        await client.close()
      }
    })

  agent
    .command('stop <name>')
    .description('stop an Agent process gracefully (requires a running daemon)')
    .action(async (name: string) => {
      const home = await resolveHomeFromOpts(program)
      const client = await connectToDaemon(home)
      if (!client) {
        console.error(
          `agent stop requires a running supervisor daemon. Start one with "2200 daemon start" first.`,
        )
        process.exit(1)
      }
      try {
        await client.call('cli.agent.stop', { name })
        console.log(`Agent "${name}" stopped.`)
      } finally {
        await client.close()
      }
    })

  agent
    .command('resume <name>')
    .description('resume an Agent paused on a detector trip')
    .action(() => {
      notYetImplemented('agent resume', 'a future PR (loop and stuck-Agent detection)')
    })

  agent
    .command('status <name>')
    .description('show the current state of an Agent (running, blocked, errored, ...)')
    .action(async (name: string) => {
      const home = await resolveHomeFromOpts(program)
      const snapshot = await readSnapshot(home)
      const record = snapshot.agents[name]
      if (!record) {
        console.error(`Agent "${name}" not found in ${snapshot.home}`)
        process.exit(1)
      }
      console.log(`Name:           ${record.name}`)
      console.log(`State:          ${record.state}`)
      console.log(`Identity:       ${record.identity_path}`)
      console.log(`PID:            ${record.pid === null ? '(none)' : String(record.pid)}`)
      console.log(`Last heartbeat: ${record.last_heartbeat ?? '(none)'}`)
      if (record.errored_at) {
        console.log(`Errored at:     ${record.errored_at}`)
        console.log(`Error reason:   ${record.errored_reason ?? '(none)'}`)
      }
    })

  // ---------------------------------------------------------------------------
  // 2200 task <subcommand>
  // ---------------------------------------------------------------------------

  const task = program.command('task').description('manage tasks (submit, list)')

  task
    .command('submit <agent> <task>')
    .description('submit a task to an Agent')
    .action(() => {
      notYetImplemented('task submit', 'a future PR (Agent loop + task state machine)')
    })

  task
    .command('list <agent>')
    .description('list tasks for an Agent')
    .action(() => {
      notYetImplemented('task list', 'a future PR (task state)')
    })

  // ---------------------------------------------------------------------------
  // 2200 notification <subcommand>
  // ---------------------------------------------------------------------------

  const notification = program
    .command('notification')
    .description('manage pending notifications from Agents (list, respond)')

  notification
    .command('list')
    .description('list pending notifications across all Agents')
    .action(() => {
      notYetImplemented(
        'notification list',
        'a future PR (notification system at v1; Epic 7 owns the full tier system)',
      )
    })

  notification
    .command('respond <id> <response>')
    .description('respond to a pending notification, unblocking the Agent')
    .action(() => {
      notYetImplemented(
        'notification respond',
        'a future PR (notification system + loop wake on response)',
      )
    })

  return program
}

/**
 * Entry-point guard: only invoke the parser when this module is executed
 * directly (e.g., via `2200 ...` or `node dist/cli/main.js`). When imported
 * by tests, the parse does not run.
 */
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]

if (invokedDirectly) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    })
}
