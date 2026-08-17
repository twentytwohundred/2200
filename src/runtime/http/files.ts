/**
 * Operator-facing file browsing over an Agent's directory tree.
 *
 * Agents have had a real filesystem since Epic 2 ... `/project`,
 * `/shared`, `/brain`, `/commons`, resolved by
 * `storage/path-resolver.ts` ... but nothing outside the Agent could
 * see it. An Agent would write a report to `/project/reports/q3.md`,
 * say so in chat, and that was the end of it: the operator had no way
 * to read the thing without shelling into the box. This module is the
 * read/write surface that closes that.
 *
 * **Containment.** Every path goes through `resolveVirtualPath` with
 * the target Agent as the calling agent, so the operator gets exactly
 * the same containment the Agent's own fs tools get: the four virtual
 * roots, no `..` traversal, no absolute paths, nothing outside
 * 2200_HOME. This surface deliberately does NOT reuse the Agent perm
 * evaluator ... that layer answers "may this Agent touch this path",
 * a different question from "may the operator look at their own
 * Agent's files". The operator can see everything in the Agent's tree.
 * Path containment is the property that matters here, and it comes
 * from the resolver.
 *
 * **Writes are narrower than reads.** `/brain` is readable here but
 * not writable: brain notes are mirrored into an FTS5 index, and a
 * raw write behind the index's back desyncs search. The brain has its
 * own editing API (`PATCH /agents/:name/brain/note/:slug`) that keeps
 * both in step, and pointing at it is better than quietly maintaining
 * a second write path with different semantics.
 */
import { readdir, readFile, stat, mkdir } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { atomicWriteFile } from '../util/atomic-write.js'
import { resolveVirtualPath, PathResolutionError } from '../storage/path-resolver.js'
import { badRequest, forbidden, notFound, type ApiError } from './errors.js'

/**
 * Roots offered in the browser, in display order. Kept explicit rather
 * than derived from the resolver's scope union: the resolver also
 * understands cross-agent forms (`/agents/<other>/shared`), which have
 * no place in a per-Agent file browser ... the operator switches Agent
 * in the UI instead.
 */
export const BROWSABLE_ROOTS = [
  {
    path: '/project',
    label: 'project',
    blurb: "The Agent's private working space.",
    writable: true,
  },
  {
    path: '/shared',
    label: 'shared',
    blurb: 'Readable by peer Agents.',
    writable: true,
  },
  {
    path: '/brain',
    label: 'brain',
    blurb: 'Memory notes. Edit these from the Brain screen so search stays in step.',
    writable: false,
  },
  {
    path: '/commons',
    label: 'commons',
    blurb: 'Shared across every Agent on this instance.',
    writable: true,
  },
] as const

/** Max entries returned in one tree walk. Guards against a runaway directory. */
export const MAX_TREE_ENTRIES = 2000
/** Max directory depth walked. Deeper subtrees are reported as truncated. */
export const MAX_TREE_DEPTH = 12
/** Files above this are download-only ... too big to hand to a browser editor. */
export const MAX_EDITABLE_BYTES = 1024 * 1024

export interface FileEntry {
  /** Virtual path, e.g. `/project/reports/q3.md`. */
  path: string
  name: string
  kind: 'file' | 'dir'
  /** Bytes. 0 for directories. */
  size: number
  /** ISO 8601 UTC mtime. */
  modified: string
  /** Present on directories only. Absent when the walk hit a depth or count cap. */
  children?: FileEntry[]
  /** True on a directory whose children were not walked (cap hit). */
  truncated?: boolean
}

export interface FileContent {
  path: string
  /** UTF-8 text. Null when the file is binary or too large to edit. */
  content: string | null
  size: number
  modified: string
  /** Why `content` is null, when it is. */
  reason: 'binary' | 'too_large' | null
  /** False for anything under a read-only root. */
  writable: boolean
}

/**
 * Resolve a virtual path for the named Agent, converting resolver
 * failures into API errors. Every entry point goes through here.
 */
function resolve(home: string, agent: string, virtualPath: string): { absolute: string } {
  try {
    return resolveVirtualPath(virtualPath, { home, callingAgent: agent })
  } catch (err) {
    if (err instanceof PathResolutionError) {
      throw badRequest(err.message, { path: virtualPath, code: err.code })
    }
    throw err
  }
}

/** True if the path sits under a root this surface allows writes to. */
export function isWritablePath(virtualPath: string): boolean {
  const root = BROWSABLE_ROOTS.find(
    (r) => virtualPath === r.path || virtualPath.startsWith(`${r.path}/`),
  )
  return root?.writable ?? false
}

/**
 * Heuristic text/binary split. A NUL byte in the first block is the
 * classic signal and it is good enough here: the consequence of a
 * false "binary" is a download instead of an inline editor, and the
 * consequence of a false "text" is mojibake in a textarea, neither of
 * which can corrupt anything on disk (the editor only writes what the
 * operator submits).
 */
export function looksBinary(buf: Buffer): boolean {
  const window = buf.subarray(0, 8000)
  for (const byte of window) {
    if (byte === 0) return true
  }
  return false
}

/**
 * Walk an Agent's tree from `rootPath` down. Returns entries sorted
 * directories-first then case-insensitively by name, which is what a
 * file browser reads as "in order".
 *
 * Symlinks are reported by whatever `stat` says they point at, and the
 * resolver has already confirmed the *path* is inside the Agent's
 * tree. A symlink whose target is outside is therefore readable here.
 * That is consistent with what the Agent's own fs tools do, and the
 * operator is the one who would have had to create it.
 */
