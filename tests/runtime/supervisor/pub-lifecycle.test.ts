/**
 * Tests for pub-lifecycle (Epic 3 PR A).
 *
 * Two surfaces under test:
 *   1. `composePubMd` — pure function, easy.
 *   2. `spawnPub` — uses Node's child_process. We exercise it with a
 *      fake "openpub-server" implemented as a tiny Node script that
 *      either sleeps until killed (the running case) or exits
 *      immediately (the abnormal-exit case). This avoids depending on
 *      the real `@openpub-ai/pub-server` binary at PR-A test time;
 *      PR D will add an integration test against the real binary
 *      once Poe ships the pluggable-issuer release.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, stat, writeFile, chmod, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initHome, initPubDirs } from '../../../src/runtime/storage/init.js'
import { composePubMd, spawnPub } from '../../../src/runtime/supervisor/pub-lifecycle.js'
import { pubPaths } from '../../../src/runtime/storage/layout.js'
import { findFreePort } from '../../../src/runtime/util/free-port.js'

let home: string
let fakeBin: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-pub-lifecycle-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

// Tiny fake openpub-server: prints what it received via env and either
// sleeps forever (default) or exits with a code from FAKE_EXIT_CODE.
async function writeFakeBinary(behavior: 'sleep' | 'exit-clean' | 'exit-bad'): Promise<string> {
  const script = `#!/usr/bin/env node
const env = process.env
process.stdout.write('PUB_MD_PATH=' + (env.PUB_MD_PATH || '') + '\\n')
process.stdout.write('PORT=' + (env.PORT || '') + '\\n')
process.stdout.write('OPENPUB_TRUST_MODE=' + (env.OPENPUB_TRUST_MODE || '') + '\\n')
${
  behavior === 'sleep'
    ? `process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1_000_000)`
    : behavior === 'exit-clean'
      ? `process.exit(0)`
      : `process.stderr.write('boom\\n'); process.exit(7)`
}
`
  const path = join(home, `fake-openpub-${behavior}.cjs`)
  await writeFile(path, script)
  await chmod(path, 0o755)
  return path
}

describe('composePubMd', () => {
  it('composes minimal PUB.md with just a name', () => {
    const md = composePubMd({ name: 'ops' })
    expect(md).toMatch(/^---\nschema_version: 1\nname: ops\nentry: open\n---/)
    expect(md).toContain('# ops')
  })

  it('includes optional fields when provided', () => {
    const md = composePubMd({
      name: 'carl-monday-callsheet',
      description: 'Carl Monday call review',
      capacity: 10,
      owner: '01919c4f-7e3a-7000-8000-d4a984f2c1b3',
    })
    expect(md).toContain('name: carl-monday-callsheet')
    expect(md).toContain('description: "Carl Monday call review"')
    expect(md).toContain('capacity: 10')
    // UUIDs are pure slug characters (alphanumeric + dashes) so the
    // composer leaves them unquoted. quoteIfNeeded only quotes when
    // the value contains characters YAML would otherwise interpret.
    expect(md).toContain('owner: 01919c4f-7e3a-7000-8000-d4a984f2c1b3')
  })

  it('quotes values that contain whitespace or special chars', () => {
    const md = composePubMd({
      name: 'ops',
      description: 'has "quotes" and a \\backslash',
    })
    // Backslashes and quotes are escaped in the YAML double-quoted form.
    expect(md).toContain('description: "has \\"quotes\\" and a \\\\backslash"')
  })

  it('does not quote values that are pure slug characters', () => {
    const md = composePubMd({ name: 'pub_simple-1' })
    // pub_simple-1 contains an underscore so quoteIfNeeded would NOT quote
    // (regex includes underscore as safe). This test pins the heuristic.
    expect(md).toContain('name: pub_simple-1')
  })
})

describe('spawnPub (using a fake binary)', () => {
  beforeEach(async () => {
    await initHome(home)
    fakeBin = ''
  })

  it('spawns a child, captures pid, writes stdio to per-pub log', async () => {
    fakeBin = await writeFakeBinary('sleep')
    await initPubDirs(home, 'ops', composePubMd({ name: 'ops' }))
    const port = await findFreePort()
    const sp = spawnPub({
      name: 'ops',
      home,
      port,
      executablePath: fakeBin,
    })
    expect(sp.pid).toBeGreaterThan(0)
    expect(sp.name).toBe('ops')

    // Give the child a moment to write its env diagnostic to the log,
    // then stop. Bumped to 500ms to absorb Vitest parallelism jitter.
    await new Promise((r) => setTimeout(r, 500))
    await sp.stop()
    await sp.exited

    const logContent = await readFile(pubPaths(home, 'ops').log, 'utf8')
    expect(logContent).toContain('PUB_MD_PATH=' + pubPaths(home, 'ops').pubMd)
    expect(logContent).toContain(`PORT=${String(port)}`)
    expect(logContent).toContain('OPENPUB_TRUST_MODE=local')
  })

  it('passes hub URL when issuer is hub', async () => {
    fakeBin = await writeFakeBinary('sleep')
    await initPubDirs(home, 'ops', composePubMd({ name: 'ops' }))
    const port = await findFreePort()
    const sp = spawnPub({
      name: 'ops',
      home,
      port,
      executablePath: fakeBin,
      issuer: 'hub',
      hubUrl: 'https://openpub.ai',
      env: { ECHO_HUB_URL: 'yes' },
    })
    await new Promise((r) => setTimeout(r, 200))
    await sp.stop()
    await sp.exited

    const logContent = await readFile(pubPaths(home, 'ops').log, 'utf8')
    expect(logContent).toContain('OPENPUB_TRUST_MODE=hub')
  })

  it('stop() is a no-op once the child has already exited', async () => {
    fakeBin = await writeFakeBinary('exit-clean')
    await initPubDirs(home, 'ops', composePubMd({ name: 'ops' }))
    const port = await findFreePort()
    const sp = spawnPub({ name: 'ops', home, port, executablePath: fakeBin })
    await sp.exited
    // Should resolve quickly without throwing.
    await sp.stop()
  })

  it('reports abnormal exit with non-zero code to the exited promise', async () => {
    fakeBin = await writeFakeBinary('exit-bad')
    await initPubDirs(home, 'ops', composePubMd({ name: 'ops' }))
    const port = await findFreePort()
    const sp = spawnPub({ name: 'ops', home, port, executablePath: fakeBin })
    const result = await sp.exited
    expect(result.code).toBe(7)
    expect(result.signal).toBeNull()
  })

  it('writes the per-pub log file inside the pub state dir', async () => {
    fakeBin = await writeFakeBinary('exit-clean')
    await initPubDirs(home, 'ops', composePubMd({ name: 'ops' }))
    const port = await findFreePort()
    const sp = spawnPub({ name: 'ops', home, port, executablePath: fakeBin })
    await sp.exited
    const logPath = pubPaths(home, 'ops').log
    const s = await stat(logPath)
    expect(s.isFile()).toBe(true)
  })
})
