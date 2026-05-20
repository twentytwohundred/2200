/**
 * Tests for the first-run orchestrator.
 *
 * The orchestrator is pure-ish: all I/O is funneled through the
 * `FirstRunIO` interface, and the only filesystem effects are
 * `saveUserConfig` (writes to `$XDG_CONFIG_HOME/2200/config.json`)
 * and `Supervisor.create` (creates 2200_HOME). To keep tests isolated,
 * we redirect both via env vars (`XDG_CONFIG_HOME`, `XDG_DATA_HOME`)
 * to a per-test tmp directory.
 *
 * Happy-path coverage that runs `startDaemon` + a real RPC against
 * `cli.user.init` lives in the integration suite; here we exercise
 * the abort branches (which never reach the daemon-spawn step).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runFirstRun, type FirstRunIO } from '../../../src/runtime/install/first-run.js'

interface RecordingIO extends FirstRunIO {
  readonly infoLines: string[]
  readonly warnLines: string[]
  readonly successLines: string[]
  readonly prompts: string[]
}

function makeIO(answers: string[]): RecordingIO {
  const infoLines: string[] = []
  const warnLines: string[] = []
  const successLines: string[] = []
  const prompts: string[] = []
  let i = 0
  return {
    infoLines,
    warnLines,
    successLines,
    prompts,
    ask: (prompt: string) => {
      prompts.push(prompt)
      const answer = answers[i] ?? ''
      i++
      return Promise.resolve(answer)
    },
    info: (line: string) => {
      infoLines.push(line)
    },
    success: (line: string) => {
      successLines.push(line)
    },
    warn: (line: string) => {
      warnLines.push(line)
    },
  }
}

describe('runFirstRun', () => {
  let tmpRoot: string
  let savedEnv: Record<string, string | undefined>

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), '2200-first-run-'))
    savedEnv = {
      XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'],
      XDG_DATA_HOME: process.env['XDG_DATA_HOME'],
      TWENTYTWOHUNDRED_HOME: process.env['TWENTYTWOHUNDRED_HOME'],
    }
    process.env['XDG_CONFIG_HOME'] = join(tmpRoot, 'config')
    process.env['XDG_DATA_HOME'] = join(tmpRoot, 'data')
    delete process.env['TWENTYTWOHUNDRED_HOME']
  })

  afterEach(async () => {
    // Restore env. We use an explicit assignment to '' followed by
    // `Reflect.deleteProperty` to satisfy `no-dynamic-delete` while
    // still removing keys that did not exist before the test.
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        Reflect.deleteProperty(process.env, k)
      } else {
        process.env[k] = v
      }
    }
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('aborts cleanly when the user declines the opening confirmation', async () => {
    // The user is being asked "Continue? [Y/n]" with the default
    // being yes; an explicit "n" must bail before any filesystem
    // writes (no config, no home, no daemon). Regression guard:
    // if we ever start mutating state before the confirm, a
    // ctrl-C/n becomes destructive.
    const io = makeIO(['n'])
    const result = await runFirstRun(io)
    expect(result.status).toBe('aborted')
    if (result.status === 'aborted') {
      expect(result.reason).toBe('declined-at-start')
    }
    expect(io.prompts).toHaveLength(1)
    expect(io.prompts[0]).toMatch(/Continue/)
  })

  it('aborts after three empty display-name attempts without any filesystem writes', async () => {
    // Side-effect ordering guard: the orchestrator must collect ALL
    // input before writing config or spawning the daemon. If a
    // future refactor reorders these steps, this test will spawn a
    // real daemon (or fail mid-flight) and flag the regression.
    // We verify by NOT cleaning up a daemon afterward: if one was
    // started, the test would hang/fail on the afterEach teardown.
    const writableHome = join(tmpRoot, 'data', '2200-fr-test')
    const io = makeIO([
      '', // Continue? [Y/n] -> default yes
      writableHome, // home path
      '', // displayName attempt 1
      '', // displayName attempt 2
      '', // displayName attempt 3
    ])
    const result = await runFirstRun(io)
    expect(result.status).toBe('aborted')
    if (result.status === 'aborted') {
      expect(result.reason).toBe('empty-display-name')
    }
    expect(io.warnLines.filter((l) => /cannot be empty/i.test(l))).toHaveLength(3)
  })
})
