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
import * as readline from 'node:readline'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Command } from 'commander'
import { VERSION } from '../index.js'
import { Supervisor } from '../runtime/supervisor/supervisor.js'
import { JsonRpcClient } from '../runtime/control-plane/client.js'
import { connectUds } from '../runtime/control-plane/transport-uds.js'
import type { StateSnapshotResult } from '../runtime/control-plane/protocol.js'
import { spawnDaemon, killDaemon, logFilePath } from '../runtime/supervisor/daemon.js'
import { readLivePid } from '../runtime/supervisor/pidfile.js'
import { resolveHome, saveUserConfig } from '../runtime/config/loader.js'
import { homePaths } from '../runtime/storage/layout.js'
import { loadUserIdentity } from '../runtime/user/loader.js'
import { readCredentialFile } from '../runtime/pub/keypair.js'
import { loadState } from '../runtime/supervisor/state.js'
import { PubClient } from '../runtime/pub/client.js'
import { readRoster } from '../runtime/pub/roster.js'

interface TopLevelOpts {
  home?: string
}

async function resolveHomeFromOpts(program: Command): Promise<string> {
  const opts = program.opts<TopLevelOpts>()
  return resolveHome(opts.home)
}

function firstLine(text: string): string {
  const trimmed = text.trim()
  const idx = trimmed.indexOf('\n')
  return idx === -1 ? trimmed.slice(0, 80) : trimmed.slice(0, Math.min(idx, 80))
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
    .option(
      '--pub <name>',
      'pub to register the Agent against (when the Identity has a pub: block; required only with multiple pubs)',
    )
    .action(async (name: string, opts: { identity: string; pub?: string }) => {
      const home = await resolveHomeFromOpts(program)
      const client = await connectToDaemon(home)
      if (client) {
        try {
          const params: Parameters<typeof client.call<'cli.agent.create'>>[1] = {
            name,
            identity_path: opts.identity,
          }
          if (opts.pub !== undefined) params.pub = opts.pub
          await client.call('cli.agent.create', params)
        } finally {
          await client.close()
        }
      } else {
        const supervisor = await Supervisor.create({ home })
        await supervisor.createAgent(name, opts.identity, {
          ...(opts.pub !== undefined ? { pub: opts.pub } : {}),
        })
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
    .action(async (name: string) => {
      const home = await resolveHomeFromOpts(program)
      const client = await connectToDaemon(home)
      if (!client) {
        console.error(
          `agent resume requires a running supervisor daemon. Start one with "2200 daemon start" first.`,
        )
        process.exit(1)
      }
      try {
        const result = await client.call('cli.agent.resume', { name })
        if (result.resumed_task_id) {
          console.log(`Agent "${name}" resumed (task ${result.resumed_task_id} re-queued).`)
        } else {
          console.log(`Agent "${name}" cleared (no blocked task to resume).`)
        }
      } finally {
        await client.close()
      }
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
    .option('--title <title>', 'short task title (defaults to first line of <task>)')
    .option('--idempotency <kind>', 'pure | checkpointed | destructive (default: pure)')
    .option('--priority <n>', 'integer priority; higher wins (default: 0)', (v) => parseInt(v, 10))
    .action(
      async (
        agentName: string,
        taskBody: string,
        opts: { title?: string; idempotency?: string; priority?: number },
      ) => {
        const home = await resolveHomeFromOpts(program)
        const client = await connectToDaemon(home)
        if (!client) {
          console.error(
            `task submit requires a running supervisor daemon. Start one with "2200 daemon start" first.`,
          )
          process.exit(1)
        }
        const title = opts.title ?? firstLine(taskBody)
        const params: Parameters<typeof client.call<'cli.task.submit'>>[1] = {
          agent: agentName,
          title,
          body: taskBody,
        }
        if (opts.idempotency) {
          if (
            opts.idempotency !== 'pure' &&
            opts.idempotency !== 'checkpointed' &&
            opts.idempotency !== 'destructive'
          ) {
            console.error(`--idempotency must be one of: pure, checkpointed, destructive`)
            process.exit(1)
          }
          params.idempotency = opts.idempotency
        }
        if (opts.priority !== undefined) params.priority = opts.priority
        try {
          const result = await client.call('cli.task.submit', params)
          console.log(`task ${result.task_id} submitted to "${agentName}".`)
        } finally {
          await client.close()
        }
      },
    )

  task
    .command('list <agent>')
    .description('list tasks for an Agent')
    .action(async (agentName: string) => {
      const home = await resolveHomeFromOpts(program)
      const client = await connectToDaemon(home)
      // List works against the on-disk task store even with no daemon; only
      // mutating commands strictly require the daemon. But for consistency
      // with submit (and to avoid duplicating the Supervisor.create path),
      // require the daemon here too. A future PR can add a "list works
      // offline" mode if there is real demand.
      if (!client) {
        console.error(
          `task list requires a running supervisor daemon. Start one with "2200 daemon start" first.`,
        )
        process.exit(1)
      }
      try {
        const result = await client.call('cli.task.list', { agent: agentName })
        if (result.tasks.length === 0) {
          console.log(`No tasks for "${agentName}".`)
          return
        }
        for (const t of result.tasks) {
          const blocked = t.detector_block_kind ? ` (${t.detector_block_kind})` : ''
          console.log(
            `${t.id}  ${t.state.padEnd(20)}${blocked}  prio=${String(t.priority).padStart(2)}  ${t.title}`,
          )
        }
      } finally {
        await client.close()
      }
    })

  // ---------------------------------------------------------------------------
  // 2200 user <subcommand>  (Epic 3 PR B)
  // ---------------------------------------------------------------------------

  const user = program.command('user').description("manage the human user's pub identity (init)")

  user
    .command('init')
    .description(
      "initialize the user's pub identity (mints keypair, registers against the local pub if one is running)",
    )
    .requiredOption('--display-name <name>', 'display name shown to other Agents and the human')
    .option('--handle <handle>', 'short handle (defaults to @<lowercased-display-name>)')
    .option('--pub <name>', 'pub to register against (required when more than one pub exists)')
    .action(async (opts: { displayName: string; handle?: string; pub?: string }) => {
      const home = await resolveHomeFromOpts(program)
      const client = await connectToDaemon(home)
      if (!client) {
        console.error(
          `user init requires a running supervisor daemon. Start one with "2200 daemon start" first.`,
        )
        process.exit(1)
      }
      const params: Parameters<typeof client.call<'cli.user.init'>>[1] = {
        display_name: opts.displayName,
      }
      if (opts.handle !== undefined) params.handle = opts.handle
      if (opts.pub !== undefined) params.pub = opts.pub
      try {
        const result = await client.call('cli.user.init', params)
        console.log(`user identity initialized.`)
        console.log(`  user.md:      ${result.user_md_path}`)
        console.log(`  credentials:  ${result.credentials_path} (mode 0600)`)
        if (result.agent_id) {
          console.log(`  agent_id:     ${result.agent_id}`)
          console.log(`  registered:   ${result.registered_against ?? '<none>'}`)
        } else {
          console.log(`  registration: deferred (no running pub at init time)`)
          console.log(
            `  next:         create + start a pub, then re-run "2200 user init" to register`,
          )
        }
      } finally {
        await client.close()
      }
    })

  // ---------------------------------------------------------------------------
  // 2200 pub <subcommand>  (Epic 3 PR A)
  // ---------------------------------------------------------------------------

  const pub = program
    .command('pub')
    .description('manage local OpenPub instances (create, list, start, stop, status)')

  pub
    .command('create <name>')
    .description('create a new pub on this 2200 instance')
    .option('--description <text>', 'human-readable pub description')
    .option('--capacity <n>', 'max number of agents allowed in the pub', (v) => parseInt(v, 10))
    .option('--port <n>', 'override the supervisor-allocated port', (v) => parseInt(v, 10))
    .option('--issuer <mode>', 'identity issuer mode: local (default) | hub')
    .option('--hub-url <url>', 'hub URL when --issuer hub')
    .action(
      async (
        pubName: string,
        opts: {
          description?: string
          capacity?: number
          port?: number
          issuer?: string
          hubUrl?: string
        },
      ) => {
        const home = await resolveHomeFromOpts(program)
        const client = await connectToDaemon(home)
        if (!client) {
          console.error(
            `pub create requires a running supervisor daemon. Start one with "2200 daemon start" first.`,
          )
          process.exit(1)
        }
        if (opts.issuer && opts.issuer !== 'local' && opts.issuer !== 'hub') {
          console.error(`--issuer must be one of: local, hub`)
          process.exit(1)
        }
        const params: Parameters<typeof client.call<'cli.pub.create'>>[1] = { name: pubName }
        if (opts.description !== undefined) params.description = opts.description
        if (opts.capacity !== undefined) params.capacity = opts.capacity
        if (opts.port !== undefined) params.port = opts.port
        if (opts.issuer === 'local' || opts.issuer === 'hub') params.issuer = opts.issuer
        if (opts.hubUrl !== undefined) params.hub_url = opts.hubUrl
        try {
          const result = await client.call('cli.pub.create', params)
          console.log(
            `pub "${result.name}" created on port ${String(result.port)} (config at ${result.pub_md_path}).`,
          )
        } finally {
          await client.close()
        }
      },
    )

  pub
    .command('start <name>')
    .description('start the pub-server process for an existing pub')
    .action(async (pubName: string) => {
      const home = await resolveHomeFromOpts(program)
      const client = await connectToDaemon(home)
      if (!client) {
        console.error(
          `pub start requires a running supervisor daemon. Start one with "2200 daemon start" first.`,
        )
        process.exit(1)
      }
      try {
        const result = await client.call('cli.pub.start', { name: pubName })
        console.log(
          `pub "${pubName}" started (pid ${String(result.pid)}, port ${String(result.port)}).`,
        )
      } finally {
        await client.close()
      }
    })

  pub
    .command('stop <name>')
    .description('stop a running pub-server')
    .action(async (pubName: string) => {
      const home = await resolveHomeFromOpts(program)
      const client = await connectToDaemon(home)
      if (!client) {
        console.error(
          `pub stop requires a running supervisor daemon. Start one with "2200 daemon start" first.`,
        )
        process.exit(1)
      }
      try {
        await client.call('cli.pub.stop', { name: pubName })
        console.log(`pub "${pubName}" stopped.`)
      } finally {
        await client.close()
      }
    })

  pub
    .command('list')
    .description('list pubs known to the supervisor')
    .action(async () => {
      const home = await resolveHomeFromOpts(program)
      const client = await connectToDaemon(home)
      if (!client) {
        console.error(
          `pub list requires a running supervisor daemon. Start one with "2200 daemon start" first.`,
        )
        process.exit(1)
      }
      try {
        const result = await client.call('cli.pub.list', {})
        if (result.pubs.length === 0) {
          console.log('No pubs created. Run "2200 pub create <name>" to create one.')
          return
        }
        for (const p of result.pubs) {
          const pidStr = p.pid !== null ? String(p.pid) : '-'
          const errStr = p.errored_reason ? ` errored=${p.errored_reason}` : ''
          console.log(
            `${p.name.padEnd(20)} ${p.state.padEnd(10)} port=${String(p.port).padStart(5)}  pid=${pidStr}${errStr}`,
          )
        }
      } finally {
        await client.close()
      }
    })

  pub
    .command('status <name>')
    .description('detailed status for one pub')
    .action(async (pubName: string) => {
      const home = await resolveHomeFromOpts(program)
      const client = await connectToDaemon(home)
      if (!client) {
        console.error(
          `pub status requires a running supervisor daemon. Start one with "2200 daemon start" first.`,
        )
        process.exit(1)
      }
      try {
        const result = await client.call('cli.pub.status', { name: pubName })
        console.log(JSON.stringify(result, null, 2))
      } finally {
        await client.close()
      }
    })

  // ---------------------------------------------------------------------------
  // 2200 chat <pub>  (Epic 3.5)
  // ---------------------------------------------------------------------------

  program
    .command('chat')
    .description(
      'open an interactive chat session in a pub — your stdin posts as the user, incoming messages stream to stdout (Epic 3.5)',
    )
    .argument('[pub]', 'pub name; defaults to the single running pub on the instance')
    .action(async (pubArg: string | undefined) => {
      const home = await resolveHomeFromOpts(program)
      await runChat(home, pubArg)
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
 * Run an interactive chat session in a pub (Epic 3.5).
 *
 * Loads the user's pub credential, opens a `PubClient` against the
 * resolved pub, prints incoming messages to stdout with sender
 * attribution, reads stdin via readline (each line becomes a
 * `pub.send`), exits cleanly on `/quit` / `/exit` / Ctrl+C.
 *
 * The user's own messages echo back via the pub's `room_state`
 * broadcast; we filter them out so the user does not see their
 * typing twice.
 */
async function runChat(home: string, pubArg: string | undefined): Promise<void> {
  // Load user identity + credential.
  const userMdPath = homePaths(home).configUserMd
  const userIdent = await loadUserIdentity(userMdPath).catch((err: unknown) => {
    console.error(`chat: cannot read user identity at ${userMdPath}.`)
    console.error(`Run "2200 user init --display-name <name>" first.`)
    console.error(`(${err instanceof Error ? err.message : String(err)})`)
    process.exit(1)
  })
  const userCred = await readCredentialFile(homePaths(home).configUserPubSecret)
  if (!userCred.agent_id) {
    console.error(
      'chat: user identity exists but has no agent_id (not yet registered against a pub).',
    )
    console.error(
      'Run "2200 pub start <pub>" then re-run "2200 user init --display-name <name>" to register.',
    )
    process.exit(1)
  }

  // Resolve target pub.
  const supervisorState = await loadState(home)
  const allRunning = Object.values(supervisorState.pubs).filter((p) => p.state === 'running')
  let targetPub
  if (pubArg !== undefined) {
    targetPub = supervisorState.pubs[pubArg]
    if (!targetPub) {
      console.error(`chat: no pub named "${pubArg}" on this instance.`)
      process.exit(1)
    }
    if (targetPub.state !== 'running') {
      console.error(`chat: pub "${pubArg}" exists but is not running (state: ${targetPub.state}).`)
      console.error(`Run "2200 pub start ${pubArg}" first.`)
      process.exit(1)
    }
  } else if (allRunning.length === 0) {
    console.error('chat: no running pubs on this instance.')
    console.error('Run "2200 pub create <name>" then "2200 pub start <name>" first.')
    process.exit(1)
  } else if (allRunning.length === 1 && allRunning[0]) {
    targetPub = allRunning[0]
  } else {
    console.error(
      `chat: multiple running pubs (${allRunning.map((p) => p.name).join(', ')}); specify which.`,
    )
    console.error('Run "2200 chat <pub>" with a name.')
    process.exit(1)
  }

  // Open the pub client.
  const baseUrl = `http://127.0.0.1:${String(targetPub.port)}`
  const client = new PubClient({ baseUrl, cred: userCred })
  try {
    await client.connect()
  } catch (err) {
    console.error(`chat: failed to connect to pub "${targetPub.name}" at ${baseUrl}.`)
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }

  const userDisplayName = userIdent.frontmatter.display_name
  const seenIds = new Set<string>()
  const promptStr = `[${userDisplayName}] `

  console.log(`Connected to pub "${targetPub.name}" as ${userDisplayName}.`)
  console.log(
    `Type a message and Enter to post. Use "@<handle>" to direct it. /quit or Ctrl+C to leave.`,
  )
  console.log('')

  // Status bar state. Tracks who's "thinking" (has a pending/running
  // task in their local task store). Updated on a fast spinner tick
  // (visual animation) and a slower thinking-detection tick (filesystem
  // reads).
  const thinkingByAgentId = new Map<string, boolean>()
  // agent_id → local agent_name; populated from the per-pub roster file
  // (Epic 3.6 PR K). Cached so we don't re-read on every status tick.
  let agentIdToLocalName = new Map<string, string>()
  let spinnerPhase = 0
  let statusLineRendered = false

  const refreshAgentIdMap = async (): Promise<void> => {
    try {
      const roster = await readRoster(home, targetPub.name)
      agentIdToLocalName = new Map(roster.agents.map((a) => [a.agent_id, a.agent_name]))
    } catch {
      // Roster missing or malformed... status bar still works for visible
      // membership, just without thinking detection for those agents.
    }
  }
  await refreshAgentIdMap()

  // House-agent display names that openpub-server adds to room state
  // but that aren't real Agents we care about for routing or status
  // (e.g. the chat-room "Bartender" presence). We hide these from the
  // status bar so it shows only the real participants.
  const isRealParticipant = (display_name: string): boolean => display_name !== 'Bartender'

  // Move cursor to the start of the status line and clear both the
  // status line and the prompt line. Cursor ends at start of (was)
  // status line. Idempotent on `statusLineRendered`. Used as the
  // common prelude before redrawing or printing above the bar.
  const clearStatusAndPrompt = (): void => {
    if (!statusLineRendered) {
      process.stdout.write('\r\x1b[2K')
      return
    }
    // We were on prompt line; clear it, move up to status, clear that.
    process.stdout.write('\r\x1b[2K') // clear prompt line
    process.stdout.write('\x1b[1A\r\x1b[2K') // up 1, clear status line
    statusLineRendered = false
  }

  const writeStatusBarAndPrompt = (): void => {
    const room = client.roomState()
    const present = (room?.agents_present ?? []).filter((a) => isRealParticipant(a.display_name))
    const parts = present.map((a) => {
      if (a.agent_id === userCred.agent_id) return `${a.display_name} (you)`
      const thinking = thinkingByAgentId.get(a.agent_id) ?? false
      const frame = SPINNER[spinnerPhase % SPINNER.length] ?? '·'
      return thinking ? `${a.display_name} ${frame}` : a.display_name
    })
    const line =
      parts.length > 0 ? `\x1b[2m─ in room: ${parts.join('  ·  ')}\x1b[0m` : `\x1b[2m─\x1b[0m`

    clearStatusAndPrompt()
    // Cursor now at start of status line, both lines blank.
    process.stdout.write(`${line}\n`)
    process.stdout.write(promptStr + rl.line)
    statusLineRendered = true
  }

  const printIncomingWithStatus = (sender: string, content: string): void => {
    clearStatusAndPrompt()
    // Cursor at start of (was) status line, both lines blank.
    process.stdout.write(`[${sender}] ${content}\n`)
    writeStatusBarAndPrompt()
  }

  // Subscribe to incoming events.
  client.onEvent((event) => {
    if (event.type === 'message') {
      const m = event.data
      if (m.agent_id === userCred.agent_id) return // skip our own
      if (seenIds.has(m.message_id)) return
      seenIds.add(m.message_id)
      printIncomingWithStatus(m.display_name, m.content)
    } else if (event.type === 'conversation_event') {
      const m = event.data
      if (m.from.agent_id === userCred.agent_id) return
      if (seenIds.has(m.message_id)) return
      seenIds.add(m.message_id)
      const cached = client.roomState()?.conversation.find((msg) => msg.message_id === m.message_id)
      printIncomingWithStatus(m.from.display_name, cached?.content ?? m.preview)
    } else if (event.type === 'pub_reaction') {
      const r = event.data
      if (r.agent_id === userCred.agent_id) return
      printIncomingWithStatus(r.display_name, `(reacted ${r.emoji})`)
    } else if (event.type === 'error') {
      printIncomingWithStatus('!error', event.data.message)
    } else if (event.type === 'room_state') {
      // Membership changed; rerender status bar so new joiners appear.
      writeStatusBarAndPrompt()
    }
  })

  // Read stdin.
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: promptStr,
  })

  // Spinner tick: just animate the spinner phase. Cheap. Only redraws
  // when at least one agent is thinking, so an idle room is silent.
  const spinnerTimer = setInterval(() => {
    spinnerPhase += 1
    if ([...thinkingByAgentId.values()].some(Boolean)) {
      writeStatusBarAndPrompt()
    }
  }, 150)
  spinnerTimer.unref()

  // Thinking detection tick: read each in-room agent's task store and
  // determine whether they're processing. Polling cadence has to be
  // tight enough to catch fast tasks (a single-iteration "ping" reply
  // can finish in <500ms). 200ms is the sweet spot... noisy enough to
  // catch sub-second work, cheap enough to be invisible (a few small
  // file reads per tick per agent).
  const thinkingTimer = setInterval(() => {
    void (async () => {
      const room = client.roomState()
      if (!room) return
      let changed = false
      for (const a of room.agents_present) {
        if (a.agent_id === userCred.agent_id) continue
        const localName = agentIdToLocalName.get(a.agent_id)
        if (!localName) continue
        const wasThinking = thinkingByAgentId.get(a.agent_id) ?? false
        const isThinking = await detectAgentThinking(home, localName)
        if (wasThinking !== isThinking) {
          thinkingByAgentId.set(a.agent_id, isThinking)
          changed = true
        }
      }
      if (changed) writeStatusBarAndPrompt()
    })()
  }, 200)
  thinkingTimer.unref()

  const cleanup = async (): Promise<void> => {
    clearInterval(spinnerTimer)
    clearInterval(thinkingTimer)
    rl.close()
    try {
      await client.close()
    } catch {
      // best-effort
    }
  }

  // Initial render so the status line is on screen before the first
  // prompt appears.
  writeStatusBarAndPrompt()

  rl.on('line', (line) => {
    void (async () => {
      const trimmed = line.trim()
      if (trimmed === '/quit' || trimmed === '/exit') {
        console.log('leaving the pub.')
        await cleanup()
        process.exit(0)
        return
      }
      if (trimmed.length === 0) {
        writeStatusBarAndPrompt()
        return
      }
      try {
        await client.send({ content: trimmed })
      } catch (err) {
        console.error(`send failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      writeStatusBarAndPrompt()
    })()
  })
  rl.on('close', () => {
    void cleanup().then(() => process.exit(0))
  })

  // Handle SIGINT (Ctrl+C) — readline catches it but we want a graceful close.
  process.on('SIGINT', () => {
    console.log('\nleaving the pub.')
    void cleanup().then(() => process.exit(0))
  })
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * Returns true if the named local Agent has any task in a non-terminal
 * state (`pending` or `running`). Reads YAML frontmatter from up to the
 * 5 most recent task files in the agent's task store; that's enough to
 * cover the realistic in-flight set without a full directory scan.
 *
 * Returns false on any error (missing dir, parse failure)... a missing
 * agent should render as not-thinking, not crash the chat.
 */
async function detectAgentThinking(home: string, agentName: string): Promise<boolean> {
  const tasksDir = join(home, 'agents', agentName, 'tasks')
  let files: string[]
  try {
    files = await readdir(tasksDir)
  } catch {
    return false
  }
  const taskFiles = files
    .filter((f) => f.endsWith('.md'))
    .sort()
    .reverse()
    .slice(0, 5)
  for (const f of taskFiles) {
    try {
      const content = await readFile(join(tasksDir, f), 'utf8')
      const m = /^state:\s*(\S+)/m.exec(content)
      if (m && (m[1] === 'pending' || m[1] === 'running')) return true
    } catch {
      // ignore parse / read failures for individual files
    }
  }
  return false
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
