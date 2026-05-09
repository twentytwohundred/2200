/**
 * Per-Agent BrainIndex cache.
 *
 * One BrainIndex per Agent, kept warm for the duration of the
 * Agent's process. The brain.* MCP tools call into this registry
 * to resolve an agent name to an open SQLite handle without paying
 * the open-and-rebuild cost on every tool call.
 *
 * Module-level singleton for v1: each Agent runs in its own OS
 * process (per CLAUDE.md "Agent-as-process"), so the singleton is
 * implicitly per-Agent.
 *
 * The first call for a given agent triggers a one-shot reconcile:
 * if the DB was empty (newly created or wiped), populate it from
 * the markdown files on disk so the index reflects current state.
 * Subsequent writes through the brain.* tools keep it in sync.
 */
import { BrainIndex } from './index-db.js'
import { BrainStore } from './store.js'

interface CachedBrain {
  index: BrainIndex
  store: BrainStore
}

const cache = new Map<string, CachedBrain>()

function key(home: string, agentName: string): string {
  return `${home}::${agentName}`
}

export async function getOrOpenBrain(home: string, agentName: string): Promise<CachedBrain> {
  const k = key(home, agentName)
  let entry = cache.get(k)
  if (entry) return entry
  const index = BrainIndex.open(home, agentName)
  const store = new BrainStore(home, agentName)
  if (index.size() === 0) {
    const notes = await store.list({ limit: 100_000 })
    if (notes.length > 0) index.rebuildFrom(notes)
  }
  entry = { index, store }
  cache.set(k, entry)
  return entry
}

/**
 * Open the shared brain (`<home>/shared/brain/`) and return a cached
 * handle. The shared brain is a single store/index for the whole
 * instance; everyone reads it; agents can write to it via the
 * `brain_write_shared` baseline tool.
 *
 * Cache key uses a sentinel agent name "__shared__" so the per-agent
 * cache map can carry both kinds of handles without a second map.
 */
const SHARED_KEY = '__shared__'

export async function getOrOpenSharedBrain(home: string): Promise<CachedBrain> {
  const k = key(home, SHARED_KEY)
  let entry = cache.get(k)
  if (entry) return entry
  const index = BrainIndex.openShared(home)
  const store = BrainStore.forShared(home)
  if (index.size() === 0) {
    const notes = await store.list({ limit: 100_000 })
    if (notes.length > 0) index.rebuildFrom(notes)
  }
  entry = { index, store }
  cache.set(k, entry)
  return entry
}

/** Test/teardown helper. Closes and forgets the cached entry. */
export function closeBrain(home: string, agentName: string): void {
  const k = key(home, agentName)
  const entry = cache.get(k)
  if (!entry) return
  entry.index.close()
  cache.delete(k)
}

/** Test/teardown helper. Closes every cached brain. */
export function closeAllBrains(): void {
  for (const entry of cache.values()) entry.index.close()
  cache.clear()
}
