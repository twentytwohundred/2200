/**
 * Tests for the pub-related supervisor RPCs (Epic 3 PR A).
 *
 * Covers cli.pub.create, cli.pub.start, cli.pub.stop, cli.pub.list,
 * cli.pub.status. Each test spins up a real supervisor with real
 * UDS, exercises the RPC, and asserts the on-disk state and
 * started-process state reflect the change.
 *
 * Pub-server itself is faked with a tiny Node script (mirrors the
 * pattern from pub-lifecycle.test.ts). The real `@openpub-ai/pub-server`
 * binary is exercised in a separate integration test that lands in
 * PR D, once Poe ships the pluggable-issuer release.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Supervisor } from '../../../src/runtime/supervisor/supervisor.js'
import { JsonRpcClient } from '../../../src/runtime/control-plane/client.js'
import { connectUds } from '../../../src/runtime/control-plane/uds-client.js'
import { pubPaths } from '../../../src/runtime/storage/layout.js'

let home: string
let supervisor: Supervisor | undefined
let client: JsonRpcClient | undefined
let fakeBin: string

async function writeFakeBinary(behavior: 'sleep' | 'exit-clean' | 'exit-bad'): Promise<string> {
  const script = `#!/usr/bin/env node
process.stdout.write('PUB_MD_PATH=' + (process.env.PUB_MD_PATH || '') + '\\n')
process.stdout.write('PORT=' + (process.env.PORT || '') + '\\n')
${
  behavior === 'sleep'
    ? `process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1_000_000)`
    : behavior === 'exit-clean'
      ? `process.exit(0)`
      : `process.exit(7)`
}
`
  const path = join(home, `fake-openpub-${behavior}.cjs`)
  await writeFile(path, script)
  await chmod(path, 0o755)
  return path
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-pub-rpc-'))
  fakeBin = ''
})

afterEach(async () => {
  if (client) {
    try {
      await client.close()
    } catch {
      // ignore
    }
    client = undefined
  }
  if (supervisor) {
    await supervisor.shutdown()
    supervisor = undefined
  }
  // createUserIdentity (setup) regenerates the shared-brain index
  // asynchronously; a write landing mid-recursive-delete yields
  // ENOTEMPTY (sibling file hit it on CI 2026-06-12). Retry absorbs it.
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

async function setup(): Promise<void> {
  supervisor = await Supervisor.create({ home })
  await supervisor.start()
  // Pub creation derives its owner from the user identity (fail-fast
  // when absent), so the harness mints one the way first-run does.
  await supervisor.createUserIdentity({ display_name: 'Alice' })
  const conn = await connectUds(Supervisor.socketPath(home))
  client = new JsonRpcClient(conn)
}

describe('cli.pub.create', () => {
  it('writes PUB.md, allocates a port, registers the record', async () => {
    await setup()
    const result = await client!.call('cli.pub.create', { name: 'ops' })
    expect(result.ok).toBe(true)
    expect(result.name).toBe('ops')
    expect(result.port).toBeGreaterThan(0)
    expect(result.pub_md_path).toBe(pubPaths(home, 'ops').pubMd)

    // PUB.md exists with the expected name.
    const md = await readFile(result.pub_md_path, 'utf8')
    expect(md).toContain('name: ops')

    // State snapshot includes the pub.
    const snap = await client!.call('state.snapshot', {})
    expect(snap.pubs['ops']).toBeDefined()
    expect(snap.pubs['ops']?.state).toBe('stopped')
    expect(snap.pubs['ops']?.pid).toBeNull()
  })

  it('respects --port override', async () => {
    await setup()
    const result = await client!.call('cli.pub.create', {
      name: 'ops',
      port: 65431,
    })
    expect(result.port).toBe(65431)
  })

  it('refuses to overwrite an existing pub', async () => {
    await setup()
    await client!.call('cli.pub.create', { name: 'ops' })
    await expect(client!.call('cli.pub.create', { name: 'ops' })).rejects.toThrow(/already exists/)
  })

  it('rejects invalid pub names at the supervisor layer', async () => {
    await setup()
    await expect(client!.call('cli.pub.create', { name: 'Bad-Name' })).rejects.toThrow(
      /invalid pub name/,
    )
  })

  it('writes capacity and description into PUB.md when provided', async () => {
    await setup()
    const result = await client!.call('cli.pub.create', {
      name: 'ops',
      description: 'Doug ops pub',
      capacity: 12,
    })
    const md = await readFile(result.pub_md_path, 'utf8')
    expect(md).toContain('description: "Doug ops pub"')
    expect(md).toContain('capacity: 12')
  })
})

describe('cli.pub.start / cli.pub.stop', () => {
  it('starts a pub-server child via the fake binary', async () => {
    fakeBin = await writeFakeBinary('sleep')
    await setup()
    await client!.call('cli.pub.create', { name: 'ops' })
    // The supervisor's startPub method takes options; the RPC layer does
    // not yet expose the executable override (production uses the
    // bundled openpub-server). Inject via the supervisor directly.
    const out = await supervisor!.startPub('ops', { executablePath: fakeBin })
    expect(out.pid).toBeGreaterThan(0)

    const snap = await client!.call('state.snapshot', {})
    expect(snap.pubs['ops']?.state).toBe('running')
    expect(snap.pubs['ops']?.pid).toBe(out.pid)

    await client!.call('cli.pub.stop', { name: 'ops' })
    const snap2 = await client!.call('state.snapshot', {})
    expect(snap2.pubs['ops']?.state).toBe('stopped')
    expect(snap2.pubs['ops']?.pid).toBeNull()
  })

  it('idempotent start: starting an already-running pub returns the same pid', async () => {
    fakeBin = await writeFakeBinary('sleep')
    await setup()
    await client!.call('cli.pub.create', { name: 'ops' })
    const first = await supervisor!.startPub('ops', { executablePath: fakeBin })
    const second = await supervisor!.startPub('ops', { executablePath: fakeBin })
    expect(second.pid).toBe(first.pid)
    await client!.call('cli.pub.stop', { name: 'ops' })
  })

  it('idempotent stop: stopping an already-stopped pub returns ok', async () => {
    await setup()
    await client!.call('cli.pub.create', { name: 'ops' })
    const result = await client!.call('cli.pub.stop', { name: 'ops' })
    expect(result.ok).toBe(true)
  })

  it('reports errored state when the pub-server exits abnormally', async () => {
    fakeBin = await writeFakeBinary('exit-bad')
    await setup()
    await client!.call('cli.pub.create', { name: 'ops' })
    await supervisor!.startPub('ops', { executablePath: fakeBin })
    // Exit-bad scripts exit immediately with code 7. Poll for the
    // supervisor's exit handler to update state, with a generous cap
    // because Node's launch+exit takes longer under Vitest parallelism.
    let state: string | undefined
    for (let i = 0; i < 30; i++) {
      const snap = await client!.call('state.snapshot', {})
      state = snap.pubs['ops']?.state
      if (state === 'errored') break
      await new Promise((r) => setTimeout(r, 100))
    }
    const finalSnap = await client!.call('state.snapshot', {})
    expect(finalSnap.pubs['ops']?.state).toBe('errored')
    expect(finalSnap.pubs['ops']?.errored_reason).toContain('code=7')
  })

  it('start without a record throws a clear error', async () => {
    await setup()
    await expect(
      supervisor!.startPub('no-such-pub', { executablePath: 'irrelevant' }),
    ).rejects.toThrow(/no pub record/)
  })
})

describe('cli.pub.list / cli.pub.status', () => {
  it('list returns empty array when no pubs created', async () => {
    await setup()
    const result = await client!.call('cli.pub.list', {})
    expect(result.pubs).toEqual([])
  })

  it('list returns multiple pubs with their state', async () => {
    await setup()
    await client!.call('cli.pub.create', { name: 'ops' })
    await client!.call('cli.pub.create', { name: 'family' })
    const result = await client!.call('cli.pub.list', {})
    expect(result.pubs.length).toBe(2)
    const names = result.pubs.map((p) => p.name).sort()
    expect(names).toEqual(['family', 'ops'])
    for (const p of result.pubs) {
      expect(p.state).toBe('stopped')
      expect(p.pid).toBeNull()
      expect(p.port).toBeGreaterThan(0)
    }
  })

  it('status returns the full record for one pub', async () => {
    await setup()
    const created = await client!.call('cli.pub.create', { name: 'ops' })
    const result = await client!.call('cli.pub.status', { name: 'ops' })
    expect(result.name).toBe('ops')
    expect(result.port).toBe(created.port)
    expect(result.pub_md_path).toBe(created.pub_md_path)
    expect(result.state).toBe('stopped')
  })

  it('status throws on unknown pub', async () => {
    await setup()
    await expect(client!.call('cli.pub.status', { name: 'ghost' })).rejects.toThrow(/no pub record/)
  })
})

describe('persistence across supervisor restart', () => {
  it('reloads pubs from supervisor.json on restart', async () => {
    await setup()
    await client!.call('cli.pub.create', { name: 'ops', capacity: 5 })

    // Tear down the supervisor (and the connected client) without rm'ing home.
    await client!.close()
    client = undefined
    await supervisor!.shutdown()
    supervisor = undefined

    // Bring up a fresh supervisor against the same home; the on-disk
    // supervisor.json should populate `pubs`.
    supervisor = await Supervisor.create({ home })
    await supervisor.start()
    const conn = await connectUds(Supervisor.socketPath(home))
    client = new JsonRpcClient(conn)

    const list = await client.call('cli.pub.list', {})
    expect(list.pubs.length).toBe(1)
    expect(list.pubs[0]?.name).toBe('ops')
    expect(list.pubs[0]?.state).toBe('stopped')

    const status = await client.call('cli.pub.status', { name: 'ops' })
    expect(status.port).toBeGreaterThan(0)
  })

  it('backward-compat: loads supervisor.json that predates the pubs field', async () => {
    // Hand-write a v1 supervisor.json that has no pubs field.
    const { mkdir, writeFile: wf } = await import('node:fs/promises')
    await mkdir(join(home, 'state'), { recursive: true })
    await wf(
      join(home, 'state', 'supervisor.json'),
      JSON.stringify({
        schema_version: 1,
        home,
        state_dir: join(home, 'state'),
        agents: {},
      }),
      'utf8',
    )
    supervisor = await Supervisor.create({ home })
    await supervisor.start()
    const conn = await connectUds(Supervisor.socketPath(home))
    client = new JsonRpcClient(conn)

    const list = await client.call('cli.pub.list', {})
    expect(list.pubs).toEqual([])
  })
})
