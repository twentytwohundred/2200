/**
 * Tests for the quick-setup helpers (the "paste install → end at a URL"
 * path). The full runQuickSetup needs a live daemon and is exercised in
 * a clean container; here we pin the pure pieces that compose the final
 * access block, since that block is the whole point of the feature.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { primaryLanIp, tailscaleIp } from '../../../src/runtime/util/lan-ip.js'
import {
  buildAccessUrls,
  printWebAccess,
  webPortFromEnv,
} from '../../../src/runtime/install/quick-setup.js'

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

describe('primaryLanIp / tailscaleIp', () => {
  it('primaryLanIp returns null or a non-loopback, non-Tailscale IPv4', () => {
    const ip = primaryLanIp()
    if (ip !== null) {
      expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
      expect(ip.startsWith('127.')).toBe(false)
      // The Tailscale range is surfaced separately, not as "LAN".
      const m = /^100\.(\d+)\./.exec(ip)
      if (m) expect(Number(m[1]) >= 64 && Number(m[1]) <= 127).toBe(false)
    }
  })

  it('tailscaleIp returns null or an address in 100.64.0.0/10', () => {
    const ip = tailscaleIp()
    if (ip !== null) {
      const m = /^100\.(\d+)\./.exec(ip)
      expect(m).not.toBeNull()
      if (m) expect(Number(m[1]) >= 64 && Number(m[1]) <= 127).toBe(true)
    }
  })
})

describe('buildAccessUrls ordering', () => {
  const base = { port: 2200, token: 'tok' }

  it('prefers Tailscale, then LAN, then localhost', () => {
    const opts = buildAccessUrls({ ...base, tailscaleIp: '100.101.1.2', lanIp: '192.168.1.5' })
    expect(opts.map((o) => o.href)).toEqual([
      'http://100.101.1.2:2200/?token=tok',
      'http://192.168.1.5:2200/?token=tok',
      'http://localhost:2200/?token=tok',
    ])
    expect(opts[0]?.label).toMatch(/Tailscale/)
  })

  it('falls back to LAN then localhost when no Tailscale', () => {
    const opts = buildAccessUrls({ ...base, tailscaleIp: null, lanIp: '10.0.0.4' })
    expect(opts.map((o) => o.href)).toEqual([
      'http://10.0.0.4:2200/?token=tok',
      'http://localhost:2200/?token=tok',
    ])
  })

  it('localhost-only when isolated (no Tailscale, no LAN)', () => {
    const opts = buildAccessUrls({ ...base, tailscaleIp: null, lanIp: null })
    expect(opts.map((o) => o.href)).toEqual(['http://localhost:2200/?token=tok'])
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
