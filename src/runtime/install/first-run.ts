/**
 * First-run guided setup for a fresh 2200 install.
 *
 * Triggered when bare `2200` is invoked AND the user has no prior
 * installation state (no user config file). Walks the user through
 * the substrate set-up:
 *
 *   1. Show what is about to happen.
 *   2. Confirm or override 2200_HOME (default = defaultHome()).
 *   3. Write user config + initialize the directory layout (init).
 *   4. Start the supervisor daemon.
 *   5. Mint the user identity (display name).
 *   6. Print the explicit next step (run `2200 agent build`).
 *
 * The orchestrator is a pure module: it never reads from stdin or
 * writes to stdout itself. All I/O goes through a small `FirstRunIO`
 * interface so the CLI can wire stdin/stdout and tests can drive the
 * flow with a stub. The orchestrator does call into the existing
 * `Supervisor` and `startDaemon` substrate, which is the same code
 * `2200 init` and `2200 daemon start` invoke.
 *
 * Detection (`shouldRunFirstRun()`) uses the presence of the user
 * config file as the single signal. That file is the artifact that
 * `2200 init` produces; absent file means we've never been here.
 */
import { Supervisor } from '../supervisor/supervisor.js'
import { startDaemon } from '../supervisor/daemon.js'
import { connectUds } from '../control-plane/uds-client.js'
import { JsonRpcClient } from '../control-plane/client.js'
import { defaultHome, saveUserConfig, tryLoadUserConfig, userConfigPath } from '../config/loader.js'

/**
 * Minimal I/O surface the orchestrator needs. The CLI implementation
 * wires stdin (`ask`) + stdout (`info`, `success`, `warn`); tests pass
 * a stub that asserts on the prompts and returns canned answers.
 */
export interface FirstRunIO {
  /** Prompt the user and return the trimmed reply. */
  ask: (prompt: string) => Promise<string>
  /** Print an informational line. */
  info: (line: string) => void
  /** Print a success line (no styling required; CLI may color). */
  success: (line: string) => void
  /** Print a warning line (e.g., a non-fatal post-condition). */
  warn: (line: string) => void
}

/** Outcome enum returned by `runFirstRun`. */
export type FirstRunResult =
  | { status: 'completed'; home: string; displayName: string }
  | { status: 'aborted'; reason: string }

/**
 * Returns true when the orchestrator should fire (no prior install
 * state). The signal is "no user config file at the configured XDG
 * path". A daemon that happens to be running on a custom --home is
 * irrelevant to this check because the user has not asked for that
 * home to be remembered.
 */
export async function shouldRunFirstRun(): Promise<boolean> {
  const config = await tryLoadUserConfig()
  return config === null
}

/**
 * Run the full guided setup. Caller owns all I/O.
 *
 * Returns `completed` on the happy path. Returns `aborted` if the
 * user declines at the confirmation step or fails to provide a
 * display name. Throws on infrastructure failures (Supervisor.create,
 * startDaemon, RPC); the caller should present those to the user with
 * the recovery command for that step.
 *
 * Side-effect ordering: all input is collected up front. Filesystem
 * writes, daemon spawn, and RPC happen only after the user has
 * answered every prompt. This means a ctrl-C at any prompt is safe.
 */
