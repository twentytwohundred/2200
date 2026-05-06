/**
 * Extension lifecycle hook executor (Epic 12 Phase B).
 *
 * Per `wiki/epics/12-extensions-framework.md` and the prior-art
 * recommendation (`wiki/prior-art-analysis.md` §Epic 12: "in-process
 * v1 with permission kernel chokepoint, microVM future"), v1 isolation
 * is a child process with a strictly whitelisted env, controlled cwd,
 * captured stdio, and an enforced timeout. The permission kernel is
 * the env we expose: a hook receives capability-derived variables for
 * exactly the permissions the user granted, never anything else.
 *
 * Future isolation (microVM, gVisor, Firecracker per the Perplexity
 * Computer source-finding) replaces this child-process boundary. The
 * call shape here is structured so the contract does not assume same-
 * address-space access — the hook reads + writes its world through
 * env paths and JSON files, so swapping the boundary later is a
 * substitution rather than a redesign.
 *
 * What v1 enforces:
 *   - Whitelisted env: the parent's env does NOT pass through. Only
 *     PATH / HOME / LANG / LC_ALL / TZ are inherited (the minimum a
 *     normal node / bash invocation needs). Everything else the hook
 *     can see is derived from the manifest + grants.
 *   - cwd = the Extension's install dir, so hooks can reference
 *     bundled files via relative paths.
 *   - 30-second wall clock timeout. Exceeding it sends SIGTERM, then
 *     SIGKILL after a 2-second grace.
 *   - Stdout + stderr captured to `<home>/state/extensions/<name>/
 *     <hook>.log`. The log is append-only across hook runs (history
 *     is a feature, not a bug ... operators inspect failed installs).
 *   - Result is a structured value the orchestrator inspects (exit
 *     code, signal, duration, timeout-bool, log path).
 *
 * What v1 does NOT enforce (deferred to microVM):
 *   - Filesystem isolation. A hook can technically read anywhere the
 *     parent process can. The capability env signals what the hook
 *     SHOULD write to (scratch, state file); honor relies on the
 *     hook author + the runtime gating downstream actions (tools,
 *     schedules) at register time.
 *   - Network isolation. A hook with network egress on the host
 *     can call out, regardless of the `network` permission. The
 *     `network` permission today is a declaration that informs
 *     downstream gates (network-using built-in tools registered for
 *     this Extension), not a sandbox boundary.
 *   - Resource limits beyond the wall-clock timeout. Memory, file
 *     descriptors, etc. are inherited from the supervisor.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, stat, appendFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { extensionStatePaths, extensionHookLogPath } from '../storage/layout.js'
import type { ExtensionPermission } from './types.js'
import { hasGrant, type ExtensionGrants } from './grants.js'

/** Default hook wall-clock limit. */
export const DEFAULT_HOOK_TIMEOUT_MS = 30_000

/** Grace period between SIGTERM and SIGKILL on timeout. */
export const HOOK_KILL_GRACE_MS = 2_000

export type HookKind = 'install' | 'uninstall' | 'update' | 'tick'

export interface HookExecArgs {
  /** 2200_HOME root. */
  home: string
  /** Extension slug (matches dir under <home>/extensions/). */
  name: string
  /** Manifest version of the Extension. */
  version: string
  /** Which lifecycle phase is firing. */
  hook: HookKind
  /** Path to the hook script, relative to the Extension's root dir. */
  scriptRelative: string
  /** Permissions the user has granted this Extension. */
  grants: ExtensionGrants
  /** For `update`: previous version. Ignored for install/uninstall/tick. */
  fromVersion?: string
  /** For `update`: new version. Ignored for install/uninstall/tick. */
  toVersion?: string
  /** For `tick`: id of the schedule whose firing triggered this run. */
  scheduleId?: string
  /** Override timeout (testing). */
  timeoutMs?: number
  /**
   * Override the parent's env passthrough whitelist (testing). The
   * exec normally pulls these names from `process.env`.
   */
  inheritedEnv?: Record<string, string | undefined>
}

