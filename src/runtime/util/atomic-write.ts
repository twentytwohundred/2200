/**
 * Atomic file writes via temp-and-rename.
 *
 * Why this exists: state-on-disk discipline (upgrade-readiness #2) requires
 * that any write that should survive a crash either fully lands or does not
 * land at all. Naive `fs.writeFile` can leave a torn file if the process
 * crashes mid-write. This module provides the atomic alternative: write to
 * `<path>.tmp.<rand>`, fsync, rename to `<path>`. POSIX rename is atomic on
 * the same filesystem, so readers either see the previous content or the new
 * content, never a half-written file.
 *
 * The `<rand>` suffix prevents collisions when two processes attempt atomic
 * writes to the same target concurrently (each writes its own temp, last
 * rename wins; neither sees a torn intermediate).
 */
import { randomBytes } from 'node:crypto'
import { open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Atomically write `data` to `path`. Creates parent directories implicitly is
 * NOT supported here: callers ensure the directory exists before calling.
 *
 * Throws on any I/O error. The temp file is best-effort cleaned up on failure.
 */
export async function atomicWriteFile(path: string, data: string | Uint8Array): Promise<void> {
  const tmpSuffix = randomBytes(6).toString('hex')
  const tmpPath = `${path}.tmp.${tmpSuffix}`

  let handle
  try {
    handle = await open(tmpPath, 'wx')
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(tmpPath, path)
  } catch (err) {
    if (handle) {
      try {
        await handle.close()
      } catch {
        // best-effort
      }
    }
    try {
      await unlink(tmpPath)
    } catch {
      // best-effort
    }
    throw err
  }
}

/**
 * Atomically write JSON to `path`. Convenience wrapper around `atomicWriteFile`
 * with `JSON.stringify(data, null, 2)`.
 */
export async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  await atomicWriteFile(path, JSON.stringify(data, null, 2) + '\n')
}

/**
 * Get the directory portion of a path.
 *
 * Re-exported for callers who would otherwise import `node:path` themselves.
 */
export function dirOf(path: string): string {
  return dirname(path)
}
