/**
 * Tests for connector gateway launch resolution.
 *
 * Why this matters: connectors must run from BOTH a dev checkout and a
 * published npm install. The dev path runs the TypeScript gateway via
 * `tsx` from the workspace; the published path runs a self-contained
 * CommonJS bundle (`dist/connectors/<id>/gateway.cjs`) with plain `node`.
 * Before this, gateway start threw "not implemented yet" for anything but
 * a workspace source, so Discord (and every connector) was dev-only and
 * silently broken on a normal install. These tests pin:
 *
 *   - a published install (no workspace tsx) launches the bundled gateway
 *     with `node`, located by walking up toward the dist root
 *   - the bundle is found regardless of how deep the calling module sits
 *     (the supervisor bundle inlines this code at a varying depth)
 *   - with neither a usable workspace nor a bundle, we fail loud
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveBundledGateway,
  resolveGatewayLaunch,
} from '../../../src/runtime/connectors/gateway-manager.js'
import type { CatalogEntry } from '../../../src/runtime/extensions/catalog.js'

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A dist-like tree with a bundled gateway some levels above `from`. */
function distTreeWithBundle(extensionId: string): { distRoot: string; from: string } {
  const distRoot = mkdtempSync(join(tmpdir(), '2200-gw-'))
  tmpDirs.push(distRoot)
  const connDir = join(distRoot, 'connectors', extensionId)
  mkdirSync(connDir, { recursive: true })
  writeFileSync(join(connDir, 'gateway.cjs'), '// bundled gateway\n')
  // Simulate this module being inlined deep under dist/runtime/supervisor.
  const from = join(distRoot, 'runtime', 'supervisor')
  mkdirSync(from, { recursive: true })
  return { distRoot, from }
}

const npmEntry = (id: string): CatalogEntry =>
  ({
    id,
    label: id,
    blurb: '',
    category: 'connector',
    permissions: [],
    source: { type: 'npm', package: `@2200/${id}-connector` },
  }) as unknown as CatalogEntry

describe('resolveBundledGateway', () => {
  it('finds the bundle by walking up from a deeply-nested module dir', () => {
    const { distRoot, from } = distTreeWithBundle('discord')
    expect(resolveBundledGateway('discord', from)).toBe(
      join(distRoot, 'connectors', 'discord', 'gateway.cjs'),
    )
  })

  it('returns null when no bundle exists above the start dir', () => {
    const empty = mkdtempSync(join(tmpdir(), '2200-gw-empty-'))
    tmpDirs.push(empty)
    expect(resolveBundledGateway('discord', empty)).toBeNull()
  })
})

describe('resolveGatewayLaunch', () => {
  it('launches the bundled gateway with node on a published install', async () => {
    const { distRoot, from } = distTreeWithBundle('discord')
    const launch = await resolveGatewayLaunch('discord', npmEntry('discord'), from)
    expect(launch.command).toBe(process.execPath)
    expect(launch.args).toEqual([join(distRoot, 'connectors', 'discord', 'gateway.cjs')])
    expect(launch.cwd).toBe(join(distRoot, 'connectors', 'discord'))
  })

  it('throws when neither a workspace tsx nor a bundle is available', async () => {
    const empty = mkdtempSync(join(tmpdir(), '2200-gw-none-'))
    tmpDirs.push(empty)
    await expect(resolveGatewayLaunch('discord', npmEntry('discord'), empty)).rejects.toThrow(
      /no runnable gateway/,
    )
  })

  it('prefers the dev workspace+tsx when present (real repo checkout)', async () => {
    // In the repo, apps/discord-connector + its tsx are installed, so the
    // dev path wins. moduleDir is the real module location (3 levels under
    // the repo root, matching dist/runtime/connectors depth).
    const launch = await resolveGatewayLaunch('discord', {
      id: 'discord',
      label: 'Discord',
      blurb: '',
      category: 'connector',
      permissions: [],
      source: { type: 'workspace', path: 'apps/discord-connector' },
    } as unknown as CatalogEntry)
    expect(launch.command).toMatch(/tsx$/)
    expect(launch.args[0]).toMatch(/gateway\.ts$/)
  })
})
