/**
 * Unix domain socket transport for the control-plane.
 *
 * Implements the `Connection` and `Listener` shapes from `transport.ts` over
 * Node's `net` module. The socket file is created with mode `0600` (owner-only)
 * so filesystem permissions act as the access boundary; no auth tokens at v1.
 *
 * NDJSON framing: each message is one line, terminated by `\n`. The reader
 * buffers partial lines across chunk boundaries and yields complete lines
 * only.
 */
import type { Socket } from 'node:net'
import { createServer, type Server } from 'node:net'
import { createConnection } from 'node:net'
import { chmod, mkdir, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Connection, Listener } from './transport.js'

class UdsConnection implements Connection {
  private isClosed = false
  private readBuffer = ''
  private readonly readQueue: string[] = []
  private readonly readWaiters: ((line: string | null) => void)[] = []

  constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      this.readBuffer += chunk
      let idx
      while ((idx = this.readBuffer.indexOf('\n')) !== -1) {
        const line = this.readBuffer.slice(0, idx)
        this.readBuffer = this.readBuffer.slice(idx + 1)
        this.deliverLine(line)
      }
    })
    socket.on('end', () => {
      this.markClosed()
    })
    socket.on('close', () => {
      this.markClosed()
    })
    socket.on('error', () => {
      this.markClosed()
    })
  }

  private deliverLine(line: string): void {
    const waiter = this.readWaiters.shift()
    if (waiter) {
      waiter(line)
    } else {
      this.readQueue.push(line)
    }
  }

  private markClosed(): void {
    if (this.isClosed) return
    this.isClosed = true
    while (this.readWaiters.length > 0) {
      const w = this.readWaiters.shift()
      w?.(null)
    }
  }

  async *read(): AsyncIterable<string> {
    for (;;) {
      const queued = this.readQueue.shift()
      if (queued !== undefined) {
        yield queued
        continue
      }
      if (this.isClosed) return
      const line = await new Promise<string | null>((resolve) => {
        this.readWaiters.push(resolve)
      })
      if (line === null) return
      yield line
    }
  }

  async write(line: string): Promise<void> {
    if (this.isClosed) {
      throw new Error('connection closed')
    }
    return new Promise((resolve, reject) => {
      this.socket.write(line + '\n', (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  async close(): Promise<void> {
    if (this.isClosed) return
    this.markClosed()
    return new Promise((resolve) => {
      this.socket.end(() => {
        this.socket.destroy()
        resolve()
      })
    })
  }

  get closed(): boolean {
    return this.isClosed
  }
}

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
    // Unlink the socket file so a subsequent listen on the same path does
    // not see a stale entry. Best-effort: if it's already gone, ignore.
    try {
      await unlink(this.socketPath)
    } catch {
      // already gone
    }
  }
}

/**
 * Listen on a Unix domain socket at `socketPath`. Creates the parent dir if
 * needed and removes any stale socket file first. Sets the socket file mode
 * to `0600` after binding so only the current user can connect.
 */
export async function listenUds(socketPath: string): Promise<Listener> {
  await mkdir(dirname(socketPath), { recursive: true })
  // Remove stale socket from a previous run; rename-and-replace would also
  // work but unlink-and-bind is the standard pattern for UDS.
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
  // Restrict who can connect.
  await chmod(socketPath, 0o600)
  return new UdsListener(server, socketPath)
}

/** Connect to a UDS at `socketPath`. */
export async function connectUds(socketPath: string): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath, () => {
      resolve(new UdsConnection(socket))
    })
    socket.once('error', (err) => {
      reject(err)
    })
  })
}
