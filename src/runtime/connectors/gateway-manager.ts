/**
 * Connector gateway manager.
 *
 * Starts + supervises the long-lived gateway processes a connector
 * Extension declares via `hooks.gateway`. The manager handles BOTH
 * identity scopes from the connector catalog:
 *
 * - `account_scope: 'extension'` (WhatsApp Inbox): one gateway per
 *   Extension. The key is `${extension_id}::_extension`.
 * - `account_scope: 'agent'` (Discord, Telegram, Slack): one gateway
 *   per Agent. The key is `${extension_id}::${agent_name}`.
 *
 * For per-Agent scope, the manager reads the Agent's connector
 * binding to find credential names, unseals them from the per-Agent
 * vault, and injects them into the gateway child's env. The token
 * never lives in the Identity file or any operator-visible surface.
 *
 * Decisions:
 *   - [[../../decisions/2026-05-16-connector-extensions]]
 *   - [[../../decisions/2026-05-16-connector-per-agent-identity]]
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CredentialVault } from '../credentials/vault.js'
import { loadCatalog, type CatalogEntry } from '../extensions/catalog.js'
import { loadIdentity } from '../identity/loader.js'
import { agentPaths } from '../storage/layout.js'

export interface GatewayHandle {
  extension_id: string
  agent_name: string | null
  pid: number
  port: number
  started_at: string
}

interface ManagedGateway extends Omit<GatewayHandle, 'agent_name'> {
  agent_name: string | null
  child: ChildProcess
  shuttingDown: boolean
}

/** Compose the gateway map key from extension + agent (null for extension-scope). */
function keyFor(extensionId: string, agentName: string | null): string {
  return `${extensionId}::${agentName ?? '_extension'}`
}

export class GatewayManager {
  private readonly gateways = new Map<string, ManagedGateway>()

  constructor(
    private readonly opts: {
      home: string
      supervisorUrl: string
      catalogPath: string
    },
  ) {}

  isRunning(extensionId: string, agentName: string | null): boolean {
    return this.gateways.has(keyFor(extensionId, agentName))
  }

