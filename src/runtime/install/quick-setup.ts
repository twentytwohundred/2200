/**
 * One-shot, non-interactive setup ... the "paste the install command and
 * end at a URL" path.
 *
 * The installer runs this immediately after `npm install -g`, so the
 * whole experience is a single fluid flow with no stopping points:
 *
 *   curl -fsSL https://2200.ai/install.sh | sh
 *     → install → setup → "open http://<lan-ip>:2200/?token=..."
 *
 * What it does, all with sensible defaults and zero prompts:
 *   1. Resolve 2200_HOME (default) and initialize the layout.
 *   2. Bind the web server to the LAN (0.0.0.0) and persist that, so the
 *      printed URL is reachable from a phone or another laptop ... most
 *      installs live behind a private IP, not a public hostname.
 *   3. Start the daemon and mint a user identity (display name defaults
 *      to $USER; the operator renames it later in the web app).
 *   4. If an OpenClaw install is present, migrate it automatically ...
 *      the Agents come over, so we never walk the operator through
 *      building a "first Agent" they already have.
 *   5. Print the access block: the reachable URLs with the bearer token
 *      embedded (one-click). Tailscale IP preferred when the machine is
 *      on a tailnet (reachable anywhere), then the LAN IP, then localhost.
 *
 * Idempotent: a second run (config already exists) just ensures the
 * daemon is up and reprints the access URL.
 *
 * Security posture: binding to 0.0.0.0 exposes the web API to the local
 * network, but every route requires the bearer token, and the token is
 * shown only to the operator. This matches the "home/office LAN" target
 * the operator opted into by asking for a LAN URL.
 */
import { readFile } from 'node:fs/promises'
import * as readline from 'node:readline'
import { Supervisor } from '../supervisor/supervisor.js'
import { startDaemon, killDaemon, logFilePath } from '../supervisor/daemon.js'
import { connectUds } from '../control-plane/uds-client.js'
import { JsonRpcClient } from '../control-plane/client.js'
import { defaultHome, saveUserConfig, tryLoadUserConfig } from '../config/loader.js'
import { upsertRuntimeEnvKey } from '../config/runtime-env.js'
import { homePaths } from '../storage/layout.js'
import { WebTokenStore } from '../http/tokens.js'
import { readLivePid } from '../supervisor/pidfile.js'
import { primaryLanIp, tailscaleIp } from '../util/lan-ip.js'
import { runFirstRunOpenClawMigration, type FirstRunIO } from './first-run.js'

const WEB_HOST = '0.0.0.0'

/**
 * The host the running daemon actually bound its web server to, read
 * from the last "http server up" line in the supervisor log. Null when
 * the log is unreadable or no such line exists. Used to detect a daemon
 * still listening on loopback so setup can restart it onto the LAN.
 */
async function boundWebHost(home: string): Promise<string | null> {
  try {
    const raw = await readFile(logFilePath(home), 'utf8')
    const lines = raw.split('\n').filter((l) => l.includes('http server up'))
    const last = lines[lines.length - 1]
    if (!last) return null
    const m = /"host":"([^"]+)"/.exec(last)
    return m?.[1] ?? null
  } catch {
    return null
  }
}

/**
 * Make sure the daemon is running AND bound to the LAN host. Starts it
 * when down; restarts it when it is up but still on loopback (the case
 * where a prior `2200`/`daemon start` bound 127.0.0.1 before the LAN
 * default existed, so the printed LAN/Tailscale URL would refuse).
 */
async function ensureDaemonOnLan(home: string, out: (l: string) => void): Promise<void> {
  if ((await readLivePid(home)) === null) {
    await startDaemon({ home })
    return
  }
  const host = await boundWebHost(home)
  if (host !== WEB_HOST) {
    out('  Restarting the daemon to listen on your network (was loopback-only)...')
    await killDaemon(home)
    await startDaemon({ home })
  }
}

