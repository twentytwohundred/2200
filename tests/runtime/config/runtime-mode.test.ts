import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RUNTIME_MODE,
  RUNTIME_MODES,
  RUNTIME_MODE_ENV_VAR,
  RuntimeModeError,
  isHosted,
  isHostedManaged,
  parseRuntimeMode,
  resolveRuntimeMode,
} from '../../../src/runtime/config/runtime-mode.js'

describe('parseRuntimeMode', () => {
  it('returns the default for undefined or empty input', () => {
    expect(parseRuntimeMode(undefined)).toBe(DEFAULT_RUNTIME_MODE)
    expect(parseRuntimeMode('')).toBe(DEFAULT_RUNTIME_MODE)
  })

  it('accepts each documented mode literally', () => {
    for (const mode of RUNTIME_MODES) {
      expect(parseRuntimeMode(mode)).toBe(mode)
    }
  })

  it('throws RuntimeModeError on an unknown value', () => {
    expect(() => parseRuntimeMode('cloud')).toThrow(RuntimeModeError)
    expect(() => parseRuntimeMode('hosted')).toThrow(RuntimeModeError)
    expect(() => parseRuntimeMode('byok')).toThrow(RuntimeModeError)
  })

  it('error message names the valid modes for ops debugging', () => {
    try {
      parseRuntimeMode('cloud')
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeModeError)
      const msg = err instanceof Error ? err.message : ''
      for (const mode of RUNTIME_MODES) {
        expect(msg).toContain(mode)
      }
      return
    }
    throw new Error('expected RuntimeModeError')
  })
})

describe('resolveRuntimeMode', () => {
  it('reads the documented env var', () => {
    expect(resolveRuntimeMode({ [RUNTIME_MODE_ENV_VAR]: 'hosted-byok' })).toBe('hosted-byok')
    expect(resolveRuntimeMode({ [RUNTIME_MODE_ENV_VAR]: 'hosted-managed' })).toBe('hosted-managed')
  })

  it('returns the default when the env var is unset', () => {
    expect(resolveRuntimeMode({})).toBe(DEFAULT_RUNTIME_MODE)
  })

  it('throws on an invalid env var value', () => {
    expect(() => resolveRuntimeMode({ [RUNTIME_MODE_ENV_VAR]: 'bogus' })).toThrow(RuntimeModeError)
  })

  it('ignores unrelated env vars', () => {
    expect(
      resolveRuntimeMode({
        UNRELATED: 'value',
        [`${RUNTIME_MODE_ENV_VAR}_NOT_THIS`]: 'hosted-managed',
      }),
    ).toBe(DEFAULT_RUNTIME_MODE)
  })
})

describe('isHosted / isHostedManaged', () => {
  it('isHostedManaged is true only for hosted-managed', () => {
    expect(isHostedManaged('self-hosted')).toBe(false)
    expect(isHostedManaged('hosted-byok')).toBe(false)
    expect(isHostedManaged('hosted-managed')).toBe(true)
  })

  it('isHosted is true for both hosted tiers, false for self-hosted', () => {
    expect(isHosted('self-hosted')).toBe(false)
    expect(isHosted('hosted-byok')).toBe(true)
    expect(isHosted('hosted-managed')).toBe(true)
  })
})

describe('DEFAULT_RUNTIME_MODE', () => {
  it('is self-hosted', () => {
    // Locked because every locally-installed instance must default to
    // self-hosted; the hosted tiers are opt-in via env var.
    expect(DEFAULT_RUNTIME_MODE).toBe('self-hosted')
  })
})
