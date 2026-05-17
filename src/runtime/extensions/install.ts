/**
 * Extension install / uninstall / update orchestration (Epic 12 Phase B).
 *
 * The orchestrator is the single entry point for the lifecycle:
 *
 *   - validate the manifest at the source
 *   - confirm permissions with the user (or accept the
 *     operator-supplied auto-approve flag)
 *   - copy the static files into `<home>/extensions/<name>/`
 *   - persist grants to `<home>/state/extensions/<name>/grants.json`
 *   - initialize the per-Extension state.json (and scratch dir if
 *     `fs.scratch` is granted)
 *   - reconcile manifest schedules into per-Extension schedule files
 *     (Phase B-2; only when `schedule` permission is granted)
 *   - run the lifecycle hook (install / uninstall / update) with the
 *     capability-derived env from `hooks.ts`
 *   - on hook failure for `install`, roll back: remove the just-
 *     copied static files and the just-initialized state directory
 *     so the next install attempt starts clean
 *
 * Tool registration is deferred to a follow-up sub-phase that pairs
 * with the MCP-by-Extension contract design.
 */
import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteJson } from '../util/atomic-write.js'
import { extensionStateDir, extensionStatePaths } from '../storage/layout.js'
import { extensionsHome, readExtension } from './registry.js'
import {
  validateManifest,
  ExtensionManifestError,
  type ExtensionManifest,
  type ExtensionPermission,
} from './types.js'
import { writeGrants, readGrants } from './grants.js'
import { runHook, type HookExecResult, type HookKind } from './hooks.js'
import type { ResolvedSource } from './source.js'
import {
  reconcileExtensionSchedules,
  listExtensionSchedules,
  deleteExtensionSchedule,
} from './schedules.js'

export class ExtensionInstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExtensionInstallError'
  }
}

export interface PermissionDecision {
  /** All permissions the manifest requests. */
  requested: readonly ExtensionPermission[]
  /**
   * Subset the user has approved. Phase B does not support partial
   * grants from the orchestrator; the caller (CLI) presents the
   * options and either approves all or aborts. The shape stays open
   * here so a future flow that allows per-permission approval can
   * use the same hook.
   */
  approved: readonly ExtensionPermission[]
}

/**
 * Confirmation hook the CLI implements. The orchestrator never reads
 * stdin directly so it stays testable: tests pass a synchronous
 * approver, the CLI passes a readline-driven one.
 *
 * The function MUST resolve with `null` on user abort; the
 * orchestrator interprets null as "stop, do not roll back state we
 * have not yet touched".
 */
export type ApprovePermissions = (
  manifest: ExtensionManifest,
  context: { kind: HookKind; existingGrants: readonly ExtensionPermission[] },
) => Promise<PermissionDecision | null>

export interface InstallArgs {
  home: string
  source: ResolvedSource
  approve: ApprovePermissions
  /** Replace an existing install with the same name. */
  force?: boolean
  /** Override the install hook timeout (testing). */
  hookTimeoutMs?: number
}

export interface InstallResult {
  manifest: ExtensionManifest
  /** Permissions persisted to grants.json. */
  granted: readonly ExtensionPermission[]
  /** Hook result; null when the manifest declared no install hook. */
  hookResult: HookExecResult | null
  /** True when install bailed because the user aborted. */
  aborted: boolean
  /**
   * True when the install touched per-Extension schedule files. The
   * CLI uses this to decide whether to RPC the running supervisor's
   * Scheduler to reload (so newly-registered schedules arm without a
   * daemon restart).
   */
  schedulesChanged: boolean
}

/**
 * Read manifest.json from a resolved source dir. Wraps the same
 * validateManifest used by the registry so error shapes match.
 */
async function loadSourceManifest(rootDir: string): Promise<ExtensionManifest> {
  const manifestPath = join(rootDir, 'manifest.json')
  let raw: string
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ExtensionInstallError(`source has no manifest.json at ${manifestPath}`)
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
  return validateManifest(parsed, manifestPath)
}

/**
 * Copy the source dir into <home>/extensions/<name>/. Requires the
 * destination not to exist. The caller (`install`) handles the
 * already-installed case before getting here.
 */
