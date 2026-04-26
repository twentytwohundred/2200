/**
 * Transport abstraction for the control-plane.
 *
 * The JsonRpcServer and JsonRpcClient are transport-agnostic: they read from
 * a stream of newline-delimited JSON messages and write the same. The
 * transport implementations connect that stream to an actual byte channel
 * (Unix socket, in-memory pair, mock for tests).
 *
 * Both ends of a connection see the same shape: a `read` async iterator of
 * incoming text lines, a `write` function for outgoing lines, and a `close`
 * to tear down. NDJSON framing means each message is one line; the transport
 * is responsible for line buffering on the read side.
 */

/**
 * One end of a control-plane connection. Lines do NOT include the trailing
 * newline; the implementation appends it on write and strips it on read.
 */
export interface Connection {
  /** Async iterator yielding lines of NDJSON. Closes when the peer disconnects. */
  read(): AsyncIterable<string>
  /** Write a single line. Implementations append the newline. */
  write(line: string): Promise<void>
  /** Close the connection cleanly. Idempotent. */
  close(): Promise<void>
  /** True after `close()` has been called or the peer has disconnected. */
  readonly closed: boolean
}

/**
 * Server-side listener that produces incoming `Connection`s.
 */
export interface Listener {
  /** Async iterator yielding new connections as clients arrive. */
  connections(): AsyncIterable<Connection>
  /** Stop accepting new connections; existing ones are NOT closed. Idempotent. */
  close(): Promise<void>
}