export async function walkTree(
  home: string,
  agent: string,
  rootPath: string,
): Promise<{ path: string; entries: FileEntry[]; truncated: boolean }> {
  const { absolute } = resolve(home, agent, rootPath)
  let budget = MAX_TREE_ENTRIES
  let hitCap = false

  async function walk(absDir: string, virtualDir: string, depth: number): Promise<FileEntry[]> {
    let dirents
    try {
      dirents = await readdir(absDir, { withFileTypes: true })
    } catch {
      // Root not created yet (an Agent that has never written a file)
      // reads as empty, not as an error. Same for a race with a delete.
      return []
    }
    const out: FileEntry[] = []
    // Sort before walking so a cap truncates the tail, not an arbitrary
    // slice of it.
    dirents.sort((a, b) => {
      const aDir = a.isDirectory()
      const bDir = b.isDirectory()
      if (aDir !== bDir) return aDir ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
    for (const dirent of dirents) {
      if (budget <= 0) {
        hitCap = true
        break
      }
      // Dotfiles are runtime bookkeeping (`.rate-*.json` and friends),
      // not the Agent's work product.
      if (dirent.name.startsWith('.')) continue
      const abs = join(absDir, dirent.name)
      const virtual = posix.join(virtualDir, dirent.name)
      let st
      try {
        st = await stat(abs)
      } catch {
        continue // vanished mid-walk
      }
      budget -= 1
      if (st.isDirectory()) {
        if (depth >= MAX_TREE_DEPTH) {
          hitCap = true
          out.push({
            path: virtual,
            name: dirent.name,
            kind: 'dir',
            size: 0,
            modified: st.mtime.toISOString(),
            truncated: true,
          })
          continue
        }
        out.push({
          path: virtual,
          name: dirent.name,
          kind: 'dir',
          size: 0,
          modified: st.mtime.toISOString(),
          children: await walk(abs, virtual, depth + 1),
        })
      } else if (st.isFile()) {
        out.push({
          path: virtual,
          name: dirent.name,
          kind: 'file',
          size: st.size,
          modified: st.mtime.toISOString(),
        })
      }
    }
    return out
  }

  const entries = await walk(absolute, rootPath, 0)
  return { path: rootPath, entries, truncated: hitCap }
}

/** Read a file for display. Binary and oversized files come back with `content: null`. */
export async function readFileForDisplay(
  home: string,
  agent: string,
  virtualPath: string,
): Promise<FileContent> {
  const { absolute } = resolve(home, agent, virtualPath)
  let st
  try {
    st = await stat(absolute)
  } catch {
    throw notFound('file', virtualPath)
  }
  if (st.isDirectory()) {
    throw badRequest(`${virtualPath} is a directory`, { path: virtualPath })
  }
  const writable = isWritablePath(virtualPath)
  const base = {
    path: virtualPath,
    size: st.size,
    modified: st.mtime.toISOString(),
    writable,
  }
  if (st.size > MAX_EDITABLE_BYTES) {
    return { ...base, content: null, reason: 'too_large' }
  }
  const buf = await readFile(absolute)
  if (looksBinary(buf)) {
    return { ...base, content: null, reason: 'binary' }
  }
  return { ...base, content: buf.toString('utf8'), reason: null }
}

/** Read raw bytes for download. No size cap ... the browser streams it. */
export async function readFileRaw(
  home: string,
  agent: string,
  virtualPath: string,
): Promise<{ buffer: Buffer; filename: string }> {
  const { absolute } = resolve(home, agent, virtualPath)
  let st
  try {
    st = await stat(absolute)
  } catch {
    throw notFound('file', virtualPath)
  }
  if (!st.isFile()) {
    throw badRequest(`${virtualPath} is not a file`, { path: virtualPath })
  }
  return {
    buffer: await readFile(absolute),
    filename: posix.basename(virtualPath) || 'download',
  }
}

/**
 * Write operator-edited content back. Creates parent directories so a
 * new file can be added to a fresh subdirectory in one step, and uses
 * the same atomic temp+rename the Agent's own `fs_write` uses ... an
 * Agent reading the file mid-save sees either the old bytes or the new
 * ones, never a half-written file.
 */
export async function writeFileFromOperator(
  home: string,
  agent: string,
  virtualPath: string,
  content: string,
): Promise<{ path: string; size: number; modified: string }> {
  if (!isWritablePath(virtualPath)) {
    throw brainWriteRejected(virtualPath)
  }
  const { absolute } = resolve(home, agent, virtualPath)
  try {
    const st = await stat(absolute)
    if (st.isDirectory()) {
      throw badRequest(`${virtualPath} is a directory`, { path: virtualPath })
    }
  } catch (err) {
    // Not-found is fine ... this creates the file.
    if (err && typeof err === 'object' && 'status' in err) throw err
  }
  await mkdir(dirname(absolute), { recursive: true })
  await atomicWriteFile(absolute, content)
  const st = await stat(absolute)
  return { path: virtualPath, size: st.size, modified: st.mtime.toISOString() }
}

/**
 * Rejection for a write to a read-only root. Names the surface that
 * *can* do it rather than just saying no ... `/brain` writes have to
 * go through the brain API so the FTS index stays in step.
 */
function brainWriteRejected(virtualPath: string): ApiError {
  if (virtualPath === '/brain' || virtualPath.startsWith('/brain/')) {
    return forbidden(
      'Brain notes are edited from the Brain screen, which keeps the search index in step. ' +
        'Writing the markdown directly here would leave search stale.',
    )
  }
  return forbidden(
    `${virtualPath} is outside the writable roots ` +
      `(${BROWSABLE_ROOTS.filter((r) => r.writable)
        .map((r) => r.path)
        .join(', ')})`,
  )
}