export interface QuickSetupResult {
  home: string
  port: number
  token: string
  /** LAN URL with the token embedded, or null when only loopback exists. */
  lanUrl: string | null
  /** localhost URL with the token embedded (same-machine access). */
  localUrl: string
  /** Name of the Agent migrated from OpenClaw, when one was. */
  migratedAgent: string | null
  /** False when a prior setup was found and we only re-surfaced the URL. */
  freshInstall: boolean
}

export function webPortFromEnv(): number {
  const raw = process.env['TWENTYTWOHUNDRED_WEB_PORT']
  const n = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : 2200
}

function defaultDisplayName(): string {
  const u = (process.env['USER'] ?? process.env['LOGNAME'] ?? '').trim()
  return u.length > 0 ? u : 'operator'
}

async function connectWithRetry(socketPath: string, timeoutMs: number): Promise<JsonRpcClient> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown = null
  while (Date.now() < deadline) {
    try {
      return new JsonRpcClient(await connectUds(socketPath))
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`daemon socket never came up: ${socketPath}`)
}

/** Read (or lazily create) the web bearer token for this home. */
export async function ensureWebTokenForHome(home: string): Promise<string> {
  const store = new WebTokenStore(homePaths(home).stateWebTokens)
  const t = await store.ensure('default')
  return t.value
}

export interface QuickSetupOptions {
  /** Sink for progress lines. Defaults to stdout. */
  out?: (line: string) => void
  /** Injected OpenClaw detector (tests). Defaults to the real ~/.openclaw probe. */
  detectOpenClaw?: () => Promise<string | null>
  /** Override the default ($USER) display name. */
  displayName?: string
}

export async function runQuickSetup(opts: QuickSetupOptions = {}): Promise<QuickSetupResult> {
  const out = opts.out ?? ((l: string) => process.stdout.write(l + '\n'))
  const port = webPortFromEnv()

  // Idempotent path: already set up. Persist the LAN bind, ensure the
  // daemon is up AND actually listening on the LAN (restart it if a
  // prior run left it on loopback), then resurface the access URL.
  const existing = await tryLoadUserConfig()
  if (existing) {
    const home = existing.home
    await upsertRuntimeEnvKey('TWENTYTWOHUNDRED_WEB_HOST', WEB_HOST)
    process.env['TWENTYTWOHUNDRED_WEB_HOST'] = WEB_HOST
    await ensureDaemonOnLan(home, out)
    const token = await ensureWebTokenForHome(home)
    return finish({ home, port, token, migratedAgent: null, freshInstall: false, out })
  }

  // Fresh install.
  const home = defaultHome()

  // Bind the web server to the LAN BEFORE the daemon starts (it reads
  // the host from the environment at boot). Persist so restarts keep it.
  await upsertRuntimeEnvKey('TWENTYTWOHUNDRED_WEB_HOST', WEB_HOST)
  process.env['TWENTYTWOHUNDRED_WEB_HOST'] = WEB_HOST

  await saveUserConfig({ schema_version: 1, home })
  await Supervisor.create({ home })
  await startDaemon({ home })

  // Mint the user identity (default display name; renamed later in-app).
  const rpc = await connectWithRetry(Supervisor.socketPath(home), 15_000)
  try {
    await rpc.call('cli.user.init', { display_name: opts.displayName ?? defaultDisplayName() })
  } finally {
    await rpc.close()
  }

  // Auto-migrate OpenClaw when present (autoAccept), but ASK before
  // disabling the source ... the operator owns that decision. Setup is
  // otherwise non-interactive; we ask only when a real terminal is
  // attached (the installer runs `2200 setup < /dev/tty`). With no tty,
  // `ask` returns '' and the disable step just prints the command.
  const interactive = process.stdin.isTTY
  const rl = interactive
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null
  const io: FirstRunIO = {
    ask: (prompt: string) =>
      rl
        ? new Promise<string>((resolve) => {
            rl.question(prompt, resolve)
          })
        : Promise.resolve(''),
    info: out,
    success: out,
    warn: out,
  }
  const detect =
    opts.detectOpenClaw ??
    (async () => {
      const { detectOpenClawHome } = await import('../migration/openclaw.js')
      return detectOpenClawHome()
    })
  const mig = await runFirstRunOpenClawMigration(io, home, detect, {
    autoAccept: true,
    interactive,
  }).finally(() => {
    rl?.close()
  })

  const token = await ensureWebTokenForHome(home)
  return finish({
    home,
    port,
    token,
    migratedAgent: mig.agentName,
    freshInstall: true,
    out,
  })
}

