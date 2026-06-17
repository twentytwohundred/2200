// Ship the 2200-patched OpenPub pub-server `server.js` into `dist/` so the
// runtime can overlay it onto an UNPATCHED npm-installed copy at spawn time.
//
// Why: 2200 patches `@openpub-ai/pub-server` (empty-key Bartender/fragment
// guards + the WebSocket keepalive `pong` handler that stops agents being
// terminated ~60s after they join). That patch is applied in the dev repo via
// pnpm `patchedDependencies` ... but `npm install -g @twentytwohundred/2200-cli`
// uses npm, which ignores pnpm patches, so every real install runs the
// unpatched, agent-killing pub-server. We carry the patched `server.js` and
// re-apply it at launch (see ensurePubServerPatched in pub-lifecycle.ts).
//
// MUST run AFTER `tsup` (which cleans `dist/`). Wired into `prepack`.
import { existsSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MARKER = '2200 patch'
const SRC = join('node_modules', '@openpub-ai', 'pub-server', 'dist', 'server.js')
const OUT_DIR = join('dist', 'vendor', 'openpub-pub-server')
const OUT = join(OUT_DIR, 'server.js')

if (!existsSync(SRC)) {
  console.error(
    `bundle-pub-server-patch: ${SRC} not found ... is @openpub-ai/pub-server installed?`,
  )
  process.exit(1)
}
const content = readFileSync(SRC, 'utf8')
if (!content.includes(MARKER)) {
  console.error(
    `bundle-pub-server-patch: ${SRC} is NOT patched (no "${MARKER}" marker). ` +
      `The pnpm patchedDependencies did not apply ... refusing to ship an unpatched pub-server. ` +
      `Run \`pnpm install\` to apply patches, then rebuild.`,
  )
  process.exit(1)
}
mkdirSync(OUT_DIR, { recursive: true })
copyFileSync(SRC, OUT)
console.log(`bundle-pub-server-patch: shipped patched server.js -> ${OUT}`)
