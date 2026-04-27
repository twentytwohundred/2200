/**
 * Per-Agent PubClient cache.
 *
 * One PubClient per (Agent, pub) pair, kept warm for the duration of
 * the Agent's process. The pub MCP tools call into this registry to
 * resolve a pub_name to a connected client without paying the
 * connect+auth cost on every tool call.
 *
 * Module-level singleton for v1: each Agent runs in its own OS
 * process (per CLAUDE.md "Agent-as-process"), so the singleton is
 * implicitly per-Agent. When PR D's wake source needs to subscribe
 * to pub events, it goes through the same registry.
 */
import { PubClient, type PubClientOptions } from './client.js'

interface CacheKey {
  agentName: string
  pubName: string
}

const clients = new Map<string, PubClient>()

function key(k: CacheKey): string {
  return `${k.agentName}::${k.pubName}`
}

/**
 * Get-or-create a PubClient for the given (agent, pub) pair. The
 * caller passes the options; on cache hit, options are ignored
 * (the existing connection wins). On cache miss, a fresh PubClient
 * is constructed but `connect()` is NOT called — the caller decides
 * when to await the connect.
 */
export function getOrCreatePubClient(
  agentName: string,
  pubName: string,
  opts: PubClientOptions,
): PubClient {
  const k = key({ agentName, pubName })
  let client = clients.get(k)
  if (!client) {
    client = new PubClient(opts)
    clients.set(k, client)
  }
  return client
}

/**
 * Drop the cached client for one (agent, pub) pair. Used by tests
 * for isolation; production callers rarely need this since
 * `client.close()` cleans up the WebSocket and the cache entry can
 * stay dormant.
 */
export async function evictPubClient(agentName: string, pubName: string): Promise<void> {
  const k = key({ agentName, pubName })
  const client = clients.get(k)
  if (!client) return
  clients.delete(k)
  try {
    await client.close()
  } catch {
    // best-effort
  }
}

/** Drop all cached clients. Used by tests for isolation. */
export async function evictAllPubClients(): Promise<void> {
  const all = Array.from(clients.entries())
  clients.clear()
  await Promise.all(
    all.map(async ([, client]) => {
      try {
        await client.close()
      } catch {
        // best-effort
      }
    }),
  )
}