export interface HookExecResult {
  /** Process exit code, or null when killed by signal. */
  exitCode: number | null
  /** Signal that killed the process, or null. */
  signal: NodeJS.Signals | null
  /** Wall-clock duration in milliseconds. */
  durationMs: number
  /** True when the timeout fired and the process was killed. */
  timedOut: boolean
  /** Absolute path to the per-hook log file. */
  logPath: string
}

export class HookExecError extends Error {
  constructor(
    public readonly hook: HookKind,
    public readonly extensionName: string,
    message: string,
  ) {
    super(`Extension ${extensionName} hook ${hook}: ${message}`)
    this.name = 'HookExecError'
  }
}

/**
 * Names from the parent env that pass through to the hook child. The
 * list is the minimum a normal `node` or `bash` invocation needs to
 * locate its own binary and produce sane output.
 */
const ENV_INHERIT_NAMES = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ'] as const

/**
 * Build the capability-derived env for a hook child. Pure function so
 * callers can inspect what the hook will see without spawning.
 */
export function buildHookEnv(args: {
  home: string
  name: string
  version: string
  hook: HookKind
  scriptAbsolute: string
  rootAbsolute: string
  grants: ExtensionGrants
  fromVersion?: string
  toVersion?: string
  scheduleId?: string
  inheritedEnv: Record<string, string | undefined>
}): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of ENV_INHERIT_NAMES) {
    const v = args.inheritedEnv[k]
    if (typeof v === 'string') out[k] = v
  }
  const paths = extensionStatePaths(args.home, args.name)
  out['EXTENSION_2200_HOME'] = args.home
  out['EXTENSION_NAME'] = args.name
  out['EXTENSION_VERSION'] = args.version
  out['EXTENSION_HOOK'] = args.hook
  out['EXTENSION_ROOT'] = args.rootAbsolute
  out['EXTENSION_SCRIPT'] = args.scriptAbsolute
  out['EXTENSION_STATE_DIR'] = paths.root
  out['EXTENSION_STATE_FILE'] = paths.state
  out['EXTENSION_LOG_FILE'] = extensionHookLogPath(args.home, args.name, args.hook)
  out['EXTENSION_PERMS'] = [...args.grants.permissions].sort().join(',')
  if (hasGrant(args.grants, 'fs.scratch' satisfies ExtensionPermission)) {
    out['EXTENSION_SCRATCH_DIR'] = paths.scratch
  }
  if (args.hook === 'update') {
    if (args.fromVersion !== undefined) out['EXTENSION_FROM_VERSION'] = args.fromVersion
    if (args.toVersion !== undefined) out['EXTENSION_TO_VERSION'] = args.toVersion
  }
  if (args.hook === 'tick' && args.scheduleId !== undefined) {
    out['EXTENSION_SCHEDULE_ID'] = args.scheduleId
  }
  return out
}

/**
 * Pick the spawn command for a hook script. JavaScript and shell are
 * spawned through a known interpreter; everything else must carry an
 * exec bit + shebang and is run directly.
 */
export function resolveHookCommand(scriptAbsolute: string): { command: string; args: string[] } {
  const lower = scriptAbsolute.toLowerCase()
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    return { command: process.execPath, args: [scriptAbsolute] }
  }
  if (lower.endsWith('.sh') || lower.endsWith('.bash')) {
    return { command: 'bash', args: [scriptAbsolute] }
  }
  return { command: scriptAbsolute, args: [] }
}

/**
 * Execute a hook for an Extension. Resolves once the child exits or
 * the timeout fires. Throws HookExecError when the script does not
 * exist or cannot be exec'd directly. Non-zero exit codes resolve
 * (NOT throw) so the orchestrator can decide how to react (e.g., roll
 * back the install vs. log + continue for uninstall).
 */
