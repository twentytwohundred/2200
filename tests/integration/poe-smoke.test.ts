/**
 * Epic 3 PR F end-to-end smoke test against the REAL
 * `@openpub-ai/pub-server@0.3.3` binary in LOCAL_TRUST mode.
 *
 * Validates that the full PR A → B → B-followup → C → D stack works
 * against the wire shape pub-server actually ships, not just the fake
 * server we've used in unit tests. This is the "Poe smoke test"
 * Epic 3 closes on.
 *
 * Test arc:
 *   1. Spin up a real Supervisor on a tmp 2200_HOME.
 *   2. createPub('ops') → generates per-pub admin secret + signing
 *      keypair, persists, registers a PubRecord.
 *   3. startPub('ops') → starts the REAL openpub-server child with
 *      OPENPUB_TRUST_MODE=local, OPENPUB_ADMIN_SECRET, PUB_SIGNING_*,
 *      PUB_MD_PATH, PORT, OPENPUB_STATE_DIR.
 *   4. Wait for /health or /info to respond.
 *   5. createUserIdentity('Alice') → mints keypair, registers via the
 *      real /admin/register-agent (X-OpenPub-Admin-Secret header).
 *   6. Write a poe Identity with a `pub:` block → createAgent('poe')
 *      mints + registers poe similarly, patches identity.md.
 *   7. Open a PubClient for the user (the user is just another agent
 *      from pub-server's perspective).
 *   8. Open a PubClient for poe with a PubWakeSource attached and a
 *      TaskStore wired to a tmp dir.
 *   9. User sends `@poe ping` mentioning poe.
 *  10. Assert poe's task store receives a synthetic pub.handle task
 *      (rule: direct_mention).
 *  11. Use poe's PubClient to send a reply.
 *  12. Assert the user's PubClient receives the reply event.
 *
 * The test takes a few seconds (real process start + network handshake).
 * Skipped automatically if the openpub-server binary cannot be found
 * (e.g., on CI that has not installed the optional dep).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Supervisor } from '../../src/runtime/supervisor/supervisor.js'
import { PubClient } from '../../src/runtime/pub/client.js'
import { readCredentialFile } from '../../src/runtime/pub/keypair.js'
import { PubWakeSource } from '../../src/runtime/pub/wake-source.js'
import { TaskStore } from '../../src/runtime/agent/task/store.js'
import { agentPaths, homePaths } from '../../src/runtime/storage/layout.js'
import { evictAllPubClients } from '../../src/runtime/pub/registry.js'
import { loadUserIdentity } from '../../src/runtime/user/loader.js'
import { loadIdentity } from '../../src/runtime/identity/loader.js'

let home: string
let supervisor: Supervisor | undefined
const userClients: PubClient[] = []
const wakeSources: PubWakeSource[] = []

const OPENPUB_BIN = resolve(process.cwd(), 'node_modules', '.bin', 'openpub-server')
const HAS_BINARY = existsSync(OPENPUB_BIN)

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-poe-smoke-'))
})

afterEach(async () => {
  for (const ws of wakeSources) {
    try {
      ws.stop()
    } catch {
      // best-effort
    }
  }
  wakeSources.length = 0
  for (const c of userClients) {
    try {
      await c.close()
    } catch {
      // best-effort
    }
  }
  userClients.length = 0
  await evictAllPubClients()
  if (supervisor) {
    await supervisor.shutdown()
    supervisor = undefined
  }
  await rm(home, { recursive: true, force: true })
})

/** Poll an HTTP endpoint until it responds 200, or timeout. */
async function waitFor200(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
      lastErr = new Error(`status ${String(res.status)}`)
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(
    `endpoint ${url} never returned 200 within ${String(timeoutMs)}ms (last: ${lastErr instanceof Error ? lastErr.message : String(lastErr)})`,
  )
}

const itIfBinary = HAS_BINARY ? it : it.skip

