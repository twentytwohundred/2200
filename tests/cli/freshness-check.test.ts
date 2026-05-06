import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, mkdir, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runFreshnessCheck } from '../../src/cli/freshness-check.js'

async function makeProject(): Promise<{
  root: string
  bundle: string
  srcMain: string
}> {
  const root = await mkdtemp(join(tmpdir(), '2200-freshness-test-'))
  await mkdir(join(root, 'dist', 'cli'), { recursive: true })
  await mkdir(join(root, 'src', 'cli'), { recursive: true })
  const bundle = join(root, 'dist', 'cli', 'main.js')
  const srcMain = join(root, 'src', 'cli', 'main.ts')
  await writeFile(bundle, '// bundle')
  await writeFile(srcMain, '// source')
  return { root, bundle, srcMain }
}

async function setMtime(path: string, isoStr: string): Promise<void> {
  const t = new Date(isoStr)
  await utimes(path, t, t)
}

describe('runFreshnessCheck', () => {
  it('returns ok when src is older than bundle', async () => {
    const { bundle, srcMain } = await makeProject()
    await setMtime(srcMain, '2024-01-01T00:00:00Z')
    await setMtime(bundle, '2024-06-01T00:00:00Z')
    const captured: string[] = []
    const result = runFreshnessCheck({
      bundleEntryPath: bundle,
      stderrWrite: (m) => captured.push(m),
    })
    expect(result).toBe('ok')
    expect(captured).toEqual([])
  })

  it('returns stale and emits a warning when src is newer than bundle', async () => {
    const { bundle, srcMain } = await makeProject()
    await setMtime(bundle, '2024-01-01T00:00:00Z')
    await setMtime(srcMain, '2024-06-01T00:00:00Z')
    const captured: string[] = []
    const result = runFreshnessCheck({
      bundleEntryPath: bundle,
      stderrWrite: (m) => captured.push(m),
    })
    expect(result).toBe('stale')
    expect(captured.length).toBe(1)
    expect(captured[0]).toContain('2200 CLI dist is older than src')
    expect(captured[0]).toContain('pnpm build')
  })

  it('walks subdirectories under src/', async () => {
    const { root, bundle } = await makeProject()
    const deep = join(root, 'src', 'runtime', 'oauth')
    await mkdir(deep, { recursive: true })
    const deepFile = join(deep, 'flow.ts')
    await writeFile(deepFile, '// deep')
    await setMtime(bundle, '2024-01-01T00:00:00Z')
    await setMtime(deepFile, '2024-06-01T00:00:00Z')
    const captured: string[] = []
    const result = runFreshnessCheck({
      bundleEntryPath: bundle,
      stderrWrite: (m) => captured.push(m),
    })
    expect(result).toBe('stale')
    expect(captured.length).toBe(1)
  })

  it('returns not-dev when there is no src/ co-located with dist/', async () => {
    const root = await mkdtemp(join(tmpdir(), '2200-freshness-no-src-'))
    await mkdir(join(root, 'dist', 'cli'), { recursive: true })
    const bundle = join(root, 'dist', 'cli', 'main.js')
    await writeFile(bundle, '// bundle')
    const captured: string[] = []
    const result = runFreshnessCheck({
      bundleEntryPath: bundle,
      stderrWrite: (m) => captured.push(m),
    })
    expect(result).toBe('not-dev')
    expect(captured).toEqual([])
  })

  it('returns skipped when the env-var override is set', async () => {
    const { bundle, srcMain } = await makeProject()
    await setMtime(bundle, '2024-01-01T00:00:00Z')
    await setMtime(srcMain, '2024-06-01T00:00:00Z')
    const captured: string[] = []
    const result = runFreshnessCheck({
      bundleEntryPath: bundle,
      stderrWrite: (m) => captured.push(m),
      skip: true,
    })
    expect(result).toBe('skipped')
    expect(captured).toEqual([])
  })

  it('does not throw on a non-existent bundle path', () => {
    const result = runFreshnessCheck({
      bundleEntryPath: '/definitely/not/a/real/path/main.js',
      stderrWrite: () => undefined,
    })
    // Either 'not-dev' (project root walk fails) or 'check-failed';
    // both are acceptable degraded outcomes. The contract is "do not throw".
    expect(['not-dev', 'check-failed', 'ok']).toContain(result)
  })
})
