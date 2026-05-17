/**
 * In-memory mock transport for testing.
 *
 * `createMockPair()` produces a (server, client) pair of `Connection`s
 * connected back-to-back. Whatever one writes, the other reads. Useful for
 * unit tests of the JsonRpcServer and JsonRpcClient without starting a real
 * UDS or processes.
 */
import type { Connection, Listener } from './transport.js'

class Channel {
  private readonly buffer: string[] = []
  private waiters: ((line: string | null) => void)[] = []
  private isClosed = false

  push(line: string): void {
    if (this.isClosed) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter(line)
    } else {
      this.buffer.push(line)
    }
  }

  pull(): Promise<string | null> {
    const head = this.buffer.shift()
    if (head !== undefined) {
      return Promise.resolve(head)
    }
    if (this.isClosed) {
      return Promise.resolve(null)
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve)
    })
  }

  close(): void {
    if (this.isClosed) return
    this.isClosed = true
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()
      w?.(null)
    }
  }

  get closed(): boolean {
    return this.isClosed
  }
}

class MockConnection implements Connection {
  constructor(
    private readonly inbound: Channel,
    private readonly outbound: Channel,
    private readonly onClose: () => void,
  ) {}

  async *read(): AsyncIterable<string> {
    for (;;) {
      const line = await this.inbound.pull()
      if (line === null) return
      yield line
    }
  }

  write(line: string): Promise<void> {
    if (this.outbound.closed) {
      return Promise.reject(new Error('connection closed'))
    }
    this.outbound.push(line)
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.onClose()
    return Promise.resolve()
  }

  get closed(): boolean {
    return this.inbound.closed && this.outbound.closed
  }
}

/**
 * Produce a (server-side, client-side) connection pair. Whatever the client
 * writes, the server reads, and vice versa. Closing either end closes both.
 */
export function createMockPair(): { server: Connection; client: Connection } {
  const aToB = new Channel()
  const bToA = new Channel()
  const closeBoth = (): void => {
    aToB.close()
    bToA.close()
  }
  return {
    server: new MockConnection(aToB, bToA, closeBoth),
    client: new MockConnection(bToA, aToB, closeBoth),
  }
}

/**
 * In-memory listener for unit tests. Tests call `accept()` to get the server
 * end of a freshly-created pair, and the returned client end can be used by
 * test code to drive the server.
 */
export class MockListener implements Listener {
  private readonly pending: { server: Connection; client: Connection }[] = []
  private resolveNext: ((conn: Connection | null) => void) | undefined
  private isClosed = false

  /**
   * Create a new connection pair, queue the server end for the listener to
   * yield, and return the client end for the test to drive.
   */
  newClient(): Connection {
    const pair = createMockPair()
    if (this.resolveNext) {
      const r = this.resolveNext
      this.resolveNext = undefined
      r(pair.server)
    } else {
      this.pending.push(pair)
    }
    return pair.client
  }

  async *connections(): AsyncIterable<Connection> {
    while (!this.isClosed) {
      const next = this.pending.shift()
      if (next) {
        yield next.server
        continue
      }
      const conn = await new Promise<Connection | null>((resolve) => {
        this.resolveNext = resolve
      })
      if (conn === null) return
      yield conn
    }
  }

  close(): Promise<void> {
    this.isClosed = true
    if (this.resolveNext) {
      const r = this.resolveNext
      this.resolveNext = undefined
      r(null)
    }
    return Promise.resolve()
  }
}