describe('Epic 3 PR F: Poe smoke test against real openpub-server@0.3.3', () => {
  itIfBinary(
    'end-to-end: user → @poe → wake → reply → user receives',
    async () => {
      // 1. Supervisor up.
      supervisor = await Supervisor.create({ home })
      await supervisor.start()

      // 2. Create + 3. start the real pub.
      await supervisor.createPub('ops', { owner: 'operator' })
      const startResult = await supervisor.startPub('ops')

      // 4. Wait for the real binary to come online.
      const baseUrl = `http://127.0.0.1:${String(startResult.port)}`
      await waitFor200(`${baseUrl}/info`, 10_000)

      // 5. The user.
      const userInit = await supervisor.createUserIdentity({ display_name: 'Alice' })
      expect(userInit.agent_id).not.toBeNull()
      expect(userInit.registered_against).toBe('ops')
      const userId = await loadUserIdentity(homePaths(home).configUserMd)
      const userCred = await readCredentialFile(homePaths(home).configUserPubSecret)
      expect(userCred.agent_id).toBe(userId.frontmatter.pub.identity)

      // 6. Poe.
      const poeIdentitySource = join(home, 'poe.identity.md')
      await writeFile(
        poeIdentitySource,
        [
          '---',
          'schema_version: 1',
          'agent_name: poe',
          'agent_role: "OpenPub specialist"',
          'model:',
          '  tier: frontier',
          '  provider: anthropic',
          '  model_id: claude-opus-4-7',
          'tools: []',
          'project_dir: /tmp/poe/project',
          'brain_dir: /tmp/poe/brain',
          'created: 2026-04-27',
          'pub:',
          '  identity: ""',
          '  display_name: poe',
          '  handle: "@poe"',
          '  credentials:',
          '    source: file',
          '    id: /placeholder',
          '  key_version: 1',
          '  issuer_url: ""',
          '  domains: []',
          '  member_of: []',
          '---',
          '',
          '# Poe',
          'OpenPub specialist on the 2200 build team.',
          '',
        ].join('\n'),
      )
      await supervisor.createAgent('poe', poeIdentitySource)
      const poeIdentity = await loadIdentity(agentPaths(home, 'poe').identity)
      expect(poeIdentity.frontmatter.pub?.identity).toMatch(/^[0-9a-f-]{36}$/)
      const poeCred = await readCredentialFile(agentPaths(home, 'poe').pubSecret)
      expect(poeCred.agent_id).toBe(poeIdentity.frontmatter.pub?.identity)

      // 7. User PubClient (user talks in the pub via PubClient directly).
      const user = new PubClient({ baseUrl, cred: userCred })
      userClients.push(user)
      await user.connect()

      // 8. Poe PubClient with a wake source + task store (we emulate
      //    AgentProcess.attachPubWakeSources() inline rather than spinning
      //    up the full Agent process; the wake source is what we care about).
      await mkdir(agentPaths(home, 'poe').root, { recursive: true })
      const poeStore = new TaskStore(home, 'poe')
      const poe = new PubClient({ baseUrl, cred: poeCred })
      userClients.push(poe)
      await poe.connect()
      const wake = new PubWakeSource({
        client: poe,
        agentName: 'poe',
        pubName: 'ops',
        agent: { agent_id: poeCred.agent_id!, handle: '@poe' },
        taskStore: poeStore,
      })
      wake.start()
      wakeSources.push(wake)

      // Capture reply content on user's side. Pub-server (v0.3.x)
      // sends `'message'` events to mentioned agents and lightweight
      // `'conversation_event'` events to non-mentioned ones; the
      // sender also receives a fresh `room_state` whose conversation
      // includes the new message. Catch any of the three patterns.
      const replyContents: string[] = []
      user.onEvent((event) => {
        if (event.type === 'message' && event.data.agent_id !== userCred.agent_id) {
          replyContents.push(event.data.content)
        } else if (
          event.type === 'conversation_event' &&
          event.data.from.agent_id !== userCred.agent_id
        ) {
          replyContents.push(event.data.preview)
        } else if (event.type === 'room_state') {
          for (const msg of event.data.conversation) {
            if (msg.agent_id !== userCred.agent_id) {
              replyContents.push(msg.content)
            }
          }
        }
      })

      // 9. the user @-mentions poe.
      await user.send({
        content: '@poe ping from user',
        mentions: [poeCred.agent_id!],
      })

      // 10. Wait for poe's task store to register the synthetic task.
      let pendingForPoe: Awaited<ReturnType<typeof poeStore.list>> = []
      for (let i = 0; i < 50; i++) {
        pendingForPoe = (await poeStore.list()).filter(
          (t) => t.frontmatter.state === 'pending' && t.frontmatter.title.startsWith('pub.handle'),
        )
        if (pendingForPoe.length > 0) break
        await new Promise((r) => setTimeout(r, 100))
      }
      expect(pendingForPoe.length).toBe(1)
      expect(pendingForPoe[0]?.frontmatter.title).toContain('direct_mention')
      expect(pendingForPoe[0]?.body).toContain('Pub: ops')

      // 11. Poe sends a reply. (Real LoopAgent integration would produce
      //     this via an LLM call; the smoke test asserts the wire works
      //     end-to-end without depending on a real model.)
      const replyResult = await poe.send({
        content: 'pong from poe',
      })
      expect(replyResult.message_id).toMatch(/^[0-9a-f-]{36}$/)

      // 12. the user receives the reply via WS broadcast.
      for (let i = 0; i < 50; i++) {
        if (replyContents.includes('pong from poe')) break
        await new Promise((r) => setTimeout(r, 100))
      }
      expect(replyContents).toContain('pong from poe')
    },
    20_000,
  )
})