async function copyExtensionFiles(source: ResolvedSource, destRoot: string): Promise<void> {
  await mkdir(destRoot, { recursive: false })
  await cp(source.rootDir, destRoot, {
    recursive: true,
    errorOnExist: false,
    // Don't follow symlinks out of the source tree; preserve them.
    dereference: false,
    preserveTimestamps: true,
    filter: (src) => !src.endsWith('/.git'),
  })
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const st = await stat(path)
    return st.isDirectory()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

async function ensureScratchDir(home: string, name: string): Promise<void> {
  const paths = extensionStatePaths(home, name)
  await mkdir(paths.scratch, { recursive: true })
}

async function ensureStateInitialized(home: string, name: string): Promise<void> {
  const paths = extensionStatePaths(home, name)
  await mkdir(paths.root, { recursive: true })
  if (await fileExists(paths.state)) return
  await atomicWriteJson(paths.state, {})
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

export interface UninstallArgs {
  home: string
  name: string
  /** Confirm verb (yes/no). The CLI provides the prompt. */
  approve: () => Promise<boolean>
  /** Override the uninstall hook timeout (testing). */
  hookTimeoutMs?: number
  /** Skip the prompt entirely (e.g., when called from `update`). */
  skipApprove?: boolean
}

export interface UninstallResult {
  /** True when uninstall ran end-to-end. */
  removed: boolean
  /** Hook result; null when no hook declared or the user aborted. */
  hookResult: HookExecResult | null
  /** True when bailed because user aborted at the prompt. */
  aborted: boolean
  /**
   * True when the uninstall hook exited non-zero / timed out. The
   * orchestrator still removes the static files + state when this
   * fires; tearing down a misbehaving Extension is the entire point
   * of `uninstall`.
   */
  hookFailed: boolean
  /**
   * True when the uninstall removed per-Extension schedule files.
   * CLI uses this to decide whether to RPC the supervisor for reload.
   */
  schedulesChanged: boolean
}

export interface UpdateArgs {
  home: string
  /** New source for the updated Extension. */
  source: ResolvedSource
  /**
   * Confirm only if there are NEW permissions. The CLI surfaces just
   * the additions so users do not re-approve everything on every
   * update.
   */
  approveNewPermissions: (
    manifest: ExtensionManifest,
    additions: readonly ExtensionPermission[],
  ) => Promise<boolean>
  hookTimeoutMs?: number
  /** Allow re-installing the same version (testing / forced re-run). */
  allowSameVersion?: boolean
}

export interface UpdateResult {
  manifest: ExtensionManifest
  fromVersion: string
  toVersion: string
  granted: readonly ExtensionPermission[]
  hookResult: HookExecResult | null
  aborted: boolean
  schedulesChanged: boolean
}

/**
 * Install an Extension from a resolved source. Returns the manifest
 * and the install hook's result; throws on validation, copy, or hook
 * launch failures with cleanup of any partial state.
 */
export async function installExtension(args: InstallArgs): Promise<InstallResult> {
  const manifest = await loadSourceManifest(args.source.rootDir)
  const home = args.home
  const name = manifest.name

  const destRoot = join(extensionsHome(home), name)
  if (await dirExists(destRoot)) {
    if (!args.force) {
      throw new ExtensionInstallError(
        `Extension "${name}" is already installed at ${destRoot}. ` +
          `Run \`2200 extension uninstall ${name}\` first, or pass --force to replace it.`,
      )
    }
    // --force: tear down before installing anew. Run uninstall
    // hook silently (best-effort) so the old version gets a chance
    // to clean up. Failures here do not block the install.
    try {
      await uninstallExtension({
        home,
        name,
        approve: () => Promise.resolve(true),
        skipApprove: true,
        ...(args.hookTimeoutMs !== undefined ? { hookTimeoutMs: args.hookTimeoutMs } : {}),
      })
    } catch {
      // best-effort; proceed with the fresh install regardless.
    }
  }

  const decision = await args.approve(manifest, { kind: 'install', existingGrants: [] })
  if (decision === null) {
    return {
      manifest,
      granted: [],
      hookResult: null,
      aborted: true,
      schedulesChanged: false,
    }
  }
  validateApproval(manifest, decision)
  validateSchedulePermission(manifest, decision.approved)

  let copied = false
  let stateInitialized = false
  let schedulesChanged = false
  try {
    await mkdir(extensionsHome(home), { recursive: true })
    await copyExtensionFiles(args.source, destRoot)
    copied = true
    await ensureStateInitialized(home, name)
    stateInitialized = true
    if (decision.approved.includes('fs.scratch')) {
      await ensureScratchDir(home, name)
    }
    await writeGrants(home, name, decision.approved)

    if (manifest.schedules.length > 0 && decision.approved.includes('schedule')) {
      await reconcileExtensionSchedules({
        home,
        extensionName: name,
        extensionVersion: manifest.version,
        manifestSchedules: manifest.schedules,
      })
      schedulesChanged = true
    }

    let hookResult: HookExecResult | null = null
    if (manifest.hooks.install) {
      const grants = await readGrants(home, name)
      hookResult = await runHook({
        home,
        name,
        version: manifest.version,
        hook: 'install',
        scriptRelative: manifest.hooks.install,
        grants,
        ...(args.hookTimeoutMs !== undefined ? { timeoutMs: args.hookTimeoutMs } : {}),
      })
      if (hookResult.exitCode !== 0 || hookResult.timedOut) {
        // Hook failed: roll back so a retry is clean.
        await rollbackInstall(home, name, copied, stateInitialized)
        throw new ExtensionInstallError(
          `install hook failed (${hookExitSummary(hookResult)}). ` +
            `See ${hookResult.logPath} for details.`,
        )
      }
    }

    return {
      manifest,
      granted: decision.approved,
      hookResult,
      aborted: false,
      schedulesChanged,
    }
  } catch (err) {
    if (!(err instanceof ExtensionInstallError)) {
      await rollbackInstall(home, name, copied, stateInitialized).catch(() => undefined)
    }
    throw err
  }
}

/**
 * Uninstall the Extension. Always tears down the static files + state
 * directory at the end, even if the uninstall hook fails: a
 * misbehaving extension that refuses to clean up gracefully cannot
 * pin itself in place. The hook failure is signaled in the result so
 * the CLI can report it.
 */
export async function uninstallExtension(args: UninstallArgs): Promise<UninstallResult> {
  const home = args.home
  const name = args.name

  const destRoot = join(extensionsHome(home), name)
  let manifest: ExtensionManifest | null = null
  if (await dirExists(destRoot)) {
    try {
      const rec = await readExtension(home, name)
      manifest = rec.manifest
    } catch {
      // Manifest missing or malformed; uninstall continues so
      // operators can clean up corrupt installs.
    }
  } else {
    return {
      removed: false,
      hookResult: null,
      aborted: false,
      hookFailed: false,
      schedulesChanged: false,
    }
  }

  if (!args.skipApprove) {
    const ok = await args.approve()
    if (!ok) {
      return {
        removed: false,
        hookResult: null,
        aborted: true,
        hookFailed: false,
        schedulesChanged: false,
      }
    }
  }

  // Snapshot whether there were schedule files BEFORE removing the
  // state dir, so the result accurately reports "schedules changed"
  // (and the CLI knows to RPC the supervisor for reload).
  const priorSchedules = await listExtensionSchedules(home, name)
  const schedulesChanged = priorSchedules.length > 0

  let hookResult: HookExecResult | null = null
  let hookFailed = false
  if (manifest?.hooks.uninstall) {
    const grants = await readGrants(home, name)
    try {
      hookResult = await runHook({
        home,
        name,
        version: manifest.version,
        hook: 'uninstall',
        scriptRelative: manifest.hooks.uninstall,
        grants,
        ...(args.hookTimeoutMs !== undefined ? { timeoutMs: args.hookTimeoutMs } : {}),
      })
      if (hookResult.exitCode !== 0 || hookResult.timedOut) {
        hookFailed = true
      }
    } catch {
      // Hook launch error: continue with teardown anyway.
      hookFailed = true
    }
  }

  await rm(destRoot, { recursive: true, force: true })
  await rm(extensionStateDir(home, name), { recursive: true, force: true })

  return { removed: true, hookResult, aborted: false, hookFailed, schedulesChanged }
}

/**
 * Update the Extension to a new manifest version. Compares the
 * incoming manifest with the installed grants, prompts for any new
 * permissions, runs the update hook with FROM/TO env, and replaces
 * the static files atomically (via temp-rename). On hook failure the
 * old installation is preserved.
 */
export async function updateExtension(args: UpdateArgs): Promise<UpdateResult> {
  const incoming = await loadSourceManifest(args.source.rootDir)
  const home = args.home
  const name = incoming.name

  const destRoot = join(extensionsHome(home), name)
  if (!(await dirExists(destRoot))) {
    throw new ExtensionInstallError(
      `Extension "${name}" is not installed. ` + `Run \`2200 extension install <source>\` first.`,
    )
  }

  const installed = await readExtension(home, name)
  const fromVersion = installed.manifest.version
  const toVersion = incoming.version
  if (fromVersion === toVersion && !args.allowSameVersion) {
    throw new ExtensionInstallError(
      `Extension "${name}" is already at version ${fromVersion}. ` +
        `Use --allow-same-version to re-run the update hook.`,
    )
  }

  const existingGrants = await readGrants(home, name)
  const additions = incoming.permissions.filter((p) => !existingGrants.permissions.includes(p))
  if (additions.length > 0) {
    const ok = await args.approveNewPermissions(incoming, additions)
    if (!ok) {
      return {
        manifest: incoming,
        fromVersion,
        toVersion,
        granted: existingGrants.permissions,
        hookResult: null,
        aborted: true,
        schedulesChanged: false,
      }
    }
  }
  const mergedGrants = [...new Set([...existingGrants.permissions, ...additions])]
  validateSchedulePermission(incoming, mergedGrants)

  // Stage new files alongside the live install. Atomic-ish swap via
  // rename. Old files move to a temp suffix so a hook failure can
  // restore them.
  const stagingRoot = `${destRoot}.staging-${String(Date.now())}`
  await copyExtensionFiles(args.source, stagingRoot)

  // Pre-stage permission additions so the hook sees the intended
  // grant set when it runs.
  await writeGrants(home, name, mergedGrants)
  if (mergedGrants.includes('fs.scratch')) {
    await ensureScratchDir(home, name)
  }

  // Swap the staging tree into the live location before running any
  // hook so EXTENSION_ROOT points at the new files. The previous
  // version sits in a backup dir until the hook (if any) succeeds,
  // and is restored on hook failure or rename error.
  let hookResult: HookExecResult | null = null
  const backupRoot = `${destRoot}.previous-${String(Date.now())}`
  await rm(backupRoot, { recursive: true, force: true })
  await renameDir(destRoot, backupRoot)
  try {
    await renameDir(stagingRoot, destRoot)
    if (incoming.hooks.update) {
      const grants = await readGrants(home, name)
      hookResult = await runHook({
        home,
        name,
        version: incoming.version,
        hook: 'update',
        scriptRelative: incoming.hooks.update,
        grants,
        fromVersion,
        toVersion,
        ...(args.hookTimeoutMs !== undefined ? { timeoutMs: args.hookTimeoutMs } : {}),
      })
      if (hookResult.exitCode !== 0 || hookResult.timedOut) {
        await rm(destRoot, { recursive: true, force: true })
        await renameDir(backupRoot, destRoot)
        await writeGrants(home, name, existingGrants.permissions)
        throw new ExtensionInstallError(
          `update hook failed (${hookExitSummary(hookResult)}). ` +
            `Reverted to ${fromVersion}. See ${hookResult.logPath} for details.`,
        )
      }
    }
    await rm(backupRoot, { recursive: true, force: true })
  } catch (err) {
    if (await dirExists(backupRoot)) {
      await rm(destRoot, { recursive: true, force: true }).catch(() => undefined)
      await renameDir(backupRoot, destRoot).catch(() => undefined)
      await writeGrants(home, name, existingGrants.permissions).catch(() => undefined)
    }
    throw err
  }

  // Reconcile schedules from the new manifest. Always runs (even when
  // the manifest has no schedules) because the previous version may
  // have had some that we need to clear out. Only kicks in when the
  // `schedule` permission is granted; otherwise schedules in the
  // manifest are silently dropped to avoid registering work the
  // permission set forbids.
  let schedulesChanged = false
  if (mergedGrants.includes('schedule')) {
    const before = await listExtensionSchedules(home, name)
    await reconcileExtensionSchedules({
      home,
      extensionName: name,
      extensionVersion: toVersion,
      manifestSchedules: incoming.schedules,
    })
    const after = await listExtensionSchedules(home, name)
    schedulesChanged = !sameScheduleSet(before, after)
  } else if (incoming.schedules.length === 0) {
    // Permission removed at the user's request and manifest agrees:
    // wipe any schedule files left over from the previous version.
    const prior = await listExtensionSchedules(home, name)
    if (prior.length > 0) {
      for (const e of prior) await deleteExtensionSchedule(home, name, e.id)
      schedulesChanged = true
    }
  }

  return {
    manifest: incoming,
    fromVersion,
    toVersion,
    granted: mergedGrants,
    hookResult,
    aborted: false,
    schedulesChanged,
  }
}

/**
 * Validate that the orchestrator-supplied approval is internally
 * consistent: every approved permission is one the manifest actually
 * requested. The orchestrator never grants something the manifest
 * does not declare, so a buggy CLI that returned a malformed
 * approval is caught early.
 */
function validateApproval(manifest: ExtensionManifest, decision: PermissionDecision): void {
  for (const p of decision.approved) {
    if (!manifest.permissions.includes(p)) {
      throw new ExtensionInstallError(
        `approval includes permission "${p}" that is not declared in the manifest`,
      )
    }
  }
}

async function rollbackInstall(
  home: string,
  name: string,
  copied: boolean,
  stateInitialized: boolean,
): Promise<void> {
  if (copied) {
    await rm(join(extensionsHome(home), name), { recursive: true, force: true }).catch(
      () => undefined,
    )
  }
  if (stateInitialized) {
    await rm(extensionStateDir(home, name), { recursive: true, force: true }).catch(() => undefined)
  }
}

async function renameDir(from: string, to: string): Promise<void> {
  const { rename } = await import('node:fs/promises')
  await rename(from, to)
}

/**
 * Format the failure summary the CLI surfaces when a hook exits
 * non-zero or times out. Centralized so install / update share one
 * shape and template-literal lint stays clean.
 */
function hookExitSummary(result: HookExecResult): string {
  const code = result.exitCode === null ? 'null' : String(result.exitCode)
  const signal = result.signal ?? 'null'
  return `exit=${code}, signal=${signal}, timed_out=${String(result.timedOut)}`
}

/**
 * Refuse to register schedules without the `schedule` permission. An
 * Extension that declares schedules but did not get the permission
 * approved either has a manifest bug or a user who declined the
 * grant; in both cases the right action is to fail loud at install
 * time instead of silently dropping the registration.
 */
function validateSchedulePermission(
  manifest: ExtensionManifest,
  approved: readonly ExtensionPermission[],
): void {
  if (manifest.schedules.length > 0 && !approved.includes('schedule')) {
    throw new ExtensionInstallError(
      `Extension "${manifest.name}" declares ${String(manifest.schedules.length)} schedule(s) ` +
        `but the \`schedule\` permission is not granted. ` +
        `Re-run install and approve the schedule permission, or remove the schedules from the manifest.`,
    )
  }
  if (manifest.schedules.length > 0 && !manifest.hooks.tick) {
    // Soft constraint: schedules without a tick hook are persistable
    // (the registration shape is still meaningful for inspection)
    // but they will never DO anything when they fire. Surface this
    // clearly so authors notice.
    // We raise here rather than warning silently because today's
    // model has no other firing behavior; an Extension that wants to
    // declare schedules without a tick hook is almost certainly a
    // missed declaration.
    throw new ExtensionInstallError(
      `Extension "${manifest.name}" declares schedules but no \`hooks.tick\` script. ` +
        `Schedules fire the tick hook on each cron match; without it the schedule has no behavior. ` +
        `Add a tick hook to the manifest, or remove the schedules.`,
    )
  }
}

/**
 * Compare two schedule entry sets ignoring stable timestamps so the
 * "did anything change" decision is robust against `next_fire_at`
 * recomputation across reads. Used by update to decide whether to
 * RPC the supervisor for a Scheduler reload.
 */
function sameScheduleSet(
  before: readonly { id: string; cron: string; description: string; enabled: boolean }[],
  after: readonly { id: string; cron: string; description: string; enabled: boolean }[],
): boolean {
  if (before.length !== after.length) return false
  const a = [...before].sort((x, y) => x.id.localeCompare(y.id))
  const b = [...after].sort((x, y) => x.id.localeCompare(y.id))
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]
    const bi = b[i]
    if (!ai || !bi) return false
    if (ai.id !== bi.id) return false
    if (ai.cron !== bi.cron) return false
    if (ai.description !== bi.description) return false
    if (ai.enabled !== bi.enabled) return false
  }
  return true
}
