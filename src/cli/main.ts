#!/usr/bin/env node
/**
 * 2200 CLI entry point.
 *
 * Wires the supervisor and Agent lifecycle into the public CLI surface
 * locked in the Epic 2 spec. v1 implements: init, agent create, agent
 * start, agent stop, agent status. The remaining subcommands (agent
 * resume, task *, notification *) are stubs awaiting their respective
 * subsystems (detectors, task state, notification system) to land.
 *
 * Architecturally, the CLI is a thin client over the supervisor's JSON-RPC
 * API: read-only commands hit `state.snapshot`; write commands either
 * mutate state via the in-process Supervisor (when no supervisor process
 * is running) or fall back to spawning the supervisor on demand.
 *
 * For v1, the CLI runs the supervisor in-process for `init`, `agent create`,
 * `agent start`, `agent stop`, `agent status`. A long-running daemon mode
 * (`2200 daemon`) lands in a subsequent PR; until then, `agent start`
 * spawns the Agent and exits, leaving the Agent connected to a transient
 * in-process supervisor that exits with the CLI. The next PR introduces
 * the daemon and the durable supervisor process.
 *
 * See https://github.com/twentytwohundred/2200/wiki/02-agent-runtime-minimum
 * for the locked Epic 2 spec.
 */
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { VERSION } from '../index.js'
import { Supervisor } from '../runtime/supervisor/supervisor.js'

function defaultStateDir(): string {
  return process.env['TWENTYTWOHUNDRED_STATE_DIR'] ?? join(homedir(), '.2200')
}

function notYetImplemented(command: string, lands: string): never {
  console.error(`2200 ${command}: not yet implemented.`)
  console.error('')
  console.error(`This command lands in ${lands}.`)
  console.error(
    'See https://github.com/twentytwohundred/2200/wiki/02-agent-runtime-minimum for the locked Epic 2 spec.',
  )
  process.exit(2)
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
    .option('--state-dir <path>', 'override the default state directory (~/.2200 by default)')

  // ---------------------------------------------------------------------------
  // Top-level: init
  // ---------------------------------------------------------------------------

  program
    .command('init')
    .description('initialize the 2200 supervisor state directory')
    .action(async () => {
      const stateDir = program.opts<{ stateDir?: string }>().stateDir ?? defaultStateDir()
      const supervisor = await Supervisor.create({ stateDir })
      const snapshot = supervisor.snapshot()
      console.log(`Initialized 2200 state directory at ${snapshot.state_dir}`)
      console.log(`Schema version: ${String(snapshot.schema_version)}`)
      console.log(`Agents: ${String(Object.keys(snapshot.agents).length)}`)
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
      const stateDir = program.opts<{ stateDir?: string }>().stateDir ?? defaultStateDir()
      const supervisor = await Supervisor.create({ stateDir })
      await supervisor.createAgent(name, opts.identity)
      console.log(`Agent "${name}" created.`)
      console.log(`Identity: ${opts.identity}`)
      console.log(`Run "2200 agent start ${name}" to bring it up.`)
    })

  agent
    .command('start <name>')
    .description('start an Agent process')
    .action(() => {
      notYetImplemented(
        'agent start',
        'the next PR (durable supervisor daemon + agent start wiring)',
      )
    })

  agent
    .command('stop <name>')
    .description('stop an Agent process gracefully')
    .action(() => {
      notYetImplemented('agent stop', 'the next PR (durable supervisor daemon + agent stop wiring)')
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
      const stateDir = program.opts<{ stateDir?: string }>().stateDir ?? defaultStateDir()
      const supervisor = await Supervisor.create({ stateDir })
      const snapshot = supervisor.snapshot()
      const record = snapshot.agents[name]
      if (!record) {
        console.error(`Agent "${name}" not found in ${snapshot.state_dir}`)
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
