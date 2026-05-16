/**
 * Connector gateway manager.
 *
 * Spawns + supervises the long-lived gateway processes a connector
 * Extension declares via `hooks.gateway`. One manager per running
 * gateway; in-memory tracking keyed by extension id.
 *
 * v1 scope: one gateway per Extension (no multi-account fan-out yet).
 * The gateway runs as a child process with env vars derived from the
 * supervisor's home + a freshly-allocated TCP port for outbound.
 *
 * Decision: [[../../decisions/2026-05-16-connector-extensions]]
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

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
    },
  ) {}

  /** True when the named gateway has an active child process. */
  isRunning(extensionId: string): boolean {
    return this.gateways.has(extensionId)
  }

  /**
   * Spawn the gateway script declared by the Extension's manifest.
   * No-op if already running. Returns the handle of the running
   * gateway. Throws if the manifest is missing or `hooks.gateway` is
   * not declared.
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
    const extensionDir = join(this.opts.home, 'extensions', extensionId)
    const manifestText = await readFile(join(extensionDir, 'manifest.json'), 'utf-8')
    const manifest = JSON.parse(manifestText) as {
      hooks?: { gateway?: { script?: string } }
    }
    const script = manifest.hooks?.gateway?.script
    if (!script) {
      throw new Error(`extension ${extensionId} declares no hooks.gateway in its manifest`)
    }
    const scriptPath = join(extensionDir, script)
    const port = await allocPort()
    const stateDir = join(this.opts.home, 'state', 'extensions', extensionId)
    const authDir = join(stateDir, 'auth', 'default')
    const gatewayInfoPath = join(stateDir, 'gateway.json')

    // tsx is the dev runner; the gateway's package.json names it as a
    // dev dep. For production npm-installed packages, the gateway
    // would ship compiled JS and we'd invoke node directly. For v1
    // dev: tsx works against the .ts source.
    const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
    const tsxPath = join(repoRoot, 'node_modules', '.bin', 'tsx')
    const child = spawn(tsxPath, [scriptPath], {
      cwd: extensionDir,
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
    if (!child.pid) {
      throw new Error(`failed to spawn gateway for ${extensionId}`)
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
      // v1: no auto-respawn ... the operator's next pair-start click
      // will spawn again. Respawn budget + crash-loop detection lands
      // alongside the production gateway lifecycle work.
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
    // Best-effort wait for the child to exit; force-kill after 5s.
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
