/**
 * Free-port allocation.
 *
 * Used by the supervisor when creating a pub: the supervisor binds a
 * fresh ephemeral port, captures the OS-assigned number, releases it,
 * and hands the number to the spawned `openpub-server` child to bind
 * itself.
 *
 * Race window: between the supervisor releasing the port and the
 * child binding it, a third party could grab the same port. For v1
 * the supervisor is the only thing allocating ports for pub-servers
 * on this box, so the window is acceptable. If the race surfaces in
 * practice, the next iteration retries with a fresh allocation.
 */
import { createServer } from 'node:net'

/**
 * Allocate a free TCP port by binding ephemeral, reading the assigned
 * port, and releasing. Returns the port number.
 *
 * Throws if the bind fails or the OS does not report a numeric port
 * (which should not happen on POSIX or Windows under Node).
 */
export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') {
        srv.close()
        reject(new Error(`unexpected server address shape: ${String(addr)}`))
        return
      }
      const port = addr.port
      srv.close((err) => {
        if (err) reject(err)
        else resolve(port)
      })
    })
  })
}