function finish(args: {
  home: string
  port: number
  token: string
  migratedAgent: string | null
  freshInstall: boolean
  out: (line: string) => void
}): QuickSetupResult {
  const { home, port, token, migratedAgent, freshInstall, out } = args
  const lan = primaryLanIp()
  const localUrl = `http://localhost:${String(port)}/?token=${token}`
  const lanUrl = lan ? `http://${lan}:${String(port)}/?token=${token}` : null
  printWebAccess({ port, token, migratedAgent, freshInstall, out })
  return { home, port, token, lanUrl, localUrl, migratedAgent, freshInstall }
}

/**
 * Order the reachable web URLs most-useful first: Tailscale (works from
 * anywhere on the tailnet), then LAN (same network), then localhost. The
 * web server binds to 0.0.0.0, so all of these resolve. Pure + injectable
 * so the ordering is testable without a live network.
 */
export function buildAccessUrls(args: {
  tailscaleIp: string | null
  lanIp: string | null
  port: number
  token: string
}): { label: string; href: string }[] {
  const url = (host: string): string => `http://${host}:${String(args.port)}/?token=${args.token}`
  const options: { label: string; href: string }[] = []
  if (args.tailscaleIp) {
    options.push({
      label: 'on your Tailscale network (reachable anywhere)',
      href: url(args.tailscaleIp),
    })
  }
  if (args.lanIp) {
    options.push({ label: 'on your local network', href: url(args.lanIp) })
  }
  options.push({ label: 'on this machine', href: url('localhost') })
  return options
}

/**
 * Print the final "open 2200 here" access block: the reachable URLs
 * (Tailscale preferred, then LAN, then localhost) with the bearer token
 * embedded, and the bare token. Shared by `2200 setup` and the
 * interactive first-run so both end at a URL, not a "now run this".
 */
export function printWebAccess(args: {
  port: number
  token: string
  migratedAgent: string | null
  freshInstall: boolean
  out: (line: string) => void
}): void {
  const { port, token, migratedAgent, freshInstall, out } = args
  const options = buildAccessUrls({
    tailscaleIp: tailscaleIp(),
    lanIp: primaryLanIp(),
    port,
    token,
  })

  out('')
  out('2200 is ready.')
  out('')
  const primary = options[0]
  if (primary) {
    out(`  Open 2200 in your browser (${primary.label}):`)
    out(`  ${primary.href}`)
  }
  if (options.length > 1) {
    out('')
    out('  Also reachable:')
    for (const o of options.slice(1)) {
      out(`  ${o.href}  ${'(' + o.label + ')'}`)
    }
  }
  out('')
  if (migratedAgent) {
    out(`  Your migrated Agent "${migratedAgent}" is already there.`)
  } else if (freshInstall) {
    out('  The web app will walk you through creating your first Agent.')
  }
  out('')
  out(`  Bearer token (if a client asks for it): ${token}`)
  // Only relevant when we are advertising a non-loopback URL the user
  // might open from another device.
  if (options.some((o) => !o.href.includes('localhost'))) {
    out('')
    out("  Can't reach it from another device? Allow incoming connections for")
    out('  Node in your OS firewall (macOS: System Settings → Network → Firewall).')
  }
  out('')
}
