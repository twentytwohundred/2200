/**
 * Tests for the cli.user.init RPC (Epic 3 PR B).
 *
 * Brings up a real supervisor over UDS, registers the cli.user.init
 * code path against a fake HTTP pub-server, and asserts the on-disk
 * artifacts (user.md, user.pub.secret) match expectations.
 *
 * Pub-server registration is verified via a fake http.Server that
 * implements the v0.3.2 LOCAL_TRUST contract (the same fake used by
 * identity-client.test.ts but inlined here so the supervisor test
 * has no test-only dependencies).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { Supervisor } from '../../../src/runtime/supervisor/supervisor.js'
import { JsonRpcClient } from '../../../src/runtime/control-plane/client.js'
import { connectUds } from '../../../src/runtime/control-plane/transport-uds.js'
import { homePaths } from '../../../src/runtime/storage/layout.js'
import { loadUserIdentity } from '../../../src/runtime/user/loader.js'
import { readCredentialFile } from '../../../src/runtime/pub/keypair.js'

let home: string
let supervisor: Supervisor | undefined
let client: JsonRpcClient | undefined
let pubServer: Server | undefined
let pubBaseUrl = ''

async function startFakePub(): Promise<{ port: number; url: string }> {
  pubServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void readBody(req).then((body) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      if (req.method === 'GET' && url.pathname === '/agents/me') {
        const id = req.headers['x-openpub-agent-id']
        if (typeof id !== 'string') {
          res.writeHead(404).end()
          return
        }
        // Always 404 the first time (we test fresh registration).
        res.writeHead(404).end()
        return
      }
      if (req.method === 'POST' && url.pathname === '/admin/register-agent') {
        const parsed = JSON.parse(body) as { display_name: string }
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            agent_id: randomUUID(),
            display_name: parsed.display_name,
          }),
        )
        return
      }
      res.writeHead(404).end()
    })
  })
  await new Promise<void>((resolve) => {
    pubServer!.listen(0, '127.0.0.1', () => {
      resolve()
    })
  })
  const addr = pubServer.address()
  if (addr === null || typeof addr === 'string') throw new Error('no address')
  pubBaseUrl = `http://127.0.0.1:${String(addr.port)}`
  return { port: addr.port, url: pubBaseUrl }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  return new Promise((resolve, reject) => {
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-user-rpc-'))
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
  if (pubServer) {
    await new Promise<void>((resolve) =>
      pubServer!.close(() => {
        resolve()
      }),
    )
    pubServer = undefined
  }
  await rm(home, { recursive: true, force: true })
})

async function setup(): Promise<void> {
  supervisor = await Supervisor.create({ home })
  await supervisor.start()
  const conn = await connectUds(Supervisor.socketPath(home))
  client = new JsonRpcClient(conn)
}

describe('cli.user.init (no pub yet)', () => {
  it('writes user.md and credential file with deferred registration', async () => {
    await setup()
    const result = await client!.call('cli.user.init', { display_name: 'Doug' })
    expect(result.ok).toBe(true)
    expect(result.agent_id).toBeNull()
    expect(result.registered_against).toBeNull()
    expect(result.user_md_path).toBe(homePaths(home).configUserMd)
    expect(result.credentials_path).toBe(homePaths(home).configUserPubSecret)

    const cred = await readCredentialFile(result.credentials_path)
    expect(cred.display_name).toBe('Doug')
    expect(cred.agent_id).toBeNull()
    expect(cred.issuer_url).toBe('local://unregistered')

    const ident = await loadUserIdentity(result.user_md_path)
    expect(ident.frontmatter.display_name).toBe('Doug')
    expect(ident.frontmatter.pub.handle).toBe('@doug')
    expect(ident.frontmatter.pub.identity).toBe('')
  })

  it('credential file is mode 0600 on POSIX', async () => {
    await setup()
    const result = await client!.call('cli.user.init', { display_name: 'Doug' })
    if (process.platform !== 'win32') {
      const s = await stat(result.credentials_path)
      expect(s.mode & 0o777).toBe(0o600)
    }
  })

  it('respects --handle override', async () => {
    await setup()
    const result = await client!.call('cli.user.init', {
      display_name: 'Doug Hardman',
      handle: '@mrdoug',
    })
    const ident = await loadUserIdentity(result.user_md_path)
    expect(ident.frontmatter.pub.handle).toBe('@mrdoug')
  })

  it('default handle: lowercased, whitespace stripped, leading @', async () => {
    await setup()
    const result = await client!.call('cli.user.init', { display_name: 'Doug Hardman' })
    const ident = await loadUserIdentity(result.user_md_path)
    expect(ident.frontmatter.pub.handle).toBe('@doughardman')
  })
})

describe('cli.user.init (idempotent re-run)', () => {
  it('preserves keypair and created date on same display_name re-run', async () => {
    await setup()
    const first = await client!.call('cli.user.init', { display_name: 'Doug' })
    const cred1 = await readCredentialFile(first.credentials_path)
    const md1 = await readFile(first.user_md_path, 'utf8')

    const second = await client!.call('cli.user.init', { display_name: 'Doug' })
    expect(second.user_md_path).toBe(first.user_md_path)
    const cred2 = await readCredentialFile(second.credentials_path)
    expect(cred2.private_key).toBe(cred1.private_key)
    expect(cred2.public_key).toBe(cred1.public_key)

    // Body and created should be unchanged.
    const md2 = await readFile(first.user_md_path, 'utf8')
    expect(md2).toBe(md1)
  })

  it('refuses on display_name mismatch with a clear error', async () => {
    await setup()
    await client!.call('cli.user.init', { display_name: 'Doug' })
    await expect(client!.call('cli.user.init', { display_name: 'Dana' })).rejects.toThrow(
      /already exists with display_name "Doug"/,
    )
  })
})

describe('cli.user.init (with a pub running)', () => {
  it('registers the user against a pub when that pub is in running state', async () => {
    await setup()
    const fake = await startFakePub()
    await client!.call('cli.pub.create', { name: 'ops', port: fake.port })
    // Inject pub-running state by hand: use a long-sleeping fake binary
    // whose exit handler will not fire during the test window.
    const sleeperBin = await writeSleepBinary()
    await supervisor!.startPub('ops', { executablePath: sleeperBin })

    const result = await client!.call('cli.user.init', { display_name: 'Doug' })
    expect(result.agent_id).not.toBeNull()
    expect(result.registered_against).toBe('ops')

    const cred = await readCredentialFile(result.credentials_path)
    expect(cred.agent_id).toBe(result.agent_id)
    expect(cred.issuer_url).toBe(`local://127.0.0.1:${String(fake.port)}`)

    const ident = await loadUserIdentity(result.user_md_path)
    expect(ident.frontmatter.pub.identity).toBe(result.agent_id)
  })
})

async function writeSleepBinary(): Promise<string> {
  const { writeFile, chmod } = await import('node:fs/promises')
  const path = join(home, 'sleep.cjs')
  const script = `#!/usr/bin/env node
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1_000_000)
`
  await writeFile(path, script)
  await chmod(path, 0o755)
  return path
}
