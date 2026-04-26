#!/usr/bin/env node
/**
 * 2200 CLI entry point.
 *
 * Stub at PR 2: every subcommand surfaces a "not yet implemented" message
 * pointing at the spec section that captures the eventual behavior. Real
 * implementations land on subsequent PRs as the supervisor, Agent loop,
 * Identity loader, MCP-native tool layer, plan/run/perm wrapping, and the
 * detectors ship.
 *
 * Why scaffold the dispatch shape now: the CLI surface is part of the public
 * contract per the Epic 2 spec. Locking the surface (command names, argument
 * shapes, help text) before the implementations land means the supervisor and
 * downstream PRs hook into a known shape rather than re-deriving it.
 *
 * See https://github.com/twentytwohundred/2200/wiki/02-agent-runtime-minimum
 * for the locked Epic 2 spec.
 */
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { VERSION } from '../index.js'

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

  // ---------------------------------------------------------------------------
  // Top-level: init
  // ---------------------------------------------------------------------------

  program
    .command('init')
    .description('initialize the 2200 supervisor state directory')
    .option('--state-dir <path>', 'override the default state directory')
    .action(() => {
      notYetImplemented('init', 'a future PR (supervisor + state-on-disk scaffold)')
    })

  // ---------------------------------------------------------------------------
  // 2200 agent <subcommand>
  // ---------------------------------------------------------------------------

  const agent = program.command('agent').description('manage Agents (create, start, stop, status)')

  agent
    .command('create')
    .description('register a new Agent with the supervisor')
    .requiredOption('--identity <path>', 'path to the Agent Identity markdown file')
    .action(() => {
      notYetImplemented('agent create', 'a future PR (Identity loader + supervisor)')
    })

  agent
    .command('start <name>')
    .description('start an Agent process')
    .action(() => {
      notYetImplemented('agent start', 'a future PR (supervisor + Agent process model)')
    })

  agent
    .command('stop <name>')
    .description('stop an Agent process gracefully')
    .action(() => {
      notYetImplemented('agent stop', 'a future PR (supervisor + Agent process model)')
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
    .action(() => {
      notYetImplemented('agent status', 'a future PR (supervisor)')
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
