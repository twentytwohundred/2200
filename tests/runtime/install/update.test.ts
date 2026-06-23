/**
 * Tests for the self-upgrade machinery in `runtime/install/update.ts`.
 *
 * The compare/parse helpers and the install-source detector are pure;
 * they test directly. The registry fetcher is tested through a stubbed
 * `fetch` implementation so the suite is deterministic and offline-safe.
 */
import { describe, expect, it } from 'vitest'
import type { spawn } from 'node:child_process'
import {
  checkLatestVersion,
  compareSemver,
  detectInstallSource,
  restartDaemonFresh,
} from '../../../src/runtime/install/update.js'

describe('compareSemver', () => {
  it('treats identical versions as equal', () => {
    // Regression guard for the up-to-date path: if this returns
    // non-zero, every `2200 update` invocation would falsely
    // recommend a reinstall.
    expect(compareSemver('0.1.0', '0.1.0')).toBe(0)
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0)
  })

  it('orders by major.minor.patch', () => {
    expect(compareSemver('0.1.0', '0.2.0')).toBe(-1)
    expect(compareSemver('0.2.0', '0.1.0')).toBe(1)
    expect(compareSemver('1.0.0', '2.0.0')).toBe(-1)
    expect(compareSemver('1.10.0', '1.2.0')).toBe(1) // numeric, not lexical
    expect(compareSemver('1.0.10', '1.0.2')).toBe(1)
  })

  it('prereleases sort below the same release', () => {
    // npm-style: `1.0.0-rc.1` is older than `1.0.0`. If we got this
    // backwards, `2200 update` would offer a downgrade.
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBe(-1)
    expect(compareSemver('1.0.0', '1.0.0-rc.1')).toBe(1)
    expect(compareSemver('1.0.0-rc.1', '1.0.0-rc.2')).toBe(-1)
  })

  it('ignores build metadata', () => {
    expect(compareSemver('1.0.0+build.1', '1.0.0+build.2')).toBe(0)
  })

  it('treats missing segments as zero', () => {
    // Defensive parsing: registry-supplied tags are clean semver, but
    // we guard against malformed local strings (e.g., a hand-edited
    // package.json) so the CLI does not crash on `2200 update`.
    expect(compareSemver('1', '1.0.0')).toBe(0)
    expect(compareSemver('1.0', '1.0.0')).toBe(0)
  })
})

describe('checkLatestVersion', () => {
  function stubFetch(body: unknown, opts: { status?: number } = {}): typeof fetch {
    const status = opts.status ?? 200
    const fakeResponse: Response = {
      ok: status >= 200 && status < 300,
      status,
      json: (): Promise<unknown> => Promise.resolve(body),
    } as unknown as Response
    const impl: typeof fetch = (_input, _init) => Promise.resolve(fakeResponse)
    return impl
  }

  it('reports up-to-date when current === latest', async () => {
    const result = await checkLatestVersion('0.1.0', {
      registryUrl: 'https://example.test/pkg',
      fetchImpl: stubFetch({ 'dist-tags': { latest: '0.1.0' } }),
    })
    expect(result.kind).toBe('up-to-date')
    if (result.kind === 'up-to-date') {
      expect(result.current).toBe('0.1.0')
      expect(result.latest).toBe('0.1.0')
    }
  })

  it('reports update-available when current < latest', async () => {
    const result = await checkLatestVersion('0.1.0', {
      registryUrl: 'https://example.test/pkg',
      fetchImpl: stubFetch({ 'dist-tags': { latest: '0.2.0' } }),
    })
    expect(result.kind).toBe('update-available')
  })

  it('reports ahead when current > latest (e.g., pre-publish builds)', async () => {
    // Source-checkout case after a version bump but before publish:
    // current is newer than the registry's latest. We should not
    // suggest "downgrading."
    const result = await checkLatestVersion('0.2.0', {
      registryUrl: 'https://example.test/pkg',
      fetchImpl: stubFetch({ 'dist-tags': { latest: '0.1.0' } }),
    })
    expect(result.kind).toBe('ahead')
  })

  it('reports registry-error on HTTP failure', async () => {
    const result = await checkLatestVersion('0.1.0', {
      registryUrl: 'https://example.test/pkg',
      fetchImpl: stubFetch({}, { status: 503 }),
    })
    expect(result.kind).toBe('registry-error')
    if (result.kind === 'registry-error') {
      expect(result.message).toMatch(/503/)
    }
  })

  it('reports registry-error when dist-tags.latest is missing', async () => {
    // The package may exist on the registry but have no published
    // versions yet (e.g., immediately after the org is reserved). We
    // surface this as a registry-error so the user is not told "no
    // update available" when in fact we cannot answer.
    const result = await checkLatestVersion('0.1.0', {
      registryUrl: 'https://example.test/pkg',
      fetchImpl: stubFetch({ 'dist-tags': {} }),
    })
    expect(result.kind).toBe('registry-error')
  })

  it('reports registry-error on network error', async () => {
    const fetchThrows = ((): Promise<Response> =>
      Promise.reject(new Error('offline'))) as unknown as typeof fetch
    const result = await checkLatestVersion('0.1.0', {
      registryUrl: 'https://example.test/pkg',
      fetchImpl: fetchThrows,
    })
    expect(result.kind).toBe('registry-error')
    if (result.kind === 'registry-error') {
      expect(result.message).toMatch(/offline/)
    }
  })
})

