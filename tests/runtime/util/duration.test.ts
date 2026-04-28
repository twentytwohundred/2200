import { describe, expect, it } from 'vitest'
import { DurationParseError, parseDurationSeconds } from '../../../src/runtime/util/duration.js'

describe('parseDurationSeconds', () => {
  it('parses seconds', () => {
    expect(parseDurationSeconds('30s')).toBe(30)
  })
  it('parses minutes', () => {
    expect(parseDurationSeconds('5m')).toBe(300)
  })
  it('parses hours', () => {
    expect(parseDurationSeconds('2h')).toBe(7200)
  })
  it('parses days', () => {
    expect(parseDurationSeconds('1d')).toBe(86400)
  })
  it('is case-insensitive', () => {
    expect(parseDurationSeconds('5M')).toBe(300)
  })
  it('trims surrounding whitespace', () => {
    expect(parseDurationSeconds('  10s  ')).toBe(10)
  })
  it('rejects an empty string', () => {
    expect(() => parseDurationSeconds('')).toThrow(DurationParseError)
  })
  it('rejects a missing unit', () => {
    expect(() => parseDurationSeconds('30')).toThrow(DurationParseError)
  })
  it('rejects unknown units', () => {
    expect(() => parseDurationSeconds('5w')).toThrow(DurationParseError)
  })
  it('rejects compound durations', () => {
    expect(() => parseDurationSeconds('1h30m')).toThrow(DurationParseError)
  })
  it('rejects zero', () => {
    expect(() => parseDurationSeconds('0s')).toThrow(DurationParseError)
  })
})
