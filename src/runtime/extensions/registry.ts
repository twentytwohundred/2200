/**
 * Extension registry (Epic 12 Phase A).
 *
 * Read-only registry over <home>/extensions/<name>/manifest.json.
 * Scans on demand; cached entries are not held across CLI invocations
 * (the supervisor will keep a warm cache in Phase B).
 *
 * Phase A surface: list (slug + version + status), get (full manifest),
 * exists (slug presence). Install / uninstall / lifecycle hooks land
 * in Phase B.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homePaths } from '../storage/layout.js'
import { ExtensionManifestError, validateManifest, type ExtensionManifest } from './types.js'

export interface ExtensionRecord {
  /** Slug from the manifest (matches the dir name). */
  name: string
  /** Absolute path to the manifest file. */
  manifestPath: string
  /** Absolute path to the extension directory. */
  rootPath: string
  /** Parsed manifest. */
  manifest: ExtensionManifest
}

export interface ExtensionListEntry {
  name: string
  version: string
  display_name: string
  description: string
  status: 'ok' | 'invalid'
  /** Free-form error string when status === 'invalid'. */
  reason?: string
}

function extensionsRoot(home: string): string {
  return join(home, 'extensions')
}

function manifestPathFor(home: string, name: string): string {
  return join(extensionsRoot(home), name, 'manifest.json')
}

/**
 * Read and validate one extension. Throws on missing manifest or
 * schema failure; the CLI's `extension show` surface uses this.
 */
export async function readExtension(home: string, name: string): Promise<ExtensionRecord> {
  const manifestPath = manifestPathFor(home, name)
  let raw: string
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ExtensionManifestError(manifestPath, 'manifest file does not exist')
    }
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new ExtensionManifestError(
      manifestPath,
      `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const manifest = validateManifest(parsed, manifestPath)
  if (manifest.name !== name) {
    throw new ExtensionManifestError(
      manifestPath,
      `manifest name "${manifest.name}" does not match directory "${name}"`,
    )
  }
  return {
    name: manifest.name,
    manifestPath,
    rootPath: join(extensionsRoot(home), name),
    manifest,
  }
}

/**
 * List all installed extensions. Returns one entry per directory
 * under <home>/extensions/, ok or invalid based on manifest health.
 *
 * Tolerates a missing root dir (returns []) and tolerates malformed
 * manifests within: a single bad extension does not break the listing.
 */
export async function listExtensions(home: string): Promise<ExtensionListEntry[]> {
  const root = extensionsRoot(home)
  let names: string[]
  try {
    names = await readdir(root)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const entries: ExtensionListEntry[] = []
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue
    const dir = join(root, name)
    let isDir: boolean
    try {
      isDir = (await stat(dir)).isDirectory()
    } catch {
      continue
    }
    if (!isDir) continue
    try {
      const rec = await readExtension(home, name)
      entries.push({
        name: rec.name,
        version: rec.manifest.version,
        display_name: rec.manifest.display_name,
        description: rec.manifest.description,
        status: 'ok',
      })
    } catch (err) {
      entries.push({
        name,
        version: '?',
        display_name: name,
        description: '(invalid manifest)',
        status: 'invalid',
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return entries
}

/**
 * True if an extension by that slug is installed (and its manifest
 * is present, regardless of validity).
 */
export async function extensionExists(home: string, name: string): Promise<boolean> {
  try {
    await stat(manifestPathFor(home, name))
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/** Surface the install root for tests + the CLI's "where to drop a manifest" docstring. */
export function extensionsHome(home: string): string {
  void homePaths(home) // keep the layout import warm for future imports
  return extensionsRoot(home)
}
