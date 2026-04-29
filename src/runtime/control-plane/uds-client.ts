/**
 * UDS client side of the control-plane transport.
 *
 * Pairs with `uds-server.ts` (server side) and `uds-connection.ts`
 * (shared connection). Splitting these into separate files lets bundles
 * that consume only the client side not pull `createServer` into their
 * bundled output.
 */
import { createConnection } from 'node:net'
import type { Connection } from './transport.js'
import { UdsConnection } from './uds-connection.js'

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
