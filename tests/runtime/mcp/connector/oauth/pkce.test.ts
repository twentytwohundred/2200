import { describe, expect, it } from 'vitest'
import {
  computePkceChallenge,
  isWellFormedChallenge,
  verifyPkceS256,
} from '../../../../../src/runtime/mcp/connector/oauth/pkce.js'

describe('PKCE S256', () => {
  it('round-trips a valid verifier → challenge → verifier match', () => {
    const verifier = 'thisIsAValidVerifierAtLeast43CharactersLong-abc'
    const challenge = computePkceChallenge(verifier)
    expect(isWellFormedChallenge(challenge)).toBe(true)
    expect(verifyPkceS256(verifier, challenge)).toBe(true)
  })

  it('rejects a wrong verifier even with a well-formed challenge', () => {
    const right = 'thisIsAValidVerifierAtLeast43CharactersLong-abc'
    const wrong = 'thisIsADifferentVerifierAtLeast43CharsLongDef-xy'
    const challenge = computePkceChallenge(right)
    expect(verifyPkceS256(wrong, challenge)).toBe(false)
  })

  it('rejects too-short verifiers (<43 chars per RFC 7636)', () => {
    expect(verifyPkceS256('tooshort', computePkceChallenge('tooshort'))).toBe(false)
  })

  it('rejects verifiers with disallowed characters', () => {
    const bad = 'has-a-space and stuff '.padEnd(50, 'a')
    expect(verifyPkceS256(bad, computePkceChallenge(bad))).toBe(false)
  })

  it('rejects malformed challenges', () => {
    expect(isWellFormedChallenge('too-short')).toBe(false)
    expect(isWellFormedChallenge('a'.repeat(43))).toBe(true) // exactly 43 base64url chars
    expect(isWellFormedChallenge('!'.repeat(43))).toBe(false) // disallowed chars
  })
})
