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
import { listKnownProviders, type ProviderCatalogEntry } from '../llm/registry.js'
import { validateProviderKey } from '../llm/validate-key.js'
import {
  defaultRuntimeEnvPath,
  loadRuntimeEnv,
  upsertRuntimeEnvKey,
} from '../config/runtime-env.js'

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
export async function runFirstRun(
  io: FirstRunIO,
  opts: {
    /**
     * Probe for an OpenClaw home to offer migration. Defaults to the
     * real `~/.openclaw` detector. Injectable so tests are
     * deterministic (and can disable the offer with `() => null`).
     */
    detectOpenClaw?: () => Promise<string | null>
  } = {},
): Promise<FirstRunResult> {
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
  io.info('  - (optional) sign in with X / SuperGrok so every Agent that picks Grok')
  io.info('    can use your subscription with no API key')
  io.info('  - (optional, advanced) mint an MCP connector token so Grok or other')
  io.info('    MCP clients can call into your fleet via your own tunnel')
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

  // Bind the web server to the LAN so the access URL printed at the end
  // is reachable from another device. Set BEFORE the daemon starts (it
  // reads the host from the environment at boot) and persist it.
  await upsertRuntimeEnvKey('TWENTYTWOHUNDRED_WEB_HOST', '0.0.0.0')
  process.env['TWENTYTWOHUNDRED_WEB_HOST'] = '0.0.0.0'

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
  // 4a. OpenClaw migration (only when OpenClaw is actually present).
  //
  // Offered automatically when ~/.openclaw is detected ... a blank
  // user never sees this. Runs through the now-running daemon's
  // cli.build.from-handoff RPC (avoiding the migrate-vs-daemon
  // state-file race the standalone CLI guards against). Non-fatal:
  // a failed or declined migration falls through to the normal
  // fresh-setup steps and never aborts the wizard.
  // ------------------------------------------------------------------
  const detectOpenClaw =
    opts.detectOpenClaw ??
    (async () => {
      const { detectOpenClawHome } = await import('../migration/openclaw.js')
      return detectOpenClawHome()
    })
  const ocResult = await runFirstRunOpenClawMigration(io, home, detectOpenClaw, {
    interactive: true,
  })

  // ------------------------------------------------------------------
  // 5. Grok-First sign-in (optional, default yes).
  //
  // Surfaced here so an operator who already has a SuperGrok / X
  // Premium+ subscription leaves first-run with a working LLM
  // credential ... no API key paste required. Skip is graceful: a
  // later `2200 oauth xai login` (or the Settings UI tile) achieves
  // the same outcome.
  // ------------------------------------------------------------------
  io.info('')
  io.info('Grok subscription sign-in (recommended).')
  io.info('')
  io.info('If you have an X Premium+ or SuperGrok subscription, sign in now to use')
  io.info('your Grok subscription across every Agent in your fleet ... no XAI_API_KEY')
  io.info('required. Other LLM providers (Anthropic, OpenAI, DeepSeek, ...) remain')
  io.info('available; this just makes Grok the easiest path.')
  io.info('')
  const grokReply = await io.ask('Sign in with X / SuperGrok now? [Y/n] ')
  if (isYes(grokReply, true)) {
    await runFirstRunGrokSignIn(io, home)
  } else {
    io.info('Skipped. You can run `2200 oauth xai login` later, or use the Settings page.')
    io.info('')
  }

  // ------------------------------------------------------------------
  // 5a. API-key provider setup (always offered).
  //
  // Operators can configure a SuperGrok subscription AND additional
  // API-key providers (Anthropic, OpenAI, Gemini, DeepSeek, Kimi,
  // OpenRouter, xAI API-key) in a single first-run pass. Operators
  // without SuperGrok rely on this path to leave first-run with a
  // working credential.
  // ------------------------------------------------------------------
  await runFirstRunApiKeyProviders(io)

  // ------------------------------------------------------------------
  // 5b. MCP connector setup (optional, default NO).
  //
  // Exposes a narrow, read-only-first slice of the fleet to Grok and
  // other MCP clients via the operator's own tunnel. Most operators
  // don't need this on day one ... it requires a tunnel (ngrok,
  // cloudflared, Tailscale Funnel, etc.) plus registering a Custom
  // connector at grok.com/connectors. Default NO so the install
  // path stays uncluttered for users who do not know what MCP is;
  // the `2200 connector token regenerate` command (or Settings tile)
  // achieves the same thing later.
  // ------------------------------------------------------------------
  io.info('MCP connector setup (advanced).')
  io.info('')
  io.info('Lets Grok (and any other MCP-speaking client) call into your fleet via')
  io.info('your own tunnel. Recommended for power users who already have a tunnel')
  io.info('service set up (ngrok / cloudflared / Tailscale Funnel) and want to')
  io.info('register a Custom connector at grok.com/connectors. Skip if not sure ...')
  io.info('the Settings page can set this up later.')
  io.info('')
  const connectorReply = await io.ask('Generate a connector token now? [y/N] ')
  if (isYes(connectorReply, false)) {
    await runFirstRunConnectorSetup(io, home)
  } else {
    io.info('Skipped. Visit Settings → MCP Connector when you are ready.')
    io.info('')
  }

  // ------------------------------------------------------------------
  // 6. End at the web URL ... not at a "now run this" instruction. If an
  //    OpenClaw Agent was migrated, we do NOT push the user toward
  //    building a "first Agent" they already have.
  // ------------------------------------------------------------------
  const { ensureWebTokenForHome, printWebAccess, webPortFromEnv } = await import('./quick-setup.js')
  const token = await ensureWebTokenForHome(home)
  printWebAccess({
    port: webPortFromEnv(),
    token,
    migratedAgent: ocResult.agentName,
    freshInstall: ocResult.agentName === null,
    out: (l) => {
      io.info(l)
    },
  })

  return { status: 'completed', home, displayName }
}

