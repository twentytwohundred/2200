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
 * See https://github.com/twentytwohundred/wiki/blob/main/epics/02-agent-runtime-minimum.md
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
import type {
  CliScheduleAddParams,
  StateSnapshotResult,
} from '../runtime/control-plane/protocol.js'
import { parseDurationSeconds } from '../runtime/util/duration.js'
import { BrainStore } from '../runtime/brain/store.js'
import { BrainIndex } from '../runtime/brain/index-db.js'
import { importFromDir } from '../runtime/brain/import.js'
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

function truncateUri(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 3)}...`
}

function firstLine(text: string): string {
  const trimmed = text.trim()
  const idx = trimmed.indexOf('\n')
  return idx === -1 ? trimmed.slice(0, 80) : trimmed.slice(0, Math.min(idx, 80))
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
    .description(
      'register a new Agent with the supervisor (auto-provisions a SCUT identity by default)',
    )
    .requiredOption('--identity <path>', 'path to the Agent Identity markdown file')
    .option(
      '--pub <name>',
      'pub to register the Agent against (when the Identity has a pub: block; required only with multiple pubs)',
    )
    .option(
      '--skip-provision',
      'skip the SCUT identity provisioning step. The Agent is created without an on-chain identity; provision later with `2200 agent identity provision`',
    )
    .action(
      async (name: string, opts: { identity: string; pub?: string; skipProvision?: boolean }) => {
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

        // Auto-provision the SCUT identity unless --skip-provision was passed.
        if (opts.skipProvision) {
          console.log(
            `Skipping SCUT identity provisioning (--skip-provision). Run "2200 agent identity provision ${name}" later.`,
          )
          console.log(`Run "2200 agent start ${name}" to bring it up.`)
          return
        }
        try {
          const { runIdentityProvisionFromConfig } =
            await import('../runtime/identity/provision-runner.js')
          const result = await runIdentityProvisionFromConfig({ home, agentName: name })
          console.log(`SCUT identity provisioned: ${result.uri}`)
        } catch (err) {
          console.error(
            `Identity provisioning failed (the Agent is created but has no SCUT identity): ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
          console.error(
            `Recover with: 2200 agent identity retry ${name} (after fixing the underlying cause).`,
          )
        }
        console.log(`Run "2200 agent start ${name}" to bring it up.`)
      },
    )

  agent
    .command('migrate')
    .description(
      'migrate an Agent into 2200 from a handoff document (Epic 5 Phase A; see wiki/epics/05-migration.md)',
    )
    .requiredOption('--from-handoff <path>', 'path to the handoff markdown document')
    .option(
      '--provision-identity',
      'after registration, run the SCUT identity provisioning pipeline (subject to OpenSCUT per-displayName-per-day rate limit)',
    )
    .option(
      '--force',
      'replace any existing Agent of the same name (destructive: stops the process if running and removes the per-Agent state)',
    )
    .option(
      '--validate',
      'parse + validate the handoff document and print a preview without writing anything',
    )
    .action(
      async (opts: {
        fromHandoff: string
        provisionIdentity?: boolean
        force?: boolean
        validate?: boolean
      }) => {
        const { parseHandoffFile } = await import('../runtime/migration/parser.js')
        const handoff = await parseHandoffFile(opts.fromHandoff)
        const fm = handoff.frontmatter

        if (opts.validate === true) {
          console.log(`handoff document validated: ${handoff.source_path ?? '(in memory)'}`)
          console.log(`  agent_name:        ${fm.agent_name}`)
          console.log(`  agent_type:        ${fm.agent_type}`)
          console.log(`  display_name:      ${fm.identity.display_name}`)
          console.log(
            `  notification:      tiers_allowed=[${fm.identity.notification_policy.tiers_allowed.join(', ')}]`,
          )
          console.log(
            `  brain.source_dir:  ${fm.brain.source_dir ?? '(none — inline notes only or empty brain)'}`,
          )
          console.log(`  brain.inline:      ${String(fm.brain.inline_notes?.length ?? 0)} note(s)`)
          console.log(`  budget.daily_usd:  ${String(fm.budget.daily_cap_usd)}`)
          console.log(`  body bytes:        ${String(Buffer.byteLength(handoff.body, 'utf8'))}`)
          return
        }

        const home = await resolveHomeFromOpts(program)

        // The orchestrator opens its own Supervisor (in-process) and
        // talks to disk directly; running it concurrently with a
        // daemon would risk state-file races. Refuse if a daemon is
        // up and tell the operator how to recover.
        const probe = await connectToDaemon(home)
        if (probe) {
          await probe.close()
          console.error(
            `agent migrate cannot run while the supervisor daemon is up (state-file race risk). Stop with "2200 daemon stop" first, run the migration, then restart the daemon.`,
          )
          process.exit(1)
        }

        const { migrateFromHandoff } = await import('../runtime/migration/orchestrator.js')
        const supervisor = await Supervisor.create({ home })
        try {
          const result = await migrateFromHandoff({
            handoff,
            home,
            supervisor,
            today: new Date(),
            ...(opts.provisionIdentity === true ? { provisionIdentity: true } : {}),
            ...(opts.force === true ? { force: true } : {}),
          })
          console.log(`Agent "${result.agent_name}" migrated.`)
          console.log(`  identity:           ${result.identity_path}`)
          console.log(`  brain notes:        ${String(result.brain_imported_count)} imported`)
          if (result.brain_skipped_count > 0) {
            console.log(`  brain notes:        ${String(result.brain_skipped_count)} skipped`)
          }
          console.log(`  continuity note:    ${result.continuity_note_slug}`)
          if (result.scut_uri !== null) {
            console.log(`  scut identity:      ${result.scut_uri}`)
          } else if (opts.provisionIdentity === true) {
            console.log(
              `  scut identity:      provisioning failed (recover with "2200 agent identity retry ${result.agent_name}")`,
            )
          } else {
            console.log(
              `  scut identity:      skipped (run "2200 agent identity provision ${result.agent_name}" to mint)`,
            )
          }
          console.log(
            `Run "2200 daemon start" then "2200 agent start ${result.agent_name}" to bring it up.`,
          )
        } finally {
          await supervisor.shutdown()
        }
      },
    )

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
  // 2200 agent budget <subcommand>
  // ---------------------------------------------------------------------------

  const agentBudget = agent
    .command('budget')
    .description('per-Agent daily cost cap controls (override, status, clear)')

  agentBudget
    .command('override <name>')
    .description("lift today's cost-cap block for an Agent")
    .option(
      '--for-today',
      'until 00:00 UTC (default behavior; equivalent to --for-hours <hours-until-midnight>)',
    )
    .option('--for-hours <n>', 'override for the next N hours (default: until 00:00 UTC)', (v) =>
      parseFloat(v),
    )
    .option('--reason <text>', 'free-form note for the audit trail')
    .option('--clear', 'remove the current override (re-block if cap is still hit)')
    .action(
      async (
        name: string,
        opts: { forToday?: boolean; forHours?: number; reason?: string; clear?: boolean },
      ) => {
        const home = await resolveHomeFromOpts(program)
        const { writeBudgetOverride, clearBudgetOverride } =
          await import('../runtime/agent/budget-tracker.js')
        if (opts.clear) {
          await clearBudgetOverride(home, name)
          console.log(`Override cleared for "${name}".`)
          return
        }
        const now = new Date()
        let until: Date
        if (typeof opts.forHours === 'number' && Number.isFinite(opts.forHours)) {
          until = new Date(now.getTime() + opts.forHours * 60 * 60 * 1000)
        } else {
          // --for-today (default): until next 00:00 UTC.
          until = new Date(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
          )
        }
        const reason =
          opts.reason ?? `user override at ${now.toISOString()} until ${until.toISOString()}`
        const path = await writeBudgetOverride(home, name, {
          until: until.toISOString(),
          reason,
          setAt: now.toISOString(),
        })
        console.log(`Override set for "${name}" until ${until.toISOString()}.`)
        console.log(`Wrote: ${path}`)
      },
    )

  agentBudget
    .command('status <name>')
    .description("show today's cumulative spend, cap, and any active override")
    .action(async (name: string) => {
      const home = await resolveHomeFromOpts(program)
      const { readBudgetOverrideSync } = await import('../runtime/agent/budget-tracker.js')
      const day = new Date().toISOString().slice(0, 10)
      const statePath = join(home, 'state', 'budget', name, `${day}.json`)
      interface BudgetStateOnDisk {
        cumulative_usd: number
        cap_usd: number
        blocked: boolean
      }
      let state: BudgetStateOnDisk | null = null
      try {
        state = JSON.parse(await readFile(statePath, 'utf8')) as BudgetStateOnDisk
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
      if (state === null) {
        console.log(`Agent "${name}": no spend recorded today.`)
      } else {
        const pct = state.cap_usd > 0 ? (state.cumulative_usd / state.cap_usd) * 100 : 0
        console.log(`Agent "${name}":`)
        console.log(
          `  spend today:  $${state.cumulative_usd.toFixed(2)} of $${state.cap_usd.toFixed(2)} (${pct.toFixed(0)}%)`,
        )
        console.log(`  blocked:      ${state.blocked ? 'yes' : 'no'}`)
      }
      const override = readBudgetOverrideSync(home, name)
      if (override) {
        const expired = Date.parse(override.until) <= Date.now()
        console.log(
          `  override:     ${expired ? 'expired' : 'active'}, until ${override.until}${
            override.reason ? ` (${override.reason})` : ''
          }`,
        )
      } else {
        console.log(`  override:     (none)`)
      }
    })

  // ---------------------------------------------------------------------------
  // 2200 agent identity <subcommand>
  // ---------------------------------------------------------------------------

  const agentIdentity = agent
    .command('identity')
    .description('manage Agent SCUT identities (provision, status, show, retry, wallet-status)')

  agentIdentity
    .command('provision <name>')
    .description("provision (or resume provisioning) an Agent's SCUT identity on Base")
    .action(async (name: string) => {
      const home = await resolveHomeFromOpts(program)
      const { runIdentityProvisionFromConfig } =
        await import('../runtime/identity/provision-runner.js')
      try {
        const result = await runIdentityProvisionFromConfig({ home, agentName: name })
        console.log(`Agent "${name}" provisioned.`)
        console.log(`  scut uri:   ${result.uri}`)
        console.log(`  token id:   ${result.tokenId}`)
        console.log(`  mint tx:    ${result.mintTx}`)
        console.log(`  update tx:  ${result.updateTx}`)
      } catch (err) {
        console.error(`Provisioning failed: ${err instanceof Error ? err.message : String(err)}`)
        console.error(`Inspect with: 2200 agent identity status ${name}`)
        process.exit(1)
      }
    })

  agentIdentity
    .command('status <name>')
    .description('show the current provisioning state for an Agent')
    .action(async (name: string) => {
      const home = await resolveHomeFromOpts(program)
      const { agentIdentityPaths } = await import('../runtime/storage/layout.js')
      const path = agentIdentityPaths(home, name).provisionState
      try {
        const raw = await readFile(path, 'utf8')
        interface ProvisionStateRead {
          state?: string
          updated_at?: string
          token_id?: string
          mint_tx_hash?: string
          update_tx_hash?: string
          error?: { at_state?: string; class?: string; message?: string }
        }
        const state = JSON.parse(raw) as ProvisionStateRead
        console.log(`Agent "${name}" identity:`)
        console.log(`  state:        ${state.state ?? '(unknown)'}`)
        console.log(`  updated_at:   ${state.updated_at ?? '(unknown)'}`)
        if (state.token_id) console.log(`  token_id:     ${state.token_id}`)
        if (state.mint_tx_hash) console.log(`  mint_tx:      ${state.mint_tx_hash}`)
        if (state.update_tx_hash) console.log(`  update_tx:    ${state.update_tx_hash}`)
        if (state.error) {
          console.log(`  error:`)
          console.log(`    at_state:   ${state.error.at_state ?? '(unknown)'}`)
          console.log(`    class:      ${state.error.class ?? '(unknown)'}`)
          console.log(`    message:    ${state.error.message ?? '(unknown)'}`)
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          console.log(`Agent "${name}" has not been provisioned.`)
          process.exit(1)
        }
        throw err
      }
    })

  agentIdentity
    .command('show <name>')
    .description("print an Agent's scut block from the Identity file")
    .action(async (name: string) => {
      const home = await resolveHomeFromOpts(program)
      const { loadIdentity } = await import('../runtime/identity/loader.js')
      const { agentPaths } = await import('../runtime/storage/layout.js')
      const id = await loadIdentity(agentPaths(home, name).identity)
      if (!id.frontmatter.scut) {
        console.log(`Agent "${name}" has no scut block (not yet provisioned).`)
        process.exit(1)
      }
      const s = id.frontmatter.scut
      console.log(`Agent "${name}" SCUT identity:`)
      console.log(`  uri:                 ${s.uri}`)
      console.log(`  chain id:            ${String(s.chain_id)}`)
      console.log(`  contract:            ${s.contract}`)
      console.log(`  token id:            ${s.token_id}`)
      console.log(`  identity_doc_uri:    ${truncateUri(s.identity_doc_uri, 60)}`)
      console.log(`  ed25519 (b64):       ${s.public_keys.ed25519}`)
      console.log(`  x25519 (b64):        ${s.public_keys.x25519}`)
      console.log(`  registered_at:       ${s.registered_at}`)
      console.log(`  mint tx:             ${s.mint_tx}`)
      console.log(`  update tx:           ${s.update_tx}`)
    })

  agentIdentity
    .command('retry <name>')
    .description('clear an errored provisioning state and re-run from the last good checkpoint')
    .action(async (name: string) => {
      const home = await resolveHomeFromOpts(program)
      const { agentIdentityPaths } = await import('../runtime/storage/layout.js')
      const { atomicWriteJson } = await import('../runtime/util/atomic-write.js')
      const path = agentIdentityPaths(home, name).provisionState
      let state: Record<string, unknown>
      try {
        state = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          console.error(`Agent "${name}" has no provision state to retry.`)
          process.exit(1)
        }
        throw err
      }
      if (state['state'] !== 'errored') {
        console.error(
          `Agent "${name}" is in state "${String(state['state'])}", not "errored". Use \`2200 agent identity provision\` to advance from a non-errored state.`,
        )
        process.exit(1)
      }
      const errBlock = state['error'] as Record<string, unknown> | undefined
      const recoverFrom = (errBlock?.['at_state'] as string | undefined) ?? 'pending'
      delete state['error']
      state['state'] = recoverFrom
      state['updated_at'] = new Date().toISOString()
      await atomicWriteJson(path, state)
      console.log(`Cleared error; re-running provisioning from state "${recoverFrom}".`)
      const { runIdentityProvisionFromConfig } =
        await import('../runtime/identity/provision-runner.js')
      try {
        const result = await runIdentityProvisionFromConfig({ home, agentName: name })
        console.log(`Agent "${name}" provisioned.`)
        console.log(`  scut uri:   ${result.uri}`)
      } catch (err) {
        console.error(`Retry failed: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }
    })

  agentIdentity
    .command('wallet-status')
    .description("show OpenSCUT's register-service wallet runway (GET /scut/v1/health)")
    .option('--register-url <url>', 'override the OpenSCUT register URL', String)
    .action(async (opts: { registerUrl?: string }) => {
      const { createRegisterClient, DEFAULT_REGISTER_BASE_URL } =
        await import('../runtime/identity/register-client.js')
      const baseUrl =
        opts.registerUrl ?? process.env['OPENSCUT_REGISTER_URL'] ?? DEFAULT_REGISTER_BASE_URL
      const client = createRegisterClient({ baseUrl })
      try {
        const h = await client.health()
        console.log(`OpenSCUT register service: ${h.status} (v${h.version})`)
        console.log(`  url:                ${baseUrl}`)
        console.log(`  wallet:             ${h.wallet.address}`)
        console.log(`  balance:            ${h.wallet.balanceEth} ETH (${h.wallet.balanceWei} wei)`)
        console.log(`  registrations:      ${String(h.registrationsCount)} so far`)
        console.log(
          `  runway:             ~${String(h.runway.registrationsAtConservativeGas)} more (at ${h.runway.gasPerRegistrationEstimate} gas / registration)`,
        )
        if (h.status !== 'ok') {
          console.log(`  error:              ${h.error ?? '(unknown)'}`)
          if (h.detail) console.log(`  detail:             ${h.detail}`)
          process.exit(1)
        }
      } catch (err) {
        console.error(
          `register-service health check failed: ${err instanceof Error ? err.message : String(err)}`,
        )
        process.exit(1)
      }
    })

  // ---------------------------------------------------------------------------
  // 2200 usage
  // ---------------------------------------------------------------------------

  program
    .command('usage')
    .description('show LLM token / dollar usage by Agent, model, provider, day, or task')
    .option('--agent <name>', 'filter to one Agent')
    .option('--day', 'today only (default)')
    .option('--week', 'last 7 calendar days (UTC)')
    .option('--month', 'last 30 calendar days (UTC)')
    .option('--since <YYYY-MM-DD>', 'custom start date (UTC)')
    .option('--by <grouping>', 'agent | model | provider | day | task (default: agent)')
    .option('--json', 'machine-readable output')
    .action(
      async (opts: {
        agent?: string
        day?: boolean
        week?: boolean
        month?: boolean
        since?: string
        by?: string
        json?: boolean
      }) => {
        const home = await resolveHomeFromOpts(program)
        const { readTelemetry, aggregate, rangeForPreset, rangeSince } =
          await import('../runtime/telemetry/reader.js')
        const now = new Date()
        let range
        if (opts.since) {
          range = rangeSince(opts.since, now)
        } else if (opts.month) {
          range = rangeForPreset('month', now)
        } else if (opts.week) {
          range = rangeForPreset('week', now)
        } else {
          range = rangeForPreset('day', now)
        }

        const records = await readTelemetry(home, {
          range,
          ...(opts.agent !== undefined ? { agentName: opts.agent } : {}),
        })
        const agg = aggregate(records)

        if (opts.json) {
          console.log(JSON.stringify({ range, by: opts.by ?? 'agent', aggregations: agg }, null, 2))
          return
        }

        const grouping = (opts.by ?? 'agent').toLowerCase()
        const { printByAgent, printSimpleBuckets } = await import('./usage-formatter.js')
        if (grouping === 'agent') {
          await printByAgent(home, agg.byAgent, agg.total, range, now)
        } else if (grouping === 'provider') {
          printSimpleBuckets('Provider', agg.byProvider, agg.total, range)
        } else if (grouping === 'model') {
          printSimpleBuckets('Provider/Model', agg.byModel, agg.total, range)
        } else if (grouping === 'day') {
          printSimpleBuckets('Day', agg.byDay, agg.total, range)
        } else if (grouping === 'task') {
          printSimpleBuckets('Task', agg.byTask, agg.total, range)
        } else {
          console.error(
            `unknown --by grouping: "${grouping}" (expected: agent, model, provider, day, task)`,
          )
          process.exit(1)
        }

        if (agg.total.cost_unknown_count > 0) {
          console.log('')
          console.log(
            `Note: ${String(agg.total.cost_unknown_count)} record(s) had unknown pricing. Add the model to config/pricing.json (or default-pricing.json) to track those calls in dollar terms.`,
          )
        }
      },
    )

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
  // 2200 brain <subcommand>  (Epic 8 Phase A PR D)
  // ---------------------------------------------------------------------------

  const brain = program
    .command('brain')
    .description("manage an Agent's brain (list, show, rebuild, import)")

  brain
    .command('list <agent>')
    .description("list an Agent's brain notes (sorted by updated, descending)")
    .option('--type <type>', 'filter by note type (feedback, project, ...)')
    .option('--tag <tag>', 'filter by tag')
    .option('--limit <n>', 'cap on results (default 50)', (v) => parseInt(v, 10))
    .action(async (agentName: string, opts: { type?: string; tag?: string; limit?: number }) => {
      const home = await resolveHomeFromOpts(program)
      const store = new BrainStore(home, agentName)
      const notes = await store.list({
        ...(opts.type !== undefined ? { type: opts.type } : {}),
        ...(opts.tag !== undefined ? { tag: opts.tag } : {}),
        limit: opts.limit ?? 50,
      })
      if (notes.length === 0) {
        console.log(`No brain notes for "${agentName}".`)
        return
      }
      for (const n of notes) {
        const tagsStr = n.frontmatter.tags.length > 0 ? ` [${n.frontmatter.tags.join(', ')}]` : ''
        console.log(
          `${n.slug.padEnd(40)}  ${n.frontmatter.type.padEnd(10)}  ${n.frontmatter.updated}  ${n.frontmatter.title}${tagsStr}`,
        )
      }
    })

  brain
    .command('show <agent> <slug>')
    .description('print the contents of a brain note')
    .action(async (agentName: string, slug: string) => {
      const home = await resolveHomeFromOpts(program)
      const store = new BrainStore(home, agentName)
      const note = await store.read(slug)
      console.log(`# ${note.frontmatter.title}`)
      console.log(`slug:    ${note.slug}`)
      console.log(`type:    ${note.frontmatter.type}`)
      if (note.frontmatter.tags.length > 0) {
        console.log(`tags:    ${note.frontmatter.tags.join(', ')}`)
      }
      console.log(`created: ${note.frontmatter.created}`)
      console.log(`updated: ${note.frontmatter.updated}`)
      if (note.frontmatter.links.length > 0) {
        console.log(`links:   ${note.frontmatter.links.join(', ')}`)
      }
      console.log(`path:    ${note.path}`)
      console.log()
      console.log(note.body)
    })

  brain
    .command('rebuild <agent>')
    .description("rebuild the FTS5 index from disk for an Agent's brain")
    .action(async (agentName: string) => {
      const home = await resolveHomeFromOpts(program)
      const store = new BrainStore(home, agentName)
      const notes = await store.list({ limit: 100_000 })
      const index = BrainIndex.open(home, agentName)
      try {
        index.rebuildFrom(notes)
      } finally {
        index.close()
      }
      console.log(`brain index rebuilt for "${agentName}": ${String(notes.length)} note(s).`)
    })

  brain
    .command('import <agent> <source-dir>')
    .description("bulk-import a directory of markdown files into an Agent's brain")
    .option('--dry-run', 'parse + map but do not write')
    .action(async (agentName: string, sourceDir: string, opts: { dryRun?: boolean }) => {
      const home = await resolveHomeFromOpts(program)
      const result = await importFromDir({
        home,
        agentName,
        sourceDir,
        dryRun: opts.dryRun ?? false,
      })
      const verb = opts.dryRun ? 'would import' : 'imported'
      console.log(`${verb} ${String(result.imported.length)} note(s) into "${agentName}".`)
      for (const e of result.imported) {
        console.log(`  ${e.slug.padEnd(40)}  ${e.type.padEnd(10)}  ${e.title}`)
      }
      if (result.skipped.length > 0) {
        console.log(`\nskipped ${String(result.skipped.length)} file(s):`)
        for (const s of result.skipped) {
          console.log(`  ${s.sourcePath}: ${s.reason}`)
        }
      }
    })

  // ---------------------------------------------------------------------------
  // 2200 schedule <subcommand>  (Epic 6 PR C)
  // ---------------------------------------------------------------------------

  const schedule = program
    .command('schedule')
    .description(
      'manage recurring/timed Agent tasks (add, list, remove, enable, disable, run-once)',
    )

  schedule
    .command('add <agent> <prompt>')
    .description('add a recurring task that fires for <agent>')
    .option('--every <duration>', 'fire every N seconds/minutes/hours/days, e.g. "5m", "1h"')
    .option('--cron <expr>', 'standard 5-field cron expression')
    .option('--tz <zone>', 'IANA timezone for --cron (default: UTC)')
    .option('--description <text>', 'short label shown in `schedule list`')
    .action(
      async (
        agentName: string,
        prompt: string,
        opts: { every?: string; cron?: string; tz?: string; description?: string },
      ) => {
        const home = await resolveHomeFromOpts(program)
        const client = await connectToDaemon(home)
        if (!client) {
          console.error(
            `schedule add requires a running supervisor daemon. Start one with "2200 daemon start" first.`,
          )
          process.exit(1)
        }
        if ((opts.every && opts.cron) || (!opts.every && !opts.cron)) {
          console.error(`schedule add requires exactly one of --every <duration> or --cron <expr>.`)
          process.exit(1)
        }
        let timing: CliScheduleAddParams['timing']
        if (opts.cron) {
          timing = {
            kind: 'cron',
            expression: opts.cron,
            timezone: opts.tz ?? 'UTC',
          }
        } else {
          let seconds: number
          try {
            seconds = parseDurationSeconds(opts.every ?? '')
          } catch (err) {
            console.error(err instanceof Error ? err.message : String(err))
            process.exit(1)
          }
          timing = { kind: 'interval', interval_seconds: seconds }
        }
        const params: CliScheduleAddParams = {
          agent: agentName,
          prompt,
          timing,
        }
        if (opts.description !== undefined) params.description = opts.description
        try {
          const result = await client.call('cli.schedule.add', params)
          console.log(`schedule ${result.id} added for "${agentName}".`)
          if (result.next_fire_at) {
            console.log(`  next fire: ${result.next_fire_at}`)
          }
        } finally {
          await client.close()
        }
      },
    )

  schedule
    .command('list')
    .description('list schedules across all Agents (or one with --agent)')
    .option('--agent <name>', 'restrict to one Agent')
    .action(async (opts: { agent?: string }) => {
      const home = await resolveHomeFromOpts(program)
      const client = await connectToDaemon(home)
      if (!client) {
        console.error(
          `schedule list requires a running supervisor daemon. Start one with "2200 daemon start" first.`,
        )
        process.exit(1)
      }
      const params: Parameters<typeof client.call<'cli.schedule.list'>>[1] = {}
      if (opts.agent !== undefined) params.agent = opts.agent
      try {
        const result = await client.call('cli.schedule.list', params)
        if (result.entries.length === 0) {
          console.log(opts.agent ? `No schedules for "${opts.agent}".` : `No schedules.`)
          return
        }
        for (const e of result.entries) {
          const onoff = e.enabled ? 'on ' : 'off'
          const cadence =
            e.timing.kind === 'interval'
              ? `every ${String(e.timing.interval_seconds)}s`
              : `cron "${e.timing.expression}" (${e.timing.timezone})`
          const desc = e.description ? ` ${e.description}` : ''
          const next = e.next_fire_at ?? '<none>'
          console.log(`${e.id}  ${onoff}  agent=${e.agent}  ${cadence}  next=${next}${desc}`)
        }
      } finally {
        await client.close()
      }
    })

  schedule
    .command('remove <agent> <id>')
    .description('delete a schedule')
    .action(async (agentName: string, scheduleId: string) => {
      const home = await resolveHomeFromOpts(program)
      const client = await connectToDaemon(home)
      if (!client) {
        console.error(
          `schedule remove requires a running supervisor daemon. Start one with "2200 daemon start" first.`,
        )
        process.exit(1)
      }
      try {
        await client.call('cli.schedule.remove', { agent: agentName, id: scheduleId })
        console.log(`schedule ${scheduleId} removed.`)
      } finally {
        await client.close()
      }
    })

  schedule
    .command('enable <agent> <id>')
    .description('enable a previously disabled schedule')
    .action(async (agentName: string, scheduleId: string) => {
      const home = await resolveHomeFromOpts(program)
      const client = await connectToDaemon(home)
      if (!client) {
        console.error(
          `schedule enable requires a running supervisor daemon. Start one with "2200 daemon start" first.`,
        )
        process.exit(1)
      }
      try {
        const r = await client.call('cli.schedule.set-enabled', {
          agent: agentName,
          id: scheduleId,
          enabled: true,
        })
        console.log(`schedule ${scheduleId} enabled. next fire: ${r.next_fire_at ?? '<none>'}`)
      } finally {
        await client.close()
      }
    })

  schedule
    .command('disable <agent> <id>')
    .description('disable a schedule without deleting it')
    .action(async (agentName: string, scheduleId: string) => {
      const home = await resolveHomeFromOpts(program)
      const client = await connectToDaemon(home)
      if (!client) {
        console.error(
          `schedule disable requires a running supervisor daemon. Start one with "2200 daemon start" first.`,
        )
        process.exit(1)
      }
      try {
        await client.call('cli.schedule.set-enabled', {
          agent: agentName,
          id: scheduleId,
          enabled: false,
        })
        console.log(`schedule ${scheduleId} disabled.`)
      } finally {
        await client.close()
      }
    })

  schedule
    .command('run-once <agent> <id>')
    .description('manually fire a schedule right now (does not affect next_fire_at)')
    .action(async (agentName: string, scheduleId: string) => {
      const home = await resolveHomeFromOpts(program)
      const client = await connectToDaemon(home)
      if (!client) {
        console.error(
          `schedule run-once requires a running supervisor daemon. Start one with "2200 daemon start" first.`,
        )
        process.exit(1)
      }
      try {
        const r = await client.call('cli.schedule.run-once', {
          agent: agentName,
          id: scheduleId,
        })
        console.log(`schedule ${scheduleId} fired manually; task ${r.task_id} enqueued.`)
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
    .description('manage notifications from Agents (list, show, respond, dismiss, follow)')

  notification
    .command('list')
    .description('list notifications (default: pending only)')
    .option('--all', 'include answered and dismissed (default: pending only)')
    .option('--asks', 'only notifications requiring a response')
    .option('--tier <tier>', 'filter by tier: passive | normal | important | critical')
    .option('--agent <name>', 'filter to one Agent')
    .option('--json', 'machine-readable output')
    .action(
      async (opts: {
        all?: boolean
        asks?: boolean
        tier?: string
        agent?: string
        json?: boolean
      }) => {
        const home = await resolveHomeFromOpts(program)
        const { listNotifications } = await import('../runtime/notifications/reader.js')
        const filters: Parameters<typeof listNotifications>[1] = {}
        if (!opts.all) filters.state = 'pending'
        if (opts.asks) filters.asksOnly = true
        if (opts.tier !== undefined) {
          filters.tier = opts.tier as 'passive' | 'normal' | 'important' | 'critical'
        }
        if (opts.agent !== undefined) filters.agent = opts.agent
        const list = await listNotifications(home, filters)
        if (opts.json) {
          console.log(JSON.stringify(list, null, 2))
          return
        }
        if (list.length === 0) {
          console.log('No notifications match.')
          return
        }
        for (const r of list) {
          const fm = r.frontmatter
          const ask = fm.requires_response ? '?' : ' '
          const stateMarker = fm.state === 'pending' ? '·' : fm.state === 'answered' ? '✓' : '✗'
          console.log(
            `${stateMarker} ${ask} [${fm.tier.padEnd(9)}] ${fm.agent.padEnd(8)} ${fm.kind.padEnd(28)} ${fm.id}`,
          )
        }
      },
    )

  notification
    .command('show <id>')
    .description('show a notification with body and emitter-specific fields')
    .action(async (id: string) => {
      const home = await resolveHomeFromOpts(program)
      const { readNotification } = await import('../runtime/notifications/reader.js')
      try {
        const r = await readNotification(home, id)
        const fm = r.frontmatter
        console.log(`Notification ${fm.id}`)
        console.log(`  ts:                  ${fm.ts}`)
        console.log(`  tier:                ${fm.tier}`)
        console.log(`  agent:               ${fm.agent}`)
        console.log(`  kind:                ${fm.kind}`)
        console.log(`  state:               ${fm.state}`)
        if (fm.requires_response) console.log(`  requires_response:   yes`)
        if (fm.response !== undefined) console.log(`  response:            ${fm.response}`)
        if (fm.resolved_at !== undefined) console.log(`  resolved_at:         ${fm.resolved_at}`)
        const extraKeys = Object.keys(r.extras)
        if (extraKeys.length > 0) {
          console.log(`  extras:`)
          for (const k of extraKeys) {
            console.log(`    ${k}: ${String(r.extras[k])}`)
          }
        }
        if (r.body.trim().length > 0) {
          console.log('')
          console.log(r.body.trim())
        }
      } catch (err) {
        console.error(
          `Notification "${id}" not found or unreadable: ${err instanceof Error ? err.message : String(err)}`,
        )
        process.exit(1)
      }
    })

  notification
    .command('respond <id> <response>')
    .description('answer a pending notification (unblocks the Agent if it was an Ask)')
    .action(async (id: string, response: string) => {
      const home = await resolveHomeFromOpts(program)
      const { markAnswered } = await import('../runtime/notifications/reader.js')
      try {
        await markAnswered(home, id, response)
        console.log(`Notification ${id} answered.`)
      } catch (err) {
        console.error(`Cannot answer: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }
    })

  notification
    .command('dismiss <id>')
    .description('dismiss a pending notification without answering')
    .action(async (id: string) => {
      const home = await resolveHomeFromOpts(program)
      const { markDismissed } = await import('../runtime/notifications/reader.js')
      try {
        await markDismissed(home, id)
        console.log(`Notification ${id} dismissed.`)
      } catch (err) {
        console.error(`Cannot dismiss: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }
    })

  notification
    .command('follow')
    .description('tail-follow notifications as they arrive (Ctrl-C to stop)')
    .option('--asks', 'only notifications requiring a response')
    .option('--tier <tier>', 'filter by tier')
    .option('--agent <name>', 'filter to one Agent')
    .action(async (opts: { asks?: boolean; tier?: string; agent?: string }) => {
      const home = await resolveHomeFromOpts(program)
      const { listNotifications } = await import('../runtime/notifications/reader.js')
      const { homePaths } = await import('../runtime/storage/layout.js')
      const { watch } = await import('node:fs/promises')
      const seen = new Set<string>()
      // Print existing pending entries first (so the user has context).
      const filters: Parameters<typeof listNotifications>[1] = { state: 'pending' }
      if (opts.asks) filters.asksOnly = true
      if (opts.tier !== undefined) {
        filters.tier = opts.tier as 'passive' | 'normal' | 'important' | 'critical'
      }
      if (opts.agent !== undefined) filters.agent = opts.agent
      const initial = await listNotifications(home, filters)
      for (const r of initial) {
        seen.add(r.frontmatter.id)
        printOne(r)
      }
      // Watch the dir for new files. Each fs event triggers a fresh
      // list call; we filter via the seen set so each id prints once.
      const dir = homePaths(home).stateNotifications
      try {
        for await (const _event of watch(dir)) {
          const list = await listNotifications(home, filters)
          for (const r of list) {
            if (seen.has(r.frontmatter.id)) continue
            seen.add(r.frontmatter.id)
            printOne(r)
          }
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ABORT_ERR') throw err
      }

      function printOne(r: Awaited<ReturnType<typeof listNotifications>>[number]): void {
        const fm = r.frontmatter
        const ask = fm.requires_response ? '?' : ' '
        console.log(
          `· ${ask} [${fm.tier.padEnd(9)}] ${fm.agent.padEnd(8)} ${fm.kind.padEnd(28)} ${fm.id}`,
        )
      }
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

  // Track who's "thinking" (has a pending/running task in their local
  // task store). Used to print transient inline status updates so the
  // operator can see which Agent is working on a reply.
  const thinkingByAgentId = new Map<string, boolean>()
  let agentIdToLocalName = new Map<string, string>()

  const refreshAgentIdMap = async (): Promise<void> => {
    try {
      const roster = await readRoster(home, targetPub.name)
      agentIdToLocalName = new Map(roster.agents.map((a) => [a.agent_id, a.agent_name]))
    } catch {
      // Roster missing or malformed... thinking notices skipped for
      // agents we can't map; chat still works.
    }
  }
  await refreshAgentIdMap()

  // openpub-server adds a "Bartender" house presence we don't want
  // tracked or surfaced.
  const isRealParticipant = (display_name: string): boolean => display_name !== 'Bartender'

  // Subscribe to incoming events. Each goes through printIncoming which
  // clears the prompt line, prints the message, then reprints the prompt
  // so the user's typing isn't visually interrupted.
  client.onEvent((event) => {
    if (event.type === 'message') {
      const m = event.data
      if (m.agent_id === userCred.agent_id) return // skip our own
      if (seenIds.has(m.message_id)) return
      seenIds.add(m.message_id)
      printIncoming(m.display_name, m.content, promptStr, rl)
    } else if (event.type === 'conversation_event') {
      const m = event.data
      if (m.from.agent_id === userCred.agent_id) return
      if (seenIds.has(m.message_id)) return
      seenIds.add(m.message_id)
      const cached = client.roomState()?.conversation.find((msg) => msg.message_id === m.message_id)
      printIncoming(m.from.display_name, cached?.content ?? m.preview, promptStr, rl)
    } else if (event.type === 'pub_reaction') {
      const r = event.data
      if (r.agent_id === userCred.agent_id) return
      printIncoming(r.display_name, `(reacted ${r.emoji})`, promptStr, rl)
    } else if (event.type === 'error') {
      printIncoming('!error', event.data.message, promptStr, rl)
    }
  })

  // Read stdin.
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: promptStr,
  })

  // Thinking detection tick: every 250ms, check each in-room agent's
  // task store. When the answer flips, print a transient status line
  // (e.g. "[hobby is thinking…]" / "[hobby idle]") inline so the
  // operator knows who's working without needing a pinned status bar.
  // 250ms is tight enough to catch sub-second pings.
  const thinkingTimer = setInterval(() => {
    void (async () => {
      const room = client.roomState()
      if (!room) return
      for (const a of room.agents_present) {
        if (a.agent_id === userCred.agent_id) continue
        if (!isRealParticipant(a.display_name)) continue
        const localName = agentIdToLocalName.get(a.agent_id)
        if (!localName) continue
        const wasThinking = thinkingByAgentId.get(a.agent_id) ?? false
        const isThinking = await detectAgentThinking(home, localName)
        if (wasThinking !== isThinking) {
          thinkingByAgentId.set(a.agent_id, isThinking)
          // Inline notice that lives in scrollback like any other line.
          // Dim styling so it reads as ambient, not as a real message.
          const verb = isThinking ? 'is thinking…' : 'is idle'
          printIncoming(`status`, `\x1b[2m${a.display_name} ${verb}\x1b[0m`, promptStr, rl)
        }
      }
    })()
  }, 250)
  thinkingTimer.unref()

  const cleanup = async (): Promise<void> => {
    clearInterval(thinkingTimer)
    rl.close()
    try {
      await client.close()
    } catch {
      // best-effort
    }
  }

  rl.prompt()

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
        rl.prompt()
        return
      }
      try {
        await client.send({ content: trimmed })
      } catch (err) {
        console.error(`send failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      rl.prompt()
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

/**
 * Print an incoming line to the chat above the readline prompt without
 * disturbing what the user is typing. Clears the prompt line, writes
 * the line, and reprints the prompt with the user's partial input
 * preserved.
 */
function printIncoming(
  sender: string,
  content: string,
  prompt: string,
  rl: readline.Interface,
): void {
  process.stdout.write('\r\x1b[2K')
  process.stdout.write(`[${sender}] ${content}\n`)
  process.stdout.write(prompt + rl.line)
}

/**
 * Returns true if the named local Agent has any task in a non-terminal
 * state (`pending` or `running`). Reads YAML frontmatter from up to the
 * 5 most recent task files in the agent's task store.
 *
 * Returns false on any error... a missing agent should render as
 * not-thinking, not crash the chat.
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
