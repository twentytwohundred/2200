/**
 * fs.* baseline tools (read, write, edit, list, delete).
 *
 * Per [[2026-04-25-tool-baseline]], the fs tools operate inside the
 * Agent's project directory and the four virtual prefixes (commons,
 * shared, project, brain). The dispatcher resolves virtual paths
 * before calling execute(); tools always receive absolute paths.
 *
 * Idempotency categories (locked):
 *   fs.read, fs.list  -> pure
 *   fs.write, fs.edit -> checkpointed (rewriting same content is a no-op)
 *   fs.delete         -> destructive (irreversibility forces caution)
 */
import { mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { atomicWriteFile } from '../../util/atomic-write.js'
import { defineTool, type ToolDefinition } from '../../mcp/tool.js'

// ---------------------------------------------------------------------------
// fs.read
// ---------------------------------------------------------------------------

const FsReadArgsSchema = z.object({
  path: z.string().min(1),
})

export const fsRead = defineTool({
  name: 'fs_read',
  description: 'Read a file. Returns its UTF-8 contents.',
  idempotency: 'pure',
  argsSchema: FsReadArgsSchema,
  pathArgs: [{ argName: 'path', operation: 'read' }],
  execute: async (args) => {
    const content = await readFile(args.path, 'utf8')
    return { content }
  },
})

// ---------------------------------------------------------------------------
// fs.write
// ---------------------------------------------------------------------------

const FsWriteArgsSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
})

export const fsWrite = defineTool({
  name: 'fs_write',
  description: 'Write a file. Atomic via temp+rename. Creates parent dirs.',
  idempotency: 'checkpointed',
  argsSchema: FsWriteArgsSchema,
  pathArgs: [{ argName: 'path', operation: 'write' }],
  execute: async (args) => {
    await mkdir(dirname(args.path), { recursive: true })
    await atomicWriteFile(args.path, args.content)
    return { bytes_written: Buffer.byteLength(args.content, 'utf8') }
  },
})

// ---------------------------------------------------------------------------
// fs.edit
// ---------------------------------------------------------------------------

const FsEditArgsSchema = z.object({
  path: z.string().min(1),
  old_text: z.string().min(1),
  new_text: z.string(),
  /**
   * When true, replaces every occurrence; default false (must be unique
   * — fails if `old_text` appears more than once or not at all).
   */
  replace_all: z.boolean().default(false),
})

export const fsEdit = defineTool({
  name: 'fs_edit',
  description: 'Find-and-replace within a file. Atomic write.',
  idempotency: 'checkpointed',
  argsSchema: FsEditArgsSchema,
  pathArgs: [{ argName: 'path', operation: 'write' }],
  execute: async (args) => {
    const original = await readFile(args.path, 'utf8')
    let next: string
    if (args.replace_all) {
      next = original.split(args.old_text).join(args.new_text)
      if (next === original) {
        throw new Error(`old_text not found in ${args.path}`)
      }
    } else {
      const occurrences = countOccurrences(original, args.old_text)
      if (occurrences === 0) throw new Error(`old_text not found in ${args.path}`)
      if (occurrences > 1)
        throw new Error(
          `old_text appears ${String(occurrences)} times in ${args.path}; pass replace_all: true or narrow the match`,
        )
      next = original.replace(args.old_text, args.new_text)
    }
    await atomicWriteFile(args.path, next)
    return { replacements: args.replace_all ? countOccurrences(original, args.old_text) : 1 }
  },
})

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let idx = 0
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++
    idx += needle.length
  }
  return count
}

// ---------------------------------------------------------------------------
// fs.list
// ---------------------------------------------------------------------------

const FsListArgsSchema = z.object({
  path: z.string().min(1),
})

export const fsList = defineTool({
  name: 'fs_list',
  description: 'List entries in a directory. Returns names + types (file/dir).',
  idempotency: 'pure',
  argsSchema: FsListArgsSchema,
  pathArgs: [{ argName: 'path', operation: 'read' }],
  execute: async (args) => {
    const entries = await readdir(args.path, { withFileTypes: true })
    return {
      entries: entries.map((e) => ({
        name: e.name,
        kind: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
      })),
    }
  },
})

// ---------------------------------------------------------------------------
// fs.delete
// ---------------------------------------------------------------------------

const FsDeleteArgsSchema = z.object({
  path: z.string().min(1),
})

export const fsDelete = defineTool({
  name: 'fs_delete',
  description: 'Delete a file. Never recursive at v1.',
  idempotency: 'destructive',
  argsSchema: FsDeleteArgsSchema,
  pathArgs: [{ argName: 'path', operation: 'delete' }],
  execute: async (args) => {
    const s = await stat(args.path)
    if (s.isDirectory()) {
      throw new Error(`fs.delete refuses directories at v1: ${args.path}`)
    }
    await unlink(args.path)
    return { deleted: true }
  },
})

// ---------------------------------------------------------------------------
// Server export
// ---------------------------------------------------------------------------

export const fsTools: ToolDefinition[] = [fsRead, fsWrite, fsEdit, fsList, fsDelete]
