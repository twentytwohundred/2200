/**
 * Connector gateway manager.
 *
 * Spawns + supervises the long-lived gateway processes a connector
 * Extension declares via `hooks.gateway`. One manager per running
 * gateway; in-memory tracking keyed by extension id.
 *
 * Source resolution:
 * - For catalog entries with `source.type === 'workspace'` (dev mode),
 *   the gateway runs from the workspace path (where pnpm has installed
 *   its dependencies, including `tsx` for the .ts entry). The catalog
 *   entry is the source of truth for where to find the workspace.
 * - For `source.type === 'npm'` (production), the published package
 *   would ship a compiled JS bundle; we'd invoke `node` against it
 *   directly. Not yet implemented; throws on attempt.
 *
 * Decision: [[../../decisions/2026-05-16-connector-extensions]]
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { join, dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { loadCatalog } from '../extensions/catalog.js'

export interface GatewayHandle {
  extension_id: string
  pid: number
  port: number
  started_at: string
}

interface ManagedGateway extends GatewayHandle {
  child: ChildProcess
  shuttingDown: boolean
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

  /** True when the named gateway has an active child process. */
  isRunning(extensionId: string): boolean {
    return this.gateways.has(extensionId)
  }

  /**
   * Spawn the gateway for the named Extension. No-op if already
   * running. Returns the handle of the running gateway. Throws with a
   * descriptive message on failure ... the supervisor's caller wraps
   * the throw in an HTTP 500 with the message, never crashes.
   */
  async start(extensionId: string): Promise<GatewayHandle> {
    const existing = this.gateways.get(extensionId)
    if (existing) {
      return {
        extension_id: existing.extension_id,
        pid: existing.pid,
        port: existing.port,
        started_at: existing.started_at,
      }
    }
    const catalog = await loadCatalog(this.opts.catalogPath)
    const entry = catalog.extensions.find((e) => e.id === extensionId)
    if (!entry) {
      throw new Error(`catalog has no entry for "${extensionId}"`)
    }
    if (entry.source.type !== 'workspace') {
      // npm-source spawn ships with the publish pipeline; we'd locate the
      // installed package's compiled entry and run `node` against it.
      throw new Error(
        `gateway spawn for source.type="${entry.source.type}" not implemented yet; use workspace source for dev`,
      )
    }
    // Workspace mode: the dev source is at <repo>/<source.path>. The
    // gateway runs from there so pnpm-installed deps (Baileys, tsx, etc)
    // are available in its node_modules.
    const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
    const workspaceDir = resolvePath(repoRoot, entry.source.path)
    const tsxPath = join(workspaceDir, 'node_modules', '.bin', 'tsx')
    if (!existsSync(tsxPath)) {
      throw new Error(
        `tsx not found at ${tsxPath}; run \`pnpm install\` in ${entry.source.path}`,
      )
    }
    // Load the manifest from the workspace to find the gateway script.
    const { readFile } = await import('node:fs/promises')
    const manifestText = await readFile(join(workspaceDir, 'manifest.json'), 'utf-8')
    const manifest = JSON.parse(manifestText) as {
      hooks?: { gateway?: { script?: string } }
    }
    const script = manifest.hooks?.gateway?.script
    if (!script) {
      throw new Error(`extension ${extensionId} declares no hooks.gateway in its manifest`)
    }
    const scriptPath = join(workspaceDir, script)
    if (!existsSync(scriptPath)) {
      throw new Error(`gateway script not found at ${scriptPath}`)
    }
    const port = await allocPort()
    const stateDir = join(this.opts.home, 'state', 'extensions', extensionId)
    const authDir = join(stateDir, 'auth', 'default')
    const gatewayInfoPath = join(stateDir, 'gateway.json')

    const child = spawn(tsxPath, [scriptPath], {
      cwd: workspaceDir,
      env: {
        ...process.env,
        SUPERVISOR_URL: this.opts.supervisorUrl,
        GATEWAY_PORT: String(port),
        AUTH_DIR: authDir,
        GATEWAY_INFO_PATH: gatewayInfoPath,
        CONNECTOR_ACCOUNT: 'default',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    // Attach the 'error' handler BEFORE doing anything else with the
    // child. Node's ChildProcess emits 'error' on spawn-failure
    // (ENOENT, EACCES) and that event becomes an uncaught exception
    // that crashes the supervisor if unhandled. v1: log + leave the
    // gateways map untouched so a retry can try again.
    const spawnState: { failure: Error | null } = { failure: null }
    child.on('error', (err) => {
      spawnState.failure = err
      process.stderr.write(`[gateway/${extensionId}] spawn error: ${err.message}\n`)
      this.gateways.delete(extensionId)
    })

    if (!child.pid) {
      // No pid means spawn failed synchronously OR the 'error' event
      // fired immediately. Wait one tick for the error handler to run.
      await new Promise((r) => setImmediate(r))
      if (spawnState.failure) {
        throw new Error(`gateway spawn failed: ${spawnState.failure.message}`)
      }
      throw new Error(`failed to spawn gateway for ${extensionId} (no pid, no error)`)
    }

    const managed: ManagedGateway = {
      extension_id: extensionId,
      pid: child.pid,
      port,
      started_at: new Date().toISOString(),
      child,
      shuttingDown: false,
    }
    this.gateways.set(extensionId, managed)

    child.stdout.on('data', (chunk: Buffer) => {
      process.stderr.write(`[gateway/${extensionId}] ${chunk.toString('utf-8')}`)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(`[gateway/${extensionId}] ${chunk.toString('utf-8')}`)
    })
    child.on('exit', (code) => {
      const wasShutdown = managed.shuttingDown
      this.gateways.delete(extensionId)
      process.stderr.write(
        `[gateway/${extensionId}] exited code=${String(code)} intentional=${String(wasShutdown)}\n`,
      )
      // v1: no auto-respawn ... operator's next pair-start click will
      // try again. Respawn budget + crash-loop detection lands with
      // the production gateway lifecycle work.
    })
    return {
      extension_id: extensionId,
      pid: managed.pid,
      port: managed.port,
      started_at: managed.started_at,
    }
  }

  async stop(extensionId: string): Promise<void> {
    const managed = this.gateways.get(extensionId)
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
    this.gateways.delete(extensionId)
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.gateways.keys()].map((id) => this.stop(id)))
  }

  list(): GatewayHandle[] {
    return [...this.gateways.values()].map((g) => ({
      extension_id: g.extension_id,
      pid: g.pid,
      port: g.port,
      started_at: g.started_at,
    }))
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