export async function runHook(args: HookExecArgs): Promise<HookExecResult> {
  const root = join(args.home, 'extensions', args.name)
  const scriptAbs = join(root, args.scriptRelative)

  let scriptStat
  try {
    scriptStat = await stat(scriptAbs)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HookExecError(args.hook, args.name, `script not found at ${args.scriptRelative}`)
    }
    throw err
  }
  if (!scriptStat.isFile()) {
    throw new HookExecError(
      args.hook,
      args.name,
      `script at ${args.scriptRelative} is not a regular file`,
    )
  }

  // Ensure the state dir + log file's parent exist before the spawn
  // so we never lose stdio on a fresh install.
  const logPath = extensionHookLogPath(args.home, args.name, args.hook)
  await mkdir(dirname(logPath), { recursive: true })

  const cmd = resolveHookCommand(scriptAbs)
  const env = buildHookEnv({
    home: args.home,
    name: args.name,
    version: args.version,
    hook: args.hook,
    scriptAbsolute: scriptAbs,
    rootAbsolute: root,
    grants: args.grants,
    ...(args.fromVersion !== undefined ? { fromVersion: args.fromVersion } : {}),
    ...(args.toVersion !== undefined ? { toVersion: args.toVersion } : {}),
    ...(args.scheduleId !== undefined ? { scheduleId: args.scheduleId } : {}),
    inheritedEnv: args.inheritedEnv ?? process.env,
  })

  const timeoutMs = args.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
  const tsStart = Date.now()

  const header =
    `\n--- ${new Date(tsStart).toISOString()}  hook=${args.hook}  ` +
    `version=${args.version}  cmd="${cmd.command} ${cmd.args.join(' ')}"\n`
  await appendFile(logPath, header, 'utf8')

  return new Promise<HookExecResult>((resolve, reject) => {
    let child: ChildProcess
    try {
      // detached:true puts the child in its own process group so we
      // can kill the entire tree on timeout. A bash hook that exec's
      // a long-running grandchild (e.g., `sleep 30`) would otherwise
      // leak the grandchild past timeout.
      child = spawn(cmd.command, cmd.args, {
        cwd: root,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })
    } catch (err) {
      reject(
        new HookExecError(
          args.hook,
          args.name,
          `failed to spawn: ${err instanceof Error ? err.message : String(err)}`,
        ),
      )
      return
    }

    const killTree = (signal: NodeJS.Signals): void => {
      // Negative pid targets the process group. Falls back to the
      // direct child if the pid is missing (already exited) or the
      // group kill errors (Windows / weird states).
      const pid = child.pid
      if (pid === undefined) return
      try {
        process.kill(-pid, signal)
      } catch {
        try {
          child.kill(signal)
        } catch {
          // best-effort
        }
      }
    }

    let timedOut = false
    let killTimer: NodeJS.Timeout | null = null
    const timeoutTimer = setTimeout(() => {
      timedOut = true
      killTree('SIGTERM')
      killTimer = setTimeout(() => {
        killTree('SIGKILL')
      }, HOOK_KILL_GRACE_MS)
    }, timeoutMs)

    const writes: Promise<void>[] = []
    const safeAppend = (chunk: Buffer): void => {
      writes.push(appendFile(logPath, chunk).catch(() => undefined))
    }
    if (child.stdout) child.stdout.on('data', safeAppend)
    if (child.stderr) child.stderr.on('data', safeAppend)

    child.on('error', (err) => {
      clearTimeout(timeoutTimer)
      if (killTimer) clearTimeout(killTimer)
      reject(new HookExecError(args.hook, args.name, `child error: ${err.message}`))
    })

    child.on('close', (code, signal) => {
      clearTimeout(timeoutTimer)
      if (killTimer) clearTimeout(killTimer)
      const durationMs = Date.now() - tsStart
      void Promise.allSettled(writes).then(() => {
        const codeStr = code === null ? 'null' : String(code)
        const signalStr = signal ?? 'null'
        const trailer = `--- exit=${codeStr} signal=${signalStr} duration_ms=${String(durationMs)} timed_out=${String(timedOut)}\n`
        appendFile(logPath, trailer, 'utf8')
          .catch(() => undefined)
          .finally(() => {
            resolve({
              exitCode: code,
              signal,
              durationMs,
              timedOut,
              logPath,
            })
          })
      })
    })
  })
}
