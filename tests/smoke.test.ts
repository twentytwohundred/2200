import { describe, expect, it } from 'vitest'
import { VERSION } from '../src/index.js'

describe('smoke', () => {
  it('exports a semver-shaped VERSION string', () => {
    expect(typeof VERSION).toBe('string')
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
