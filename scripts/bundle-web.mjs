// Copy the built web app into `dist/web` so it ships inside the npm
// package (only `dist/` is in package.json#files) and the daemon's HTTP
// server can serve it. tsup cleans `dist/` on build, so this MUST run
// AFTER `pnpm build`. Run via `pnpm bundle:web`; wired into `prepack`.
import { rmSync, cpSync, existsSync, mkdirSync } from 'node:fs'

const SRC = 'apps/web/dist'
const DEST = 'dist/web'

if (!existsSync(`${SRC}/index.html`)) {
  console.error(
    `bundle-web: ${SRC}/index.html not found. Build the web app first ` +
      `(pnpm --filter @twentytwohundred/web build).`,
  )
  process.exit(1)
}

mkdirSync('dist', { recursive: true })
rmSync(DEST, { recursive: true, force: true })
cpSync(SRC, DEST, { recursive: true })
console.log(`bundle-web: copied ${SRC} -> ${DEST}`)
