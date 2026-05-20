/**
 * 2200 — runtime entry point.
 *
 * The runtime kernel for the 2200 platform. This module is the public surface
 * for embedding 2200 as a library. The CLI lives in src/cli/.
 *
 * See the wiki at https://github.com/twentytwohundred/wiki/blob/main/epics/02-agent-runtime-minimum.md
 * for the locked Epic 2 spec.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PACKAGE_NAME = '@twentytwohundred/2200'

// Read the version directly from the published `package.json` so
// `npm version <bump>` is the single source of truth and `2200 --version`
// cannot drift from the tarball on the registry.
//
// The lookup walks upward from this module looking for the FIRST
// `package.json` whose `name` matches our package. The walk is needed
// because tsup inlines this code into every dist entry it produces
// (e.g., `dist/cli/main.js` AND `dist/index.js`), so the relative
// distance to the package root is not fixed. The name check prevents
// us from picking up a parent workspace's `package.json` when running
// from a source checkout.
function readVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(dir, 'package.json')
    try {
      const raw = readFileSync(candidate, 'utf8')
      const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown }
      if (parsed.name === PACKAGE_NAME && typeof parsed.version === 'string') {
        return parsed.version
      }
    } catch {
      // keep walking
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return '0.0.0-unknown'
}

export const VERSION: string = readVersion()
