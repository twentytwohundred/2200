/**
 * Shared UDS connection wrapper used by both the server (`uds-server.ts`)
 * and client (`uds-client.ts`) sides of the control-plane transport.
 *
 * Lives in its own file so a bundle that only consumes one side does not
 * pull in the other side's `node:net` import (avoids leftover unused
 * import declarations in the bundled output).
 *
 * NDJSON framing: each message is one line, terminated by `\n`. Reader
 * buffers partial lines across chunk boundaries and yields complete
 * lines only.
 */
import type { Socket } from 'node:net'
import type { Connection } from './transport.js'

export class UdsConnection implements Connection {
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
      this.socket.write(`${line}\n`, (err) => {
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