export async function runFirstRun(io: FirstRunIO): Promise<FirstRunResult> {
  // ------------------------------------------------------------------
  // 1. Banner + confirmation.
  // ------------------------------------------------------------------
  io.info('')
  io.info('Welcome to 2200.')
  io.info('')
  io.info('I will walk you through the one-time setup:')
  io.info('  - choose where 2200 keeps its state (the "home" directory)')
  io.info('  - start the supervisor daemon (the long-running process behind your fleet)')
  io.info('  - mint your user identity (the name other Agents see when you chat with them)')
  io.info('')
  io.info('No API keys are needed yet. After this finishes I will point you at the')
  io.info('Agent-build wizard, which is where you will configure an LLM provider.')
  io.info('')

  const proceed = await io.ask('Continue? [Y/n] ')
  if (!isYes(proceed, true)) {
    return { status: 'aborted', reason: 'declined-at-start' }
  }

  // ------------------------------------------------------------------
  // 2. Choose 2200_HOME (input only; no filesystem write yet).
  // ------------------------------------------------------------------
  const proposedHome = defaultHome()
  io.info('')
  io.info(`Default 2200_HOME: ${proposedHome}`)
  const homeReply = await io.ask('Press Enter to accept, or type a different path: ')
  const home = homeReply.length > 0 ? homeReply : proposedHome

  // ------------------------------------------------------------------
  // 3. Collect display name (input only).
  // ------------------------------------------------------------------
  io.info('')
  io.info('Now I need your display name. This is what other Agents see when you')
  io.info('chat with them in a pub. You can change it later by editing user.md.')
  let displayName = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    displayName = (await io.ask('Display name: ')).trim()
    if (displayName.length > 0) break
    io.warn('Display name cannot be empty.')
  }
  if (displayName.length === 0) {
    return { status: 'aborted', reason: 'empty-display-name' }
  }

  // ------------------------------------------------------------------
  // 4. Apply side effects: write config, init layout, start daemon, mint user.
  // ------------------------------------------------------------------
  await saveUserConfig({ schema_version: 1, home })
  io.info('')
  io.info(`Writing user config to ${userConfigPath()}`)
  await Supervisor.create({ home })
  io.success(`Initialized 2200_HOME at ${home}`)

  const pid = await startDaemon({ home })
  io.success(`Supervisor daemon started (pid ${String(pid)})`)

  // `startDaemon` returns as soon as the child process is spawned;
  // the supervisor inside that process still needs to load its
  // runtime + bind the UDS socket before it can accept RPCs. Poll
  // the socket for up to 10s with 100ms backoff. The retry loop is
  // also defensive against future supervisor-init reshuffles.
  const sock = Supervisor.socketPath(home)
  const transport = await connectWithRetry(sock, 10_000)
  const rpc = new JsonRpcClient(transport)
  try {
    await rpc.call('cli.user.init', { display_name: displayName })
  } finally {
    await rpc.close()
  }
  io.success(`User identity minted (display name: ${displayName})`)

  // ------------------------------------------------------------------
  // 5. Next step.
  // ------------------------------------------------------------------
  io.info('')
  io.info('Setup complete. Next:')
  io.info('')
  io.info('  2200 agent build')
  io.info('')
  io.info('That command starts the conversational wizard for your first Agent.')
  io.info('It will ask for an LLM provider key (Anthropic, OpenAI, xAI, DeepSeek, ...).')
  io.info('')
  io.info('Other useful commands:')
  io.info('  2200 --help          show all commands')
  io.info('  2200 daemon status   confirm the daemon is up')
  io.info('  2200 update          check for and install a newer version')
  io.info('')

  return { status: 'completed', home, displayName }
}

/**
 * Interpret a yes/no reply. Empty + `defaultYes` returns true (the
 * `[Y/n]` convention). Recognises "y", "yes" case-insensitively as
 * yes; anything else is no.
 */
function isYes(reply: string, defaultYes: boolean): boolean {
  const v = reply.trim().toLowerCase()
  if (v.length === 0) return defaultYes
  return v === 'y' || v === 'yes'
}

/**
 * Connect to the supervisor's UDS, retrying every 100ms until the
 * socket accepts a connection or `timeoutMs` elapses. Re-throws the
 * last error on timeout so the user sees the underlying cause.
 */
async function connectWithRetry(
  socketPath: string,
  timeoutMs: number,
): Promise<Awaited<ReturnType<typeof connectUds>>> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown = null
  while (Date.now() < deadline) {
    try {
      return await connectUds(socketPath)
    } catch (err) {
      lastErr = err
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`could not connect to supervisor at ${socketPath} within ${String(timeoutMs)}ms`)
}
