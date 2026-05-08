// One-off: wire an existing Agent into the Studio (the running 'ops' pub).
// Used to repair Agents that were created before the auto-pub-block fix
// landed. After this PR ships, new Agents go through createAgent's
// synthesize-default-pub-block path and don't need this script.
//
// Run via: pnpm tsx scripts/manual-wire-pub.ts <agent-name>
import { readFileSync } from 'node:fs'
import { generateKeypair } from '../src/runtime/pub/keypair-generate.js'
import { writeCredentialFile } from '../src/runtime/pub/keypair.js'
import { readPubSecrets } from '../src/runtime/pub/secrets.js'
import { createIdentityClient, ensureRegistered } from '../src/runtime/pub/identity-client.js'
import { homePaths, agentPaths, pubPaths } from '../src/runtime/storage/layout.js'
import { loadIdentity, writeIdentity } from '../src/runtime/identity/loader.js'

const HOME = process.env.HOME + '/.local/share/2200'
const AGENT = process.argv[2]
const PUB = 'ops'

if (!AGENT) {
  console.error('usage: pnpm tsx scripts/manual-wire-pub.ts <agent-name>')
  process.exit(1)
}

const homeP = homePaths(HOME)
const agentP = agentPaths(HOME, AGENT)
const pubP = pubPaths(HOME, PUB)

const state = JSON.parse(readFileSync(homeP.stateSupervisorJson, 'utf8'))
const pubRecord = state.pubs[PUB]
if (!pubRecord || pubRecord.state !== 'running') {
  console.error(`pub "${PUB}" is not running`)
  process.exit(1)
}
const port = pubRecord.port
const baseUrl = `http://127.0.0.1:${port}`
const issuerUrl = `local://127.0.0.1:${port}`
console.log(`pub: ${PUB} on port ${port}`)

const cred = generateKeypair({ display_name: AGENT, issuer_url: issuerUrl })
await writeCredentialFile(agentP.pubSecret, cred)
console.log(`minted keypair, wrote to ${agentP.pubSecret}`)

const pubSecrets = await readPubSecrets({
  adminSecret: pubP.adminSecret,
  signingKey: pubP.signingKey,
})
const client = createIdentityClient({ baseUrl })
const updated = await ensureRegistered(client, cred, pubSecrets.adminSecret)
console.log(`registered: agent_id=${updated.agent_id}`)
await writeCredentialFile(agentP.pubSecret, updated)

const ident = await loadIdentity(agentP.identity)
const patched = {
  ...ident.frontmatter,
  pub: {
    identity: updated.agent_id ?? '',
    display_name: AGENT,
    handle: `@${AGENT}`,
    credentials: { source: 'file' as const, id: agentP.pubSecret },
    key_version: cred.key_version,
    issuer_url: updated.issuer_url,
    domains: [],
    member_of: [],
  },
}
await writeIdentity(agentP.identity, patched, ident.body)
console.log(`patched identity ${agentP.identity}`)
console.log('done.')