describe('detectInstallSource', () => {
  it('flags a node_modules path as managed install', () => {
    // Anything under node_modules is considered upgradable via npm.
    expect(
      detectInstallSource('/usr/local/lib/node_modules/@twentytwohundred/2200/dist/cli/main.js'),
    ).toEqual({
      kind: 'npm-global',
      path: '/usr/local/lib/node_modules/@twentytwohundred/2200/dist/cli/main.js',
    })
    expect(
      detectInstallSource(
        '/Users/x/.npm-global/lib/node_modules/@twentytwohundred/2200/dist/index.js',
      ),
    ).toEqual({
      kind: 'npm-global',
      path: '/Users/x/.npm-global/lib/node_modules/@twentytwohundred/2200/dist/index.js',
    })
  })

  it('flags a source checkout as non-upgradable', () => {
    // A path with no node_modules segment is treated as a dev
    // checkout, which we refuse to auto-upgrade. Reason: pnpm-link
    // or `pnpm cli` from the repo loads dist/ directly, and running
    // `npm install -g` on top of it would create a parallel install
    // that shadows the dev binary unpredictably.
    expect(detectInstallSource('/Users/me/code/2200/dist/cli/main.js')).toEqual({
      kind: 'source-checkout',
      path: '/Users/me/code/2200/dist/cli/main.js',
    })
  })

  it('handles Windows-style paths', () => {
    // POSIX paths dominate, but we accept Windows separators for
    // robustness ... future Windows support should not require a
    // detector rewrite.
    expect(
      detectInstallSource(
        'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@twentytwohundred\\2200\\dist\\index.js',
      ),
    ).toEqual({
      kind: 'npm-global',
      path: 'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@twentytwohundred\\2200\\dist\\index.js',
    })
  })
})

describe('restartDaemonFresh', () => {
  // The restart spawns the freshly-installed `daemon start` FULLY DETACHED and
  // confirms liveness by polling the supervisor lock ... NOT by awaiting the
  // child. That decoupling is the fix for the remote/SSH update where the
  // parent `2200 update` process dies the instant the command returns and used
  // to take the half-started daemon down with it. A fake spawn keeps these
  // unit tests from launching a real daemon.
  let spawned: { command: string; args: string[]; options: unknown } | null
  let unrefCalled: boolean
  function fakeSpawn(): typeof spawn {
    spawned = null
    unrefCalled = false
    return ((command: string, args: string[], options: unknown) => {
      spawned = { command, args, options }
      return { unref: () => (unrefCalled = true) }
    }) as unknown as typeof spawn
  }

  it('spawns daemon-start detached + stdio-ignore + unref (survives a dying parent)', async () => {
    await restartDaemonFresh({
      mainPath: '/fresh/main.js',
      home: '/h',
      spawnImpl: fakeSpawn(),
      confirmUp: () => Promise.resolve(true),
      sleepMs: () => Promise.resolve(),
    })
    expect(spawned?.args).toEqual(['/fresh/main.js', '--home', '/h', 'daemon', 'start'])
    expect(spawned?.options).toMatchObject({ detached: true, stdio: 'ignore' })
    expect(unrefCalled).toBe(true)
  })

  it('returns 0 once the supervisor lock is held (does not await the child)', async () => {
    let polls = 0
    const code = await restartDaemonFresh({
      mainPath: '/fresh/main.js',
      home: '/h',
      spawnImpl: fakeSpawn(),
      confirmUp: () => Promise.resolve(++polls >= 2), // up on the 2nd poll
      sleepMs: () => Promise.resolve(),
    })
    expect(code).toBe(0)
    expect(polls).toBeGreaterThanOrEqual(2)
  })

  it('returns 1 when the daemon never comes up within the window', async () => {
    const code = await restartDaemonFresh({
      mainPath: '/fresh/main.js',
      home: '/h',
      spawnImpl: fakeSpawn(),
      confirmUp: () => Promise.resolve(false),
      sleepMs: () => Promise.resolve(),
      waitMs: 50,
    })
    expect(code).toBe(1)
  })
})
