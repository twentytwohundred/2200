/**
 * UDS server side of the control-plane transport.
 *
 * Pairs with `uds-client.ts` (caller side) and `uds-connection.ts`
 * (shared connection). Splitting these into separate files lets bundles
 * that consume only the client side (the agent runtime, the CLI) not
 * pull `createServer` into their bundled output.
 */
import { createServer, type Server } from 'node:net'
import { chmod, mkdir, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Connection, Listener } from './transport.js'
import { UdsConnection } from './uds-connection.js'

class UdsListener implements Listener {
  private readonly pending: UdsConnection[] = []
  private resolveNext: ((conn: Connection | null) => void) | undefined
  private isClosed = false

  constructor(
    private readonly server: Server,
    private readonly socketPath: string,
  ) {
    server.on('connection', (socket) => {
      const conn = new UdsConnection(socket)
      if (this.resolveNext) {
        const r = this.resolveNext
        this.resolveNext = undefined
        r(conn)
      } else {
        this.pending.push(conn)
      }
    })
    server.on('close', () => {
      this.isClosed = true
      if (this.resolveNext) {
        const r = this.resolveNext
        this.resolveNext = undefined
        r(null)
      }
    })
  }

  async *connections(): AsyncIterable<Connection> {
    while (!this.isClosed) {
      const next = this.pending.shift()
      if (next) {
        yield next
        continue
      }
      const conn = await new Promise<Connection | null>((resolve) => {
        this.resolveNext = resolve
      })
      if (conn === null) return
      yield conn
    }
  }

  async close(): Promise<void> {
    if (this.isClosed) return
    this.isClosed = true
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve()
      })
    })
    try {
      await unlink(this.socketPath)
    } catch {
      // already gone
    }
  }
}

/**
 * Listen on a Unix domain socket at `socketPath`. Creates the parent dir
 * if needed and removes any stale socket file first. Sets the socket
 * file mode to `0600` after binding so only the current user can connect.
 */
export async function listenUds(socketPath: string): Promise<Listener> {
  await mkdir(dirname(socketPath), { recursive: true })
  try {
    await unlink(socketPath)
  } catch {
    // not present, fine
  }
  const server = createServer({ allowHalfOpen: false })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
  await chmod(socketPath, 0o600)
  return new UdsListener(server, socketPath)
}
