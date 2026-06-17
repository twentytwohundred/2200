/**
 * The non-loopback web-host warning must be a ONE-TIME heads-up, not a
 * per-boot nag. `quick-setup` deliberately binds 0.0.0.0 for LAN/Tailscale
 * access, so without dedup this warning re-fires on every daemon boot and
 * spams the operator's inbox about the intended default. These tests pin
 * that contract: fire once per bind, re-fire only when the bind genuinely
 * changes, and re-arm after a revert to loopback.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearWebHostWarnMarker,
  warnWebHostNonLoopback,
} from '../../../src/runtime/supervisor/supervisor.js'
import { notificationsDir } from '../../../src/runtime/notifications/writer.js'
import type { Logger } from '../../../src/runtime/util/logger.js'

const noopLogger: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  child: () => noopLogger,
}

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-web-host-warn-'))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

/** Count the inbox notification files written so far. */
async function notifCount(): Promise<number> {
  try {
    return (await readdir(notificationsDir(home))).filter((f) => f.endsWith('.md')).length
  } catch {
    return 0
  }
}

describe('warnWebHostNonLoopback', () => {
  it('fires once for a given bind, then stays quiet on subsequent boots', async () => {
    await warnWebHostNonLoopback({ home, host: '0.0.0.0', port: 2200, logger: noopLogger })
    expect(await notifCount()).toBe(1)
    // Same bind on the next boot (and the one after) must not re-notify.
    await warnWebHostNonLoopback({ home, host: '0.0.0.0', port: 2200, logger: noopLogger })
    await warnWebHostNonLoopback({ home, host: '0.0.0.0', port: 2200, logger: noopLogger })
    expect(await notifCount()).toBe(1)
  })

  it('warns again when the operator binds a different host:port (new surface)', async () => {
    await warnWebHostNonLoopback({ home, host: '0.0.0.0', port: 2200, logger: noopLogger })
    expect(await notifCount()).toBe(1)
    await warnWebHostNonLoopback({ home, host: '192.168.1.10', port: 2200, logger: noopLogger })
    expect(await notifCount()).toBe(2)
  })

  it('re-arms after a revert to loopback so a later re-widen warns again', async () => {
    await warnWebHostNonLoopback({ home, host: '0.0.0.0', port: 2200, logger: noopLogger })
    expect(await notifCount()).toBe(1)
    // Operator reverted to loopback (marker cleared at boot), then re-widened.
    await clearWebHostWarnMarker(home)
    await warnWebHostNonLoopback({ home, host: '0.0.0.0', port: 2200, logger: noopLogger })
    expect(await notifCount()).toBe(2)
  })
})
