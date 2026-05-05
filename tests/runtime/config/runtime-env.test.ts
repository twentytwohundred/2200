import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseRuntimeEnv,
  loadRuntimeEnv,
  RuntimeEnvParseError,
  defaultRuntimeEnvPath,
} from '../../../src/runtime/config/runtime-env.js'

describe('runtime-env parser', () => {
  it('parses bare KEY=value', () => {
    expect(parseRuntimeEnv('FOO=bar')).toEqual({ FOO: 'bar' })
  })

  it('parses export-prefixed lines', () => {
    expect(parseRuntimeEnv('export FOO=bar')).toEqual({ FOO: 'bar' })
  })

  it('parses multiple lines preserving key order semantics', () => {
    const parsed = parseRuntimeEnv(
      [
        '# header comment',
        'export FOO=one',
        '',
        'BAR=two',
        '   ',
        '# trailing comment',
        'BAZ=three',
      ].join('\n'),
    )
    expect(parsed).toEqual({ FOO: 'one', BAR: 'two', BAZ: 'three' })
  })

  it('strips surrounding double quotes', () => {
    expect(parseRuntimeEnv('export FOO="bar baz"')).toEqual({ FOO: 'bar baz' })
  })

  it('strips surrounding single quotes', () => {
    expect(parseRuntimeEnv("export FOO='bar baz'")).toEqual({ FOO: 'bar baz' })
  })

  it('does NOT strip mismatched quote pairs', () => {
    expect(parseRuntimeEnv(`FOO="bar'`)).toEqual({ FOO: `"bar'` })
  })

  it('preserves equals signs inside the value', () => {
    expect(parseRuntimeEnv('FOO=a=b=c')).toEqual({ FOO: 'a=b=c' })
  })

  it('preserves leading internal whitespace in the value', () => {
    expect(parseRuntimeEnv('FOO=  bar')).toEqual({ FOO: '  bar' })
  })

  it('strips trailing whitespace from the value', () => {
    expect(parseRuntimeEnv('FOO=bar   ')).toEqual({ FOO: 'bar' })
  })

  it('ignores blank lines and comments', () => {
    expect(parseRuntimeEnv('\n\n# only comments\n\n')).toEqual({})
  })

  it('returns empty record for empty input', () => {
    expect(parseRuntimeEnv('')).toEqual({})
  })

  it('throws on a line missing the equals sign', () => {
    expect(() => parseRuntimeEnv('FOO\nBAR=baz')).toThrowError(RuntimeEnvParseError)
  })

  it('throws on a key that does not match the allowed pattern', () => {
    expect(() => parseRuntimeEnv('foo=bar')).toThrowError(RuntimeEnvParseError)
    expect(() => parseRuntimeEnv('1FOO=bar')).toThrowError(RuntimeEnvParseError)
    expect(() => parseRuntimeEnv('FOO BAR=baz')).toThrowError(RuntimeEnvParseError)
  })

  it('reports the line number on parse errors', () => {
    try {
      parseRuntimeEnv('FOO=ok\n# comment\nBAD line\nLAST=ok')
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeEnvParseError)
      expect((err as RuntimeEnvParseError).line).toBe(3)
    }
  })
})

describe('loadRuntimeEnv', () => {
  it('returns empty record when the file does not exist', async () => {
    expect(await loadRuntimeEnv('/tmp/2200-nonexistent-runtime-env-xyz123.env')).toEqual({})
  })

  it('reads and parses a real file', async () => {
    const dir = await mkdtemp(join(tmpdir(), '2200-runtime-env-'))
    const path = join(dir, 'runtime.env')
    await writeFile(
      path,
      ['# comment', 'export DEEPSEEK_API_KEY=sk-test-123', 'OTHER=value'].join('\n'),
    )
    await chmod(path, 0o600)
    const env = await loadRuntimeEnv(path)
    expect(env).toEqual({ DEEPSEEK_API_KEY: 'sk-test-123', OTHER: 'value' })
  })
})

describe('defaultRuntimeEnvPath', () => {
  it('points at $HOME/.config/2200/runtime.env', () => {
    expect(defaultRuntimeEnvPath()).toMatch(/\.config\/2200\/runtime\.env$/)
  })
})
