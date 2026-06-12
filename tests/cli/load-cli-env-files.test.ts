/**
 * Tests for `loadCliEnvFiles` ... the CLI startup hook that sources
 * `~/.config/2200/runtime.env` (and `oauth-apps.env`) into the CLI's
 * own `process.env`.
 *
 * Why this matters: the supervisor daemon sources these files at its
 * own startup so every spawned Agent sees them. The CLI process,
 * however, runs in the user's bare shell and does NOT inherit them
 * unless we read them explicitly. Without that, anything that calls
 * `resolveProvider`/`resolveSecret` from a fresh `2200 ...` invocation
 * fails with "env var 'XXX' is not set" even when the key is correctly
 * saved on disk (live regression 2026-06-03: completed first-run,
 * `2200 agent build` chose deepseek via auto-pick then crashed because
 * DEEPSEEK_API_KEY wasn't in the CLI's process.env).
 *
 * The function is wired as a `preAction` hook on the program in
 * `buildProgram`; that wiring is verified by code review (no public
 * commander API to enumerate hooks). This file proves the helper
 * itself does what its name says.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCliEnvFiles } from '../../src/cli/main.js'

const TOUCHED_KEYS = [
  // Keys this test may write to / clear from process.env. Restored on
  // teardown so the test doesn't pollute downstream tests in the same
  // vitest worker.
  'ANTHROPIC_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY',
  '_2200_OAUTH_GOOGLE_CLIENT_ID',
] as const

describe('loadCliEnvFiles', () => {
  let tmpRoot: string
  let savedHome: string | undefined
  let savedEnv: Record<string, string | undefined> = {}

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), '2200-cli-env-'))
    savedHome = process.env['HOME']
    process.env['HOME'] = tmpRoot
    savedEnv = {}
    for (const k of TOUCHED_KEYS) {
      savedEnv[k] = process.env[k]
      Reflect.deleteProperty(process.env, k)
    }
  })

  afterEach(async () => {
    if (savedHome === undefined) {
      Reflect.deleteProperty(process.env, 'HOME')
    } else {
      process.env['HOME'] = savedHome
    }
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        Reflect.deleteProperty(process.env, k)
      } else {
        process.env[k] = v
      }
    }
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('is a no-op when neither runtime.env nor oauth-apps.env exists', async () => {
    // First-run case: a fresh box. The helper should silently no-op so
    // the wizard can prompt for keys; throwing here would break the
    // very first `2200` invocation.
    await expect(loadCliEnvFiles()).resolves.toBeUndefined()
    expect(process.env['ANTHROPIC_API_KEY']).toBeUndefined()
  })

  it('copies keys from runtime.env into process.env', async () => {
    const cfgDir = join(tmpRoot, '.config', '2200')
    await mkdir(cfgDir, { recursive: true })
    await writeFile(
      join(cfgDir, 'runtime.env'),
      ['export ANTHROPIC_API_KEY=sk-ant-fromfile', 'DEEPSEEK_API_KEY=sk-deep-fromfile', ''].join(
        '\n',
      ),
    )
    await loadCliEnvFiles()
    expect(process.env['ANTHROPIC_API_KEY']).toBe('sk-ant-fromfile')
    expect(process.env['DEEPSEEK_API_KEY']).toBe('sk-deep-fromfile')
  })

  it('also reads oauth-apps.env from the same directory', async () => {
    const cfgDir = join(tmpRoot, '.config', '2200')
    await mkdir(cfgDir, { recursive: true })
    // Two files, two distinct keys. Both should land in process.env.
    await writeFile(join(cfgDir, 'runtime.env'), 'OPENAI_API_KEY=sk-openai\n')
    await writeFile(join(cfgDir, 'oauth-apps.env'), '_2200_OAUTH_GOOGLE_CLIENT_ID=google-cid\n')
    await loadCliEnvFiles()
    expect(process.env['OPENAI_API_KEY']).toBe('sk-openai')
    expect(process.env['_2200_OAUTH_GOOGLE_CLIENT_ID']).toBe('google-cid')
  })

  it('does not overwrite values already present in process.env', async () => {
    // Operator override: an explicit export in the parent shell takes
    // precedence over the on-disk file. This is the documented
    // contract; first-run users on a transient demo key may set
    // ANTHROPIC_API_KEY just for one invocation without editing
    // runtime.env. Saving the operator's intent matters.
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-from-shell'
    const cfgDir = join(tmpRoot, '.config', '2200')
    await mkdir(cfgDir, { recursive: true })
    await writeFile(join(cfgDir, 'runtime.env'), 'ANTHROPIC_API_KEY=sk-ant-fromfile\n')
    await loadCliEnvFiles()
    expect(process.env['ANTHROPIC_API_KEY']).toBe('sk-ant-from-shell')
  })
})
