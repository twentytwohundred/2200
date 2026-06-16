// Bundle each built-in connector's gateway into `dist/connectors/<id>/` so
// the supervisor can launch it from a published install with plain `node`
// — no `tsx`, no workspace checkout, no per-connector `node_modules`. The
// gateway imports the full `discord.js`, which lives only in the connector
// workspace; esbuild inlines it (and its deps) into one self-contained CJS
// file. Output is `.cjs` so Node treats it as CommonJS regardless of the
// package's `"type": "module"` (discord.js is CJS and does dynamic
// `require()`, which an ESM bundle cannot do).
//
// tsup cleans `dist/` on build, so this MUST run AFTER `pnpm build`. Run via
// `pnpm bundle:connectors`; wired into `prepack` alongside `bundle:web`.
import { build } from 'esbuild'
import { existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Each built-in connector: catalog id + its gateway entrypoint + the
// manifest/icon to materialize alongside the bundle (the install pipeline
// copies these into the operator's home so the Store UI reflects it).
const CONNECTORS = [
  {
    id: 'discord',
    entry: 'apps/discord-connector/src/gateway.ts',
    assetDir: 'apps/discord-connector',
  },
  {
    // Dependency-free (raw Bot API over global fetch), so it bundles to a
    // self-contained CJS cleanly ... no native externals like discord.js.
    id: 'telegram',
    entry: 'apps/telegram-connector/src/gateway.ts',
    assetDir: 'apps/telegram-connector',
  },
  {
    // Dependency-free too: Socket Mode over the Node global WebSocket + raw
    // Web API over fetch. No SDK, so it bundles cleanly and ships in npm.
    id: 'slack',
    entry: 'apps/slack-connector/src/gateway.ts',
    assetDir: 'apps/slack-connector',
  },
]

// discord.js pulls optional native accelerators (zlib-sync, bufferutil,
// utf-8-validate). They are not required — discord.js falls back to pure
// JS when they are absent — and they cannot be bundled (native .node), so
// mark them external. They simply will not be present at runtime.
const EXTERNAL_OPTIONAL = ['zlib-sync', 'bufferutil', 'utf-8-validate']

let failed = false
for (const c of CONNECTORS) {
  if (!existsSync(c.entry)) {
    console.error(`bundle-connectors: ${c.entry} not found (run from the repo root).`)
    failed = true
    continue
  }
  const outDir = join('dist', 'connectors', c.id)
  const outfile = join(outDir, 'gateway.cjs')
  mkdirSync(outDir, { recursive: true })
  await build({
    entryPoints: [c.entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile,
    external: EXTERNAL_OPTIONAL,
    logLevel: 'warning',
  })
  // Carry the manifest (and icon, if any) so the install pipeline can
  // materialize the extension into the operator's home from `dist`.
  for (const asset of ['manifest.json', 'icon.svg', 'icon.png']) {
    const src = join(c.assetDir, asset)
    if (existsSync(src)) copyFileSync(src, join(outDir, asset))
  }
  console.log(`bundle-connectors: ${c.entry} -> ${outfile}`)
}
if (failed) process.exit(1)
