/**
 * Tests for the quick-setup helpers (the "paste install → end at a URL"
 * path). The full runQuickSetup needs a live daemon and is exercised in
 * a clean container; here we pin the pure pieces that compose the final
 * access block, since that block is the whole point of the feature.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { primaryLanIp } from '../../../src/runtime/util/lan-ip.js'
import { printWebAccess, webPortFromEnv } from '../../../src/runtime/install/quick-setup.js'

describe('webPortFromEnv', () => {
  const saved = process.env['TWENTYTWOHUNDRED_WEB_PORT']
  afterEach(() => {
    if (saved === undefined) delete process.env['TWENTYTWOHUNDRED_WEB_PORT']
    else process.env['TWENTYTWOHUNDRED_WEB_PORT'] = saved
  })

  it('defaults to 2200', () => {
    delete process.env['TWENTYTWOHUNDRED_WEB_PORT']
    expect(webPortFromEnv()).toBe(2200)
  })

  it('honors a valid override and ignores garbage', () => {
    process.env['TWENTYTWOHUNDRED_WEB_PORT'] = '4321'
    expect(webPortFromEnv()).toBe(4321)
    process.env['TWENTYTWOHUNDRED_WEB_PORT'] = 'not-a-port'
    expect(webPortFromEnv()).toBe(2200)
  })
})

describe('primaryLanIp', () => {
  it('returns null or a non-loopback IPv4 (never 127.x)', () => {
    const ip = primaryLanIp()
    if (ip !== null) {
      expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
      expect(ip.startsWith('127.')).toBe(false)
    }
  })
})

describe('printWebAccess', () => {
  function capture(args: { migratedAgent: string | null; freshInstall: boolean }): string {
    const lines: string[] = []
    printWebAccess({
      port: 2200,
      token: 'tok_abc123',
      migratedAgent: args.migratedAgent,
      freshInstall: args.freshInstall,
      out: (l) => lines.push(l),
    })
    return lines.join('\n')
  }

  it('embeds the token in the URL and prints the bare token', () => {
    const out = capture({ migratedAgent: null, freshInstall: true })
    expect(out).toContain('?token=tok_abc123')
    expect(out).toContain('Bearer token')
    expect(out).toContain('tok_abc123')
    expect(out).toContain('2200 is ready.')
  })

  it('a migrated user is told their Agent is ready, NOT to build one', () => {
    const out = capture({ migratedAgent: 'skippy', freshInstall: false })
    expect(out).toContain('"skippy" is already there')
    expect(out).not.toContain('creating your first Agent')
  })

  it('a fresh user is pointed at building their first Agent in the web app', () => {
    const out = capture({ migratedAgent: null, freshInstall: true })
    expect(out).toContain('creating your first Agent')
  })
})
