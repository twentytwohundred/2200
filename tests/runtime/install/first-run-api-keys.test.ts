/**
 * Tests for the first-run API-key provider menu.
 *
 * The orchestrator's I/O is `FirstRunIO`; we drive prompts via a
 * recording stub and rely on a HOME redirect so the
 * `upsertRuntimeEnvKey` call lands in a tmp directory.
 *
 * The validator (`validateProviderKey`) is monkey-patched via the
 * global fetch so we don't actually hit any provider; auth/network
 * branches are exercised in `validate-key.test.ts`.
 *
 * What this file proves:
 *  - Menu lists every paste-a-key provider (no subscription, no local).
 *  - "Skip" exits the loop without writing anything.
 *  - A valid key gets written to runtime.env under the provider's
 *    default env-var name.
 *  - The loop continues after one save (operator may want multiple).
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  runFirstRunApiKeyProviders,
  type FirstRunIO,
} from '../../../src/runtime/install/first-run.js'
import { defaultRuntimeEnvPath } from '../../../src/runtime/config/runtime-env.js'

interface RecordingIO extends FirstRunIO {
  readonly info: (line: string) => void
  readonly warn: (line: string) => void
  readonly success: (line: string) => void
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
      const a = answers[i] ?? ''
      i++
      return Promise.resolve(a)
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

/**
 * Loose surface of the vitest spy methods we care about. Casting to
 * this avoids fighting the strict generic shape vi.spyOn returns when
 * `exactOptionalPropertyTypes` is on.
 */
interface FetchSpy {
  mockResolvedValue: (v: Response) => FetchSpy
  mockResolvedValueOnce: (v: Response) => FetchSpy
  mockRejectedValue: (v: unknown) => FetchSpy
  mockRestore: () => void
  // `toHaveBeenCalledTimes` matchers read this directly.
  mock: { calls: unknown[][] }
}

function spyFetch(): FetchSpy {
  return vi.spyOn(globalThis, 'fetch')
}

describe('runFirstRunApiKeyProviders', () => {
  let tmpRoot: string
  let savedHome: string | undefined
  let fetchSpy: FetchSpy | null = null

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), '2200-first-run-keys-'))
    // `defaultRuntimeEnvPath` uses `homedir()` which reads $HOME on
    // POSIX; redirect HOME so `upsertRuntimeEnvKey` lands in tmp
    // instead of clobbering the developer's real runtime.env.
    savedHome = process.env['HOME']
    process.env['HOME'] = tmpRoot
  })

  afterEach(async () => {
    if (savedHome === undefined) {
      Reflect.deleteProperty(process.env, 'HOME')
    } else {
      process.env['HOME'] = savedHome
    }
    fetchSpy?.mockRestore()
    fetchSpy = null
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('skips immediately when the operator picks the skip option', async () => {
    // The skip choice is the option whose number is `count + 1`.
    // We don't need to compute that exactly ... we know there are 7
    // paste-a-key providers right now, so "8" is the skip target.
    const io = makeIO(['8'])
    // Returns 0 so the caller knows NOT to restart the daemon (nothing to load).
    const added = await runFirstRunApiKeyProviders(io)
    expect(added).toBe(0)
    expect(io.successLines).toHaveLength(0)
    expect(io.infoLines.some((l) => /No API keys configured/i.test(l))).toBe(true)
  })

  it('lists every paste-a-key provider in the menu', async () => {
    const io = makeIO(['8']) // skip
    await runFirstRunApiKeyProviders(io)
    const menu = io.infoLines.join('\n')
    expect(menu).toContain('ANTHROPIC_API_KEY')
    expect(menu).toContain('OPENAI_API_KEY')
    expect(menu).toContain('DEEPSEEK_API_KEY')
    expect(menu).toContain('KIMI_API_KEY')
    expect(menu).toContain('OPENROUTER_API_KEY')
    expect(menu).toContain('XAI_API_KEY')
    expect(menu).toContain('GEMINI_API_KEY')
    expect(menu).not.toContain('XAI_SUBSCRIPTION')
    expect(menu).not.toContain('LOCAL_API_KEY')
  })

  it('saves a validated key to runtime.env and loops back to the menu', async () => {
    fetchSpy = spyFetch()
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }))
    const io = makeIO(['1', 'sk-ant-good', '8'])
    // Returns the count so the caller restarts the daemon to load the new key
    // (the fix for "pasted key is dead until a restart the wizard never did").
    const added = await runFirstRunApiKeyProviders(io)
    expect(added).toBe(1)

    expect(fetchSpy.mock.calls).toHaveLength(1)
    const contents = await readFile(defaultRuntimeEnvPath(), 'utf-8')
    expect(contents).toContain('ANTHROPIC_API_KEY=sk-ant-good')
    expect(io.successLines.some((l) => l.includes('verified and saved'))).toBe(true)
    expect(io.infoLines.some((l) => l.includes('Added 1 so far'))).toBe(true)
  })

  it('re-prompts on auth_failed and saves on a subsequent good key', async () => {
    fetchSpy = spyFetch()
    fetchSpy
      .mockResolvedValueOnce(new Response('bad key', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    // Choose OpenAI (index 2), paste a bad key, then a good one,
    // then skip.
    const io = makeIO(['2', 'sk-bad', 'sk-good', '8'])
    await runFirstRunApiKeyProviders(io)

    expect(fetchSpy.mock.calls).toHaveLength(2)
    const contents = await readFile(defaultRuntimeEnvPath(), 'utf-8')
    expect(contents).toContain('OPENAI_API_KEY=sk-good')
    expect(io.warnLines.some((l) => l.includes('rejected the key'))).toBe(true)
  })

  it('saves an unverified key when the operator confirms after a network error', async () => {
    fetchSpy = spyFetch()
    fetchSpy.mockRejectedValue(new Error('ENOTFOUND api.openai.com'))
    const io = makeIO(['2', 'sk-offline', 'y', '8'])
    await runFirstRunApiKeyProviders(io)

    const contents = await readFile(defaultRuntimeEnvPath(), 'utf-8')
    expect(contents).toContain('OPENAI_API_KEY=sk-offline')
    expect(io.warnLines.some((l) => l.includes('Could not reach'))).toBe(true)
    expect(io.successLines.some((l) => l.includes('saved unverified'))).toBe(true)
  })

  it('aborts the provider when the operator declines after a network error', async () => {
    fetchSpy = spyFetch()
    fetchSpy.mockRejectedValue(new Error('ENOTFOUND api.openai.com'))
    const io = makeIO(['2', 'sk-offline', 'n', '8'])
    await runFirstRunApiKeyProviders(io)

    await expect(readFile(defaultRuntimeEnvPath(), 'utf-8')).rejects.toThrow()
    expect(io.infoLines.some((l) => l.includes('Discarded'))).toBe(true)
  })
})
