/**
 * Extension install pipeline.
 *
 * Resolves a catalog entry's `source` (workspace or npm), copies /
 * installs the Extension into `<home>/extensions/<id>/`, validates
 * the resulting manifest, runs the install hook, and emits progress
 * events the supervisor pushes over WebSocket.
 *
 * v1: `workspace` source is fully implemented (copies the in-repo
 * package directory). `npm` source throws "not implemented" until the
 * registry-install path lands (post-publish work).
 *
 * Decisions:
 *   - [[../../decisions/2026-05-16-connector-extensions]]
 *   - [[../../decisions/2026-05-16-connector-store]]
 */
import { mkdir, cp, readFile, rm, stat } from 'node:fs/promises'
import { join, dirname, isAbsolute, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { newExtensionInstallId } from '../util/id.js'
import { validateManifest } from './types.js'
import type { CatalogEntry } from './catalog.js'

export interface InstallProgressEvent {
  install_id: string
  extension_id: string
  stage:
    | 'resolving'
    | 'copying'
    | 'validating_manifest'
    | 'running_install_hook'
    | 'completed'
    | 'failed'
  percent: number
  message?: string
  error_code?:
    | 'unsupported_source'
    | 'workspace_path_missing'
    | 'manifest_missing'
    | 'manifest_invalid'
    | 'install_hook_failed'
    | 'permission_mismatch'
    | 'tos_not_acknowledged'
    | 'unknown'
}

export interface InstallArgs {
  /** The catalog entry the user clicked install on. */
  entry: CatalogEntry
  /** 2200_HOME root. */
  home: string
  /**
   * Permission categories the user approved in the install modal. Must
   * be a superset of the manifest's declared permissions or install
   * aborts.
   */
  permissionsAcknowledged: string[]
  /** True when the user clicked through the ToS modal (if the entry has one). */
  tosAcknowledged: boolean
  /** Progress emitter (the supervisor pushes these over WS). */
  onProgress: (event: InstallProgressEvent) => void
}

export interface InstallResult {
  install_id: string
  extension_dir: string
}

/**
 * Run the install. Throws on unrecoverable failure; the caller wraps
 * the throw in a `stage: 'failed'` event for the WS surface.
 */
export async function installFromCatalogEntry(args: InstallArgs): Promise<InstallResult> {
  const installId = newExtensionInstallId()
  const extensionDir = join(args.home, 'extensions', args.entry.id)
  const extensionStateDir = join(args.home, 'state', 'extensions', args.entry.id)
  const emit = (event: Omit<InstallProgressEvent, 'install_id' | 'extension_id'>): void => {
    args.onProgress({
      install_id: installId,
      extension_id: args.entry.id,
      ...event,
    })
  }

  // 0. ToS check (informational; if the entry has a tos_acknowledgment,
  //    the caller must signal that the user clicked through).
  if (args.entry.tos_acknowledgment && !args.tosAcknowledged) {
    emit({
      stage: 'failed',
      percent: 0,
      message: 'ToS not acknowledged',
      error_code: 'tos_not_acknowledged',
    })
    throw new Error('install: tos_not_acknowledged')
  }

  // 1. Permission check.
  const needed = new Set(args.entry.permissions)
  const granted = new Set(args.permissionsAcknowledged)
  const missing = [...needed].filter((p) => !granted.has(p))
  if (missing.length > 0) {
    emit({
      stage: 'failed',
      percent: 0,
      message: `Missing permission ack: ${missing.join(', ')}`,
      error_code: 'permission_mismatch',
    })
    throw new Error(`install: permission_mismatch (missing ${missing.join(', ')})`)
  }

  emit({ stage: 'resolving', percent: 5, message: `Resolving ${args.entry.source.type} source` })

  // 2. Source resolution.
  let sourcePath: string
  if (args.entry.source.type === 'workspace') {
    sourcePath = resolveWorkspacePath(args.entry.source.path)
    try {
      const s = await stat(sourcePath)
      if (!s.isDirectory()) throw new Error(`${sourcePath} is not a directory`)
    } catch (err) {
      emit({
        stage: 'failed',
        percent: 5,
        message: `Workspace path not found: ${sourcePath}`,
        error_code: 'workspace_path_missing',
      })
      throw err instanceof Error ? err : new Error(String(err))
    }
  } else if (args.entry.source.type === 'npm') {
    emit({
      stage: 'failed',
      percent: 5,
      message: 'npm-source installs not implemented yet; use workspace source for dev.',
      error_code: 'unsupported_source',
    })
    throw new Error('install: npm source not implemented')
  } else {
    emit({
      stage: 'failed',
      percent: 5,
      message: 'Unknown source type',
      error_code: 'unsupported_source',
    })
    throw new Error('install: unknown source type')
  }

  // 3. Copy / install.
  emit({ stage: 'copying', percent: 25, message: `Copying to ${extensionDir}` })
  // Wipe any previous install for the same id (best effort).
  await rm(extensionDir, { recursive: true, force: true })
  await mkdir(dirname(extensionDir), { recursive: true })
  await cp(sourcePath, extensionDir, {
    recursive: true,
    // Skip the workspace's node_modules + dist - they'd dwarf the install.
    // For npm-mode installs, this isn't an issue because the tarball is
    // already the published artifact.
    filter: (source) => {
      const rel = source.slice(sourcePath.length)
      if (rel.includes('/node_modules')) return false
      if (rel.includes('/dist')) return false
      return true
    },
  })

  // 4. Validate the manifest from the install destination.
  emit({ stage: 'validating_manifest', percent: 50, message: 'Reading manifest.json' })
  const manifestPath = join(extensionDir, 'manifest.json')
  let manifestRaw: unknown
  try {
    const text = await readFile(manifestPath, 'utf-8')
    manifestRaw = JSON.parse(text)
  } catch (err) {
    emit({
      stage: 'failed',
      percent: 50,
      message: 'manifest.json missing or unreadable',
      error_code: 'manifest_missing',
    })
    throw err instanceof Error ? err : new Error(String(err))
  }
  try {
    validateManifest(manifestRaw, manifestPath)
  } catch (err) {
    emit({
      stage: 'failed',
      percent: 50,
      message: err instanceof Error ? err.message : String(err),
      error_code: 'manifest_invalid',
    })
    throw err instanceof Error ? err : new Error(String(err))
  }

  // 5. Ensure state dir, run install hook.
  await mkdir(extensionStateDir, { recursive: true })
  emit({ stage: 'running_install_hook', percent: 75, message: 'Running install hook' })
  try {
    await runInstallHook(extensionDir, extensionStateDir, args.permissionsAcknowledged)
  } catch (err) {
    emit({
      stage: 'failed',
      percent: 75,
      message: err instanceof Error ? err.message : String(err),
      error_code: 'install_hook_failed',
    })
    throw err instanceof Error ? err : new Error(String(err))
  }

  emit({ stage: 'completed', percent: 100, message: 'Install complete' })
  return { install_id: installId, extension_dir: extensionDir }
}

function resolveWorkspacePath(repoRelative: string): string {
  if (isAbsolute(repoRelative)) return repoRelative
  // src/runtime/extensions/install-pipeline.ts → ../../..
  // dist/runtime/extensions/install-pipeline.js → ../../..
  const here = dirname(fileURLToPath(import.meta.url))
  const repoRoot = resolvePath(here, '..', '..', '..')
  return join(repoRoot, repoRelative)
}

async function runInstallHook(
  extensionDir: string,
  stateDir: string,
  permissionsGranted: string[],
): Promise<void> {
  const manifestText = await readFile(join(extensionDir, 'manifest.json'), 'utf-8')
  const manifest = JSON.parse(manifestText) as { hooks?: { install?: string } }
  const hookRel = manifest.hooks?.install
  if (!hookRel) return // No install hook declared; nothing to do.
  const hookPath = join(extensionDir, hookRel)
  await new Promise<void>((resolve, reject) => {
    const child = spawn('node', [hookPath], {
      cwd: extensionDir,
      env: {
        ...process.env,
        EXTENSION_HOME: extensionDir,
        EXTENSION_STATE_DIR: stateDir,
        EXTENSION_PERMISSIONS_GRANTED: permissionsGranted.join(','),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stdout?.on('data', () => undefined)
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
    })
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('install hook timed out (30s)'))
    }, 30_000)
    child.on('exit', (code) => {
      clearTimeout(timeout)
      if (code === 0) resolve()
      else reject(new Error(`install hook exited ${String(code)}: ${stderr.trim()}`))
    })
    child.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}
