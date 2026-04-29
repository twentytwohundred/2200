import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { generatePkce, generateState } from '../../../src/runtime/oauth/pkce.js'

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

describe('generatePkce', () => {
  it('produces a verifier in the RFC-7636 length window', () => {
    const p = generatePkce()
    expect(p.verifier.length).toBeGreaterThanOrEqual(43)
    expect(p.verifier.length).toBeLessThanOrEqual(128)
  })

  it('produces a base64url-shaped verifier (no +, /, or = padding)', () => {
    const p = generatePkce()
    expect(p.verifier).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('challenge is base64url(sha256(verifier))', () => {
    const p = generatePkce()
    const recomputed = base64url(createHash('sha256').update(p.verifier).digest())
    expect(p.challenge).toBe(recomputed)
  })

  it('method is "S256"', () => {
    expect(generatePkce().method).toBe('S256')
  })

  it('two consecutive calls produce different verifiers', () => {
    const a = generatePkce()
    const b = generatePkce()
    expect(a.verifier).not.toBe(b.verifier)
    expect(a.challenge).not.toBe(b.challenge)
  })
})

describe('generateState', () => {
  it('produces a base64url string of reasonable length', () => {
    const s = generateState()
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(s.length).toBeGreaterThanOrEqual(20)
  })

  it('produces unique values across calls', () => {
    expect(generateState()).not.toBe(generateState())
  })
})