/**
 * Offer to migrate an existing OpenClaw Agent into 2200, inline during
 * first-run. Detection is injected; when it returns null (no OpenClaw),
 * this is a silent no-op so a fresh user never sees the prompt.
 *
 * On acceptance it surveys the OpenClaw home, converts it to a handoff,
 * and materializes the Agent through the running daemon's
 * `cli.build.from-handoff` RPC (which runs the same orchestrator the
 * `2200 agent migrate` command uses, inside the daemon's Supervisor so
 * there is no state-file race). It then copies the OpenClaw LLM provider
 * keys into `runtime.env` (never overwriting an existing 2200 key) so
 * the migrated Agent works without re-auth, prints the migration report,
 * and shows the disable-not-delete guidance for the source instance.
 *
 * Every failure path is non-fatal: the operator keeps a working install
 * and can retry with `2200 agent migrate --from-openclaw <dir>`.
 */
export async function runFirstRunOpenClawMigration(
  io: FirstRunIO,
  home: string,
  detect: () => Promise<string | null>,
  opts: {
    /** Skip the "migrate now?" prompt and just migrate (the setup path). */
    autoAccept?: boolean
    /** Allow asking, and acting on, the "disable OpenClaw?" question. */
    interactive?: boolean
  } = {},
): Promise<{ migrated: boolean; agentName: string | null }> {
  const noMigration = { migrated: false as const, agentName: null }
  let ocHome: string | null
  try {
    ocHome = await detect()
  } catch {
    ocHome = null
  }
  if (ocHome === null) return noMigration // no OpenClaw → never prompt

  io.info('')
  io.info(`I found an OpenClaw install at ${ocHome}.`)
  io.info('Bringing your OpenClaw Agent over ... its persona, daily memories,')
  io.info('schedules, and LLM provider keys come with it. Your OpenClaw install')
  io.info('is left running for now; you can disable it at the end.')
  io.info('')
  if (!opts.autoAccept) {
    const reply = await io.ask('Migrate your OpenClaw Agent into 2200 now? [Y/n] ')
    if (!isYes(reply, true)) {
      io.info(`Skipped. You can migrate any time with:`)
      io.info(`  2200 agent migrate --from-openclaw ${ocHome}`)
      io.info('')
      return noMigration
    }
  }

  const {
    surveyOpenClawHome,
    openclawToHandoff,
    collectOpenClawLlmEnv,
    renderDisableInstructions,
  } = await import('../migration/openclaw.js')

  // Survey + convert. A parse failure must not abort setup.
  let converted: Awaited<ReturnType<typeof openclawToHandoff>> | undefined
  try {
    const survey = await surveyOpenClawHome(ocHome)
    const { hostname } = await import('node:os')
    converted = openclawToHandoff(survey, { sourceHost: hostname() })
  } catch (err) {
    io.warn(
      `Could not read the OpenClaw install: ${err instanceof Error ? err.message : String(err)}`,
    )
    io.warn(`Skipping migration. Retry later with: 2200 agent migrate --from-openclaw ${ocHome}`)
    io.info('')
    return noMigration
  }
  for (const w of converted.warnings) io.warn(w)

  // Materialize through the running daemon.
  const sock = Supervisor.socketPath(home)
  let transport
  try {
    transport = await connectWithRetry(sock, 10_000)
  } catch (err) {
    io.warn(
      `Could not reach the daemon to migrate: ${err instanceof Error ? err.message : String(err)}`,
    )
    io.info('')
    return noMigration
  }
  const rpc = new JsonRpcClient(transport)
  let migratedName: string | null = null
  try {
    const result = await rpc.call('cli.build.from-handoff', { handoff: converted.handoff })
    io.success(
      `Migrated "${result.agent_name}" into 2200 (${String(result.brain_imported_count)} brain notes imported).`,
    )
    migratedName = result.agent_name
  } catch (err) {
    io.warn(`Migration failed: ${err instanceof Error ? err.message : String(err)}`)
    io.warn(`Retry later with: 2200 agent migrate --from-openclaw ${ocHome}`)
  } finally {
    await rpc.close()
  }
  if (migratedName === null) {
    io.info('')
    return noMigration
  }

  // Copy OpenClaw LLM provider keys so the migrated Agent works without
  // re-auth. Existing 2200 keys are never overwritten. Per-key isolation:
  // a single odd key name (upsert validates key shape) must not lose the
  // rest, so each write is guarded independently.
  try {
    const collected = await collectOpenClawLlmEnv(ocHome)
    const existing = await loadRuntimeEnv()
    let copied = 0
    for (const [k, v] of Object.entries(collected)) {
      if (existing[k] !== undefined) continue
      try {
        await upsertRuntimeEnvKey(k, v)
        copied += 1
      } catch {
        io.warn(`Skipped an OpenClaw key with an unexpected name shape: ${k}`)
      }
    }
    if (copied > 0) {
      io.success(
        `Copied ${String(copied)} LLM provider key${copied === 1 ? '' : 's'} from OpenClaw (effective on the next daemon restart).`,
      )
    }
  } catch (err) {
    io.warn(
      `Could not copy LLM keys from OpenClaw: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // The migration report (what mapped / didn't).
  io.info('')
  io.info(converted.report)
  io.info('')

  // Offer to disable (NOT delete) the source OpenClaw instance, so it
  // stops running alongside 2200 and the operator isn't paying twice.
  // We only ACT on an explicit yes (default no) and only when we can
  // ask ... never auto-disable; the operator owns that decision. When
  // we can't ask (non-interactive), print the manual command instead.
  if (opts.interactive) {
    const reply = await io.ask(
      'Disable your OpenClaw instance now so it stops running alongside 2200? It will NOT be deleted. [y/N] ',
    )
    if (isYes(reply, false)) {
      const { disableOpenClaw } = await import('../migration/openclaw.js')
      const result = await disableOpenClaw()
      if (result.ok) {
        io.success(`OpenClaw disabled: ${result.detail}. (Not deleted; re-enable any time.)`)
      } else {
        io.warn(`Could not disable OpenClaw automatically: ${result.detail}.`)
        io.info('Disable it by hand when ready (it will NOT be deleted):')
        io.info(renderDisableInstructions({ sameHost: true }))
      }
    } else {
      io.info('Left OpenClaw running. To disable it later (it will NOT be deleted):')
      io.info(renderDisableInstructions({ sameHost: true }))
    }
  } else {
    io.info('To stop OpenClaw running alongside 2200 (it will NOT be deleted):')
    io.info(renderDisableInstructions({ sameHost: true }))
  }
  io.info('')
  return { migrated: true, agentName: migratedName }
}

/**
 * Drive the xAI device-code OAuth flow inline during first-run.
 *
 * Mirrors `2200 oauth xai login` but emits through `FirstRunIO` so the
 * surrounding wizard's logging style is consistent. On failure we log
 * and continue ... a failed Grok sign-in must NOT abort the wizard;
 * the operator already has a working install, just no Grok credential
 * yet (which they can fix later from Settings or CLI).
 */
async function runFirstRunGrokSignIn(io: FirstRunIO, home: string): Promise<void> {
  const { fetchXaiDiscovery, xaiDeviceFlowProvider } = await import('../oauth/xai-config.js')
  const { runDeviceFlow } = await import('../oauth/device-flow.js')
  const { saveOAuthToken } = await import('../oauth/token-store.js')

  io.info('Fetching xAI sign-in details...')
  let discovery
  try {
    discovery = await fetchXaiDiscovery()
  } catch (err) {
    io.warn(
      `Could not contact xAI for sign-in: ${err instanceof Error ? err.message : String(err)}`,
    )
    io.warn('Skipping Grok sign-in for now. You can retry with `2200 oauth xai login` later.')
    io.info('')
    return
  }
  const provider = xaiDeviceFlowProvider(discovery)

  try {
    const tokens = await runDeviceFlow({
      provider,
      onPrompt: (prompt) => {
        io.info('')
        io.info('To sign in with your SuperGrok / X Premium+ account:')
        io.info(`  1. Open this URL in any browser (phone works fine):`)
        io.info(`     ${prompt.verificationUri}`)
        if (
          prompt.verificationUriComplete &&
          prompt.verificationUriComplete !== prompt.verificationUri
        ) {
          io.info(`     (or the convenience URL with the code pre-filled:`)
          io.info(`     ${prompt.verificationUriComplete})`)
        }
        io.info(`  2. When prompted, enter this code:  ${prompt.userCode}`)
        io.info('')
        io.info('xAI labels the consent screen "Grok Build" ... that is xAI\'s shared CLI OAuth')
        io.info('client name, not a separate app you are installing.')
        io.info('')
        io.info(`Waiting for you to confirm (expires at ${prompt.expiresAt.toISOString()})...`)
      },
    })

    if (!tokens.refresh_token) {
      io.warn('xAI did not return a refresh token; sign-in incomplete. Skipping.')
      io.info('')
      return
    }

    const now = Date.now()
    const expiresAtMs =
      tokens.expires_in !== undefined ? now + tokens.expires_in * 1000 : now + 3600 * 1000
    await saveOAuthToken(home, {
      provider: 'xai-oauth',
      bearer: tokens.access_token,
      refreshToken: tokens.refresh_token,
      metadata: {
        granted_scopes: tokens.scope ? tokens.scope.split(/\s+/) : [],
        expires_at_ms: expiresAtMs,
        created_at: new Date(now).toISOString(),
      },
    })
    io.success('Signed in to xAI / Grok. Subscription credential sealed to disk.')
    io.info('')
  } catch (err) {
    io.warn(`Grok sign-in failed: ${err instanceof Error ? err.message : String(err)}`)
    io.warn('Continuing without Grok. You can retry with `2200 oauth xai login` later.')
    io.info('')
  }
}

/**
 * API-key provider setup loop. Lists every paste-a-key provider in
 * the registry, prompts the operator to pick one (or skip), validates
 * the pasted key against the provider's `GET /v1/models` endpoint,
 * and writes the key to `~/.config/2200/runtime.env` so the
 * supervisor (and every Agent it spawns) picks it up at start time.
 *
 * Loops until the operator skips, so an operator can set up multiple
 * providers in a single pass (e.g., Anthropic + DeepSeek as a fallback
 * pair). The xai-subscription provider is filtered out — that path
 * goes through the Grok sign-in step above.
 *
 * Errors:
 *  - Invalid key (auth_failed): show the provider's error, offer
 *    retry or skip this provider.
 *  - Network error: surface the failure, save the key anyway with a
 *    "couldn't verify" warning. The operator may be offline during
 *    setup; refusing to save would block them from finishing.
 *
 * The supervisor reads runtime.env only at start, so the wizard
 * tells the operator the key takes effect on the next `2200 daemon
 * restart` (which is part of the natural "next session" workflow,
 * not something they need to do right now).
 */
export async function runFirstRunApiKeyProviders(io: FirstRunIO): Promise<void> {
  const all = listKnownProviders()
  // Surface only paste-a-key providers (`api-key` category). The
  // `subscription` provider (xai-subscription) is reachable via the
  // SuperGrok step above; `local` (Ollama / LM Studio) needs a
  // different shape (base URL + optional key) and lives in a future
  // first-run iteration.
  const candidates = all.filter((p) => p.category === 'api-key')
  if (candidates.length === 0) return // defensive; registry always has these

  io.info('API-key provider setup (optional).')
  io.info('')
  io.info('Add an API key for Anthropic, OpenAI, DeepSeek, etc. Each Agent picks')
  io.info('its provider when you build it (`2200 agent build`); having the keys')
  io.info('available now means you can choose any of them at Agent-build time.')
  io.info('')
  io.info('You can add multiple providers; the loop ends when you skip.')
  io.info('')

  let added = 0
  // Loop until the operator chooses to skip. Capped at the number of
  // candidates so we cannot run forever even with weird inputs.
  for (let i = 0; i < candidates.length + 1; i++) {
    io.info(added === 0 ? 'Available providers:' : `Added ${String(added)} so far. Add another?`)
    io.info('')
    for (let j = 0; j < candidates.length; j++) {
      const p = candidates[j]
      if (!p) continue
      io.info(`  ${String(j + 1)}) ${p.label}  (env: ${p.defaultEnvKey})`)
    }
    io.info(`  ${String(candidates.length + 1)}) Skip (done with API keys)`)
    io.info('')
    const choiceRaw = (await io.ask('Choice: ')).trim()
    const choice = Number.parseInt(choiceRaw, 10)
    if (!Number.isInteger(choice) || choice < 1 || choice > candidates.length + 1) {
      io.warn(`"${choiceRaw}" is not a valid choice; please pick a number from the list.`)
      continue
    }
    if (choice === candidates.length + 1) {
      // Skip remaining.
      break
    }
    const provider = candidates[choice - 1]
    if (!provider) continue // defensive against ts type narrowing
    const settled = await promptAndSaveApiKey(io, provider)
    if (settled) added += 1
    io.info('')
  }

  if (added > 0) {
    io.success(
      `Saved ${String(added)} API key${added === 1 ? '' : 's'} to ${userRuntimeEnvPath()}.`,
    )
    io.info('The key takes effect on the next supervisor restart (next 2200 launch, or')
    io.info('run `2200 daemon restart` now). Agents pick their provider when you build them.')
    io.info('')
  } else {
    io.info('No API keys configured. You can add them later from the CLI or Settings.')
    io.info('')
  }
}

/**
 * Prompt for a single provider's API key, validate it via
 * `validateProviderKey`, and persist via `upsertRuntimeEnvKey`.
 * Returns `true` iff the key was saved (validated OR forced past a
 * network error); `false` if the operator backed out.
 *
 * Retry policy: up to 3 paste attempts for auth_failed errors before
 * giving up (operator may have a long key with a typo). Network
 * errors get one offer to save-anyway-with-warning.
 */
async function promptAndSaveApiKey(
  io: FirstRunIO,
  provider: ProviderCatalogEntry,
): Promise<boolean> {
  io.info('')
  io.info(`Setting up ${provider.label}.`)
  io.info(`The key will be written to ${userRuntimeEnvPath()} as ${provider.defaultEnvKey}.`)
  io.info('')

  for (let attempt = 0; attempt < 3; attempt++) {
    const key = (await io.ask(`Paste your ${provider.label} API key (or empty to cancel): `)).trim()
    if (key.length === 0) {
      io.info('Canceled.')
      return false
    }
    io.info('Verifying key against the provider...')
    const result = await validateProviderKey({ provider, apiKey: key })
    if (result.ok) {
      await upsertRuntimeEnvKey(provider.defaultEnvKey, key)
      io.success(`${provider.label} key verified and saved (${provider.defaultEnvKey}).`)
      return true
    }
    if (result.reason === 'auth_failed') {
      io.warn(
        `${provider.label} rejected the key (HTTP ${String(result.status)}). ${result.message.slice(0, 200)}`,
      )
      io.warn(`Attempts left: ${String(2 - attempt)}.`)
      continue
    }
    if (result.reason === 'network_error') {
      io.warn(`Could not reach ${provider.label} to verify (${result.message}).`)
      const saveAnyway = await io.ask('Save the key anyway? [y/N] ')
      if (isYes(saveAnyway, false)) {
        await upsertRuntimeEnvKey(provider.defaultEnvKey, key)
        io.success(
          `${provider.label} key saved unverified (${provider.defaultEnvKey}). It will be tested when an Agent first uses it.`,
        )
        return true
      }
      io.info('Discarded. You can retry online.')
      return false
    }
    // `unexpected`: 5xx, throttling, etc. Surface verbatim.
    io.warn(
      `${provider.label} returned HTTP ${String(result.status)}: ${result.message.slice(0, 200)}`,
    )
    const saveAnyway = await io.ask('Save the key anyway? [y/N] ')
    if (isYes(saveAnyway, false)) {
      await upsertRuntimeEnvKey(provider.defaultEnvKey, key)
      io.success(`${provider.label} key saved unverified (${provider.defaultEnvKey}).`)
      return true
    }
    return false
  }
  io.warn(`Gave up after 3 attempts for ${provider.label}. You can retry later.`)
  return false
}

/** ~/.config/2200/runtime.env (display-only; resolves via the loader). */
function userRuntimeEnvPath(): string {
  return defaultRuntimeEnvPath()
}

/**
 * Mint a fresh MCP connector bearer + start the listener.
 *
 * The daemon is already running by this point (step 3 of the wizard
 * launched it). We open a short-lived RPC connection over the UDS,
 * call `cli.connector.regenerate`, and surface the token once with
 * paste-target instructions. Failure is non-fatal ... the operator
 * can retry via `2200 connector token regenerate` or the Settings
 * tile.
 */
async function runFirstRunConnectorSetup(io: FirstRunIO, home: string): Promise<void> {
  const sock = Supervisor.socketPath(home)
  let transport
  try {
    transport = await connectWithRetry(sock, 5_000)
  } catch (err) {
    io.warn(
      `Could not reach the daemon for connector setup: ${err instanceof Error ? err.message : String(err)}`,
    )
    io.warn('Skipping. Retry with `2200 connector token regenerate` or the Settings tile.')
    io.info('')
    return
  }
  const rpc = new JsonRpcClient(transport)
  try {
    const { token } = await rpc.call('cli.connector.regenerate', {})
    io.success('Connector bearer minted and sealed to disk. Listener is live.')
    io.info('')
    io.info('Token (shown once, copy it now):')
    io.info(`  ${token}`)
    io.info('')
    io.info('Paste this token at https://grok.com/connectors → New Connector → Custom')
    io.info('(Authorization field). Make the connector endpoint reachable from the')
    io.info('public internet with a tunnel of your choice (ngrok / cloudflared /')
    io.info('Tailscale Funnel) ... by default the listener binds to port 2201.')
    io.info('')
    io.info('Regenerate or disable any time from `2200 connector token ...` or Settings.')
    io.info('')
  } catch (err) {
    io.warn(`Connector setup failed: ${err instanceof Error ? err.message : String(err)}`)
    io.warn('Skipping. Retry with `2200 connector token regenerate` or the Settings tile.')
    io.info('')
  } finally {
    await rpc.close()
  }
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
