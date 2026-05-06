/**
 * Build-freshness check.
 *
 * Detects "pulled new commits, didn't rebuild" before it bites.
 *
 * The 2200 CLI is symlinked at `/opt/homebrew/bin/2200` →
 * `<project>/dist/cli/main.js`. After `git pull`, the source tree
 * updates but `dist/` does not (it's gitignored). The CLI continues
 * to run from the stale bundle; if a newly-merged change touched a
 * code path the user is exercising (auth flow, transport, RPC shape),
 * symptoms range from silent hangs to confusing errors.
 *
 * This check runs at CLI startup. If the running CLI bundle is older
 * than the newest `.ts` file in the project's `src/` tree, it emits a
 * single yellow stderr warning telling the user to `pnpm build`. The
 * CLI then proceeds with the stale bundle so the user is not blocked
 * outright; but they have been warned.
 *
 * The check is gated on dev-mode: it only fires when `src/` exists as
 * a sibling of `dist/`. In a packaged install (no `src/` co-located),
 * the check is a no-op so it does not nag end-users.
 *
 * The check is also gated by `process.env.TWENTYTWOHUNDRED_SKIP_FRESHNESS`
 * (set to any truthy value to disable) ... a manual escape hatch for
 * scripted CI runs that intentionally use a slightly-stale bundle, or
 * for cases where the freshness logic itself misfires.
 *
 * Errors thrown by `fs.statSync` / directory walks are swallowed: a
 * misfiring freshness check must never block the actual CLI command.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

interface FreshnessOpts {
  /** Override the bundled-entry path. Defaults to current import.meta.url. */
  bundleEntryPath?: string
  /** Override stderr writer (testing). */
  stderrWrite?: (msg: string) => void
  /** Override the env-var check (testing). */
  skip?: boolean
}

/**
 * Run the freshness check. Returns one of:
 *   - `'ok'`            ... bundle is fresh, no warning emitted.
 *   - `'stale'`         ... bundle is stale, warning emitted.
 *   - `'not-dev'`       ... no co-located src/ tree, check skipped silently.
 *   - `'skipped'`       ... env var set, check skipped silently.
 *   - `'check-failed'`  ... internal error, check skipped silently.
 *
 * Public for testing. The default invocation (`runFreshnessCheck()`)
 * uses production defaults and discards the return value.
 */
export function runFreshnessCheck(
  opts: FreshnessOpts = {},
): 'ok' | 'stale' | 'not-dev' | 'skipped' | 'check-failed' {
  const skip = opts.skip ?? Boolean(process.env['TWENTYTWOHUNDRED_SKIP_FRESHNESS'])
  if (skip) return 'skipped'

  const stderrWrite = opts.stderrWrite ?? ((msg) => process.stderr.write(msg))

  try {
    const bundlePath = opts.bundleEntryPath ?? fileURLToPath(import.meta.url)
    const distRoot = resolve(dirname(bundlePath), '..') // .../dist or .../dist/cli/..
    // Walk up to the project root: parent that contains both `dist` and `src`.
    const projectRoot = findProjectRoot(distRoot)
    if (!projectRoot) return 'not-dev'

    const srcDir = join(projectRoot, 'src')
    if (!existsSync(srcDir)) return 'not-dev'

    const bundleMtime = statSync(bundlePath).mtimeMs
    const newestSrc = newestTsMtimeIn(srcDir, bundleMtime)
    if (newestSrc === null) return 'ok'
    if (newestSrc <= bundleMtime) return 'ok'

    stderrWrite(
      [
        '\x1b[33m',
        'WARN: 2200 CLI dist is older than src.',
        `      bundle: ${new Date(bundleMtime).toISOString()}`,
        `      newest src .ts: ${new Date(newestSrc).toISOString()}`,
        `      Run \`pnpm build\` from ${projectRoot} to refresh.`,
        '\x1b[0m',
        '',
      ].join('\n'),
    )
    return 'stale'
  } catch {
    // Never fail the CLI because of a freshness-check bug.
    return 'check-failed'
  }
}

/**
 * Walk upwards from `start` looking for a directory that contains both
 * `dist` and `src` (the project root). Returns null if not found within
 * a small depth budget.
 */
function findProjectRoot(start: string): string | null {
  let cur = start
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(cur, 'dist')) && existsSync(join(cur, 'src'))) {
      return cur
    }
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
  return null
}

/**
 * Recursive walk of `dir` looking for the newest .ts file mtime.
 * Short-circuits as soon as a file newer than `floor` is found (we
 * only need to know "is anything newer than the bundle"). Returns
 * null if no .ts file was found at all.
 */
function newestTsMtimeIn(dir: string, floor: number): number | null {
  let best: number | null = null
  const stack: string[] = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()
    if (cur === undefined) break
    let entries
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = join(cur, e.name)
      if (e.isDirectory()) {
        stack.push(p)
      } else if (e.isFile() && e.name.endsWith('.ts')) {
        let m: number
        try {
          m = statSync(p).mtimeMs
        } catch {
          continue
        }
        if (best === null || m > best) best = m
        // Short-circuit: once we've seen something newer than the
        // bundle, we know the answer. Don't keep walking.
        if (m > floor) return m
      }
    }
  }
  return best
}