  /**
   * Start the gateway. For per-Extension scope, pass `agentName: null`.
   * For per-Agent scope, pass the agent name; the manager reads the
   * Agent's binding, unseals credentials from vault, and injects them
   * into the gateway's env. Throws with a clear message on failure;
   * caller wraps in HTTP 500.
   */
  async start(extensionId: string, agentName: string | null): Promise<GatewayHandle> {
    const key = keyFor(extensionId, agentName)
    const existing = this.gateways.get(key)
    if (existing) {
      return {
        extension_id: existing.extension_id,
        agent_name: existing.agent_name,
        pid: existing.pid,
        port: existing.port,
        started_at: existing.started_at,
      }
    }
    const catalog = await loadCatalog(this.opts.catalogPath)
    const entry = catalog.extensions.find((e) => e.id === extensionId)
    if (!entry) throw new Error(`catalog has no entry for "${extensionId}"`)
    if (entry.source.type !== 'workspace') {
      throw new Error(
        `gateway start for source.type="${entry.source.type}" not implemented yet; use workspace source for dev`,
      )
    }
    const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
    const workspaceDir = resolvePath(repoRoot, entry.source.path)
    const tsxPath = join(workspaceDir, 'node_modules', '.bin', 'tsx')
    if (!existsSync(tsxPath)) {
      throw new Error(`tsx not found at ${tsxPath}; run \`pnpm install\` in ${entry.source.path}`)
    }
    const { readFile } = await import('node:fs/promises')
    const manifestText = await readFile(join(workspaceDir, 'manifest.json'), 'utf-8')
    const manifest = JSON.parse(manifestText) as {
      hooks?: { gateway?: { script?: string } }
    }
    const scriptRel = manifest.hooks?.gateway?.script
    if (!scriptRel) {
      throw new Error(`extension ${extensionId} declares no hooks.gateway in its manifest`)
    }
    const scriptPath = join(workspaceDir, scriptRel)
    if (!existsSync(scriptPath)) {
      throw new Error(`gateway script not found at ${scriptPath}`)
    }
    const port = await allocPort()
    const credentialEnv = await this.resolveCredentialEnv(entry, agentName)
    const stateBase = agentName
      ? join(this.opts.home, 'state', 'extensions', extensionId, 'agents', agentName)
      : join(this.opts.home, 'state', 'extensions', extensionId)
    const authDir = join(stateBase, 'auth', 'default')
    const gatewayInfoPath = join(stateBase, 'gateway.json')

    const env: Record<string, string | undefined> = {
      ...process.env,
      SUPERVISOR_URL: this.opts.supervisorUrl,
      GATEWAY_PORT: String(port),
      AUTH_DIR: authDir,
      GATEWAY_INFO_PATH: gatewayInfoPath,
      CONNECTOR_ID: extensionId,
      CONNECTOR_ACCOUNT: agentName ?? 'default',
      ...(agentName ? { AGENT_NAME: agentName } : {}),
      ...credentialEnv,
    }

    const child = spawn(tsxPath, [scriptPath], {
      cwd: workspaceDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const launchState: { failure: Error | null } = { failure: null }
    child.on('error', (err) => {
      launchState.failure = err
      process.stderr.write(`[gateway/${key}] launch error: ${err.message}\n`)
      this.gateways.delete(key)
    })

    if (!child.pid) {
      await new Promise((r) => setImmediate(r))
      if (launchState.failure) {
        throw new Error(`gateway launch failed: ${launchState.failure.message}`)
      }
      throw new Error(`failed to launch gateway ${key} (no pid, no error)`)
    }

    const managed: ManagedGateway = {
      extension_id: extensionId,
      agent_name: agentName,
      pid: child.pid,
      port,
      started_at: new Date().toISOString(),
      child,
      shuttingDown: false,
    }
    this.gateways.set(key, managed)

    child.stdout.on('data', (chunk: Buffer) => {
      process.stderr.write(`[gateway/${key}] ${chunk.toString('utf-8')}`)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(`[gateway/${key}] ${chunk.toString('utf-8')}`)
    })
    child.on('exit', (code) => {
      const wasShutdown = managed.shuttingDown
      this.gateways.delete(key)
      process.stderr.write(
        `[gateway/${key}] exited code=${String(code)} intentional=${String(wasShutdown)}\n`,
      )
    })
    return {
      extension_id: extensionId,
      agent_name: agentName,
      pid: managed.pid,
      port: managed.port,
      started_at: managed.started_at,
    }
  }

  async stop(extensionId: string, agentName: string | null): Promise<void> {
    const key = keyFor(extensionId, agentName)
    const managed = this.gateways.get(key)
    if (!managed) return
    managed.shuttingDown = true
    managed.child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        managed.child.kill('SIGKILL')
        resolve()
      }, 5_000)
      managed.child.on('exit', () => {
        clearTimeout(t)
        resolve()
      })
    })
    this.gateways.delete(key)
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.gateways.values()].map((g) => this.stop(g.extension_id, g.agent_name)),
    )
  }

  list(): GatewayHandle[] {
    return [...this.gateways.values()].map((g) => ({
      extension_id: g.extension_id,
      agent_name: g.agent_name,
      pid: g.pid,
      port: g.port,
      started_at: g.started_at,
    }))
  }

  /**
   * Resolve per-binding credentials from the Agent's vault into env
   * vars the gateway can read. For Discord the env name is
   * `DISCORD_BOT_TOKEN`; for any connector, the convention is
   * `${CONNECTOR_ID}_${BINDING_KEY}` upper-cased.
   *
   * For per-Extension scope (agentName === null), credentials are
   * not supported (the connector pairs an account, not a per-Agent
   * identity); returns empty.
   */
  private async resolveCredentialEnv(
    entry: CatalogEntry,
    agentName: string | null,
  ): Promise<Record<string, string>> {
    if (agentName === null) return {}
    const id = await loadIdentity(agentPaths(this.opts.home, agentName).identity)
    const binding = id.frontmatter.connectors.find((b) => b.connector_id === entry.id)
    if (!binding) {
      throw new Error(
        `Agent "${agentName}" has no connector binding for "${entry.id}"; nothing to start`,
      )
    }
    const env: Record<string, string> = {}
    const vault = new CredentialVault(this.opts.home, agentName)
    for (const [bindingKey, credentialName] of Object.entries(binding.credentials)) {
      try {
        const sealed = await vault.get(credentialName)
        const envName = `${entry.id.toUpperCase()}_${bindingKey.toUpperCase()}`
        env[envName] = sealed.value
      } catch (err) {
        throw new Error(
          `failed to read vault credential "${credentialName}" for agent "${agentName}": ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    return env
  }
}

/** Allocate an ephemeral local TCP port by binding-then-closing. */
async function allocPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      srv.close(() => {
        if (typeof addr === 'object' && addr && typeof addr.port === 'number') {
          resolve(addr.port)
        } else {
          reject(new Error('failed to allocate port'))
        }
      })
    })
  })
}
