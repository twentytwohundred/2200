/**
 * HTTP client for the OpenPub identity layer.
 *
 * Targets `@openpub-ai/pub-server` v0.3.2's pluggable-issuer
 * endpoints (LOCAL_TRUST default per Doug's Flag B call):
 *
 *  - GET  /agents/me         — check if a keypair has already been registered
 *  - POST /admin/register-agent — register a new keypair, get back agent_id (LOCAL only)
 *  - POST /agents/auth       — exchange signed-timestamp for JWT
 *
 * v0.3.x HUB-mode uses different endpoints (POST /agents/register on
 * the hub, POST /agents/auth on the hub). This client targets the
 * pub-server URL in both cases; pub-server's HUB mode proxies the
 * relevant calls to the hub. Consumer code does not fork on mode per
 * Poe's contract reply.
 *
 * v0.3.1 (which PR A pins) recognizes only the hub-mediated paths.
 * This client targets v0.3.2's LOCAL endpoints; running it against a
 * v0.3.1 pub-server returns 404. PR B's tests use a fake HTTP server
 * implementing the v0.3.2 contract; the real-binary integration test
 * lands in PR F (which pins v0.3.2).
 *
 * Why a small dedicated module rather than a bigger pub client: this
 * file is the identity HTTP surface. The websocket transport and
 * messaging API land in PR D as a separate module.
 */
import type { PubCredential } from './keypair.js'
import { composeAuthMessage, credForPub, recordPubAgentId, signMessage } from './keypair.js'

/**
 * Base URL of the pub-server. The client appends paths like
 * `/agents/me` to this. Use `local://<host>:<port>` only as a label
 * for credential storage; the actual base URL must be a real
 * `http://` or `https://` URL.
 */
export interface IdentityClient {
  readonly baseUrl: string
  /**
   * Look up an agent by signed timestamp. Returns the agent record
   * when the keypair is recognized, `null` when the public key is not
   * registered (the v0.3.2 contract returns 404 in this case).
   *
   * Throws on transport errors or unexpected status codes.
   */
  getMe(cred: PubCredential): Promise<AgentRecord | null>

  /**
   * Register a new keypair as an agent. Returns the assigned UUID v7.
   *
   * In LOCAL_TRUST mode, this hits `POST /admin/register-agent` on
   * the pub-server with the `X-OpenPub-Admin-Secret` header set to
   * `adminSecret`. The supervisor knows the per-pub admin secret
   * because it generated it at `cli.pub.create` time. In HUB mode,
   * the pub-server proxies to the hub's `POST /agents/register`
   * (admin secret not used).
   *
   * The `display_name` from the credential is sent verbatim. Pub-server
   * returns 409 if the display name is taken; the client surfaces this
   * as a `RegisterAgentConflict` so the caller can prompt the user
   * for a different name.
   */
  registerAgent(cred: PubCredential, adminSecret?: string): Promise<{ agent_id: string }>

  /**
   * Mint a fresh JWT pair from a signed timestamp. Used at boot and
   * on 401 to refresh tokens. JWTs are NOT persisted; held in memory.
   */
  mintToken(cred: PubCredential): Promise<TokenPair>
}

export interface AgentRecord {
  agent_id: string
  display_name: string
  public_key: string
  key_version: number
}

export interface TokenPair {
  access_token: string
  token_type: string
  /** Seconds until access_token expires (per pub-server v0.3.3 OAuth2-style). */
  expires_in: number
}

/**
 * Errors. The supervisor surfaces these to the user as actionable
 * messages: register-conflict means "pick a different name."
 */
export class RegisterAgentConflict extends Error {
  constructor(public readonly displayName: string) {
    super(`pub display name "${displayName}" already in use`)
    this.name = 'RegisterAgentConflict'
  }
}

export class IdentityClientError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'IdentityClientError'
  }
}

/**
 * Construct a real HTTP client against a pub-server URL. Uses Node's
 * built-in `fetch`. Adds an `X-OpenPub-Agent-ID` header on every
 * request that has an `agent_id` (pre-register requests omit it).
 */
export function createIdentityClient(opts: {
  baseUrl: string
  /** Override fetch for tests. Defaults to the global. */
  fetchImpl?: typeof fetch
  /** Override Date.now for deterministic tests. */
  now?: () => Date
}): IdentityClient {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const now = opts.now ?? (() => new Date())
  const baseUrl = opts.baseUrl.replace(/\/$/, '')

  async function getMe(cred: PubCredential): Promise<AgentRecord | null> {
    if (!cred.agent_id) {
      // Without an agent_id we can't sign a meaningful auth payload.
      // Treat as "not registered."
      return null
    }
    const ts = now().toISOString()
    const sig = signMessage(cred, composeAuthMessage(cred.agent_id, ts))
    const res = await fetchImpl(`${baseUrl}/agents/me`, {
      method: 'GET',
      headers: {
        'X-OpenPub-Agent-ID': cred.agent_id,
        'X-OpenPub-Timestamp': ts,
        'X-OpenPub-Signature': sig,
        'X-OpenPub-Public-Key': cred.public_key,
      },
    })
    if (res.status === 404) return null
    if (!res.ok) {
      throw new IdentityClientError(
        `getMe failed: ${String(res.status)} ${await safeText(res)}`,
        res.status,
      )
    }
    const body = await res.json()
    return parseAgentRecord(body)
  }

  async function registerAgent(
    cred: PubCredential,
    adminSecret?: string,
  ): Promise<{ agent_id: string }> {
    const payload = {
      display_name: cred.display_name,
      public_key: cred.public_key,
      key_version: cred.key_version,
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (adminSecret) headers['X-OpenPub-Admin-Secret'] = adminSecret
    const res = await fetchImpl(`${baseUrl}/admin/register-agent`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    })
    if (res.status === 409) {
      throw new RegisterAgentConflict(cred.display_name)
    }
    if (!res.ok) {
      throw new IdentityClientError(
        `registerAgent failed: ${String(res.status)} ${await safeText(res)}`,
        res.status,
      )
    }
    const body = await res.json()
    const agentId = (body as Record<string, unknown> | null)?.['agent_id']
    if (typeof agentId !== 'string') {
      throw new IdentityClientError('registerAgent response missing agent_id')
    }
    return { agent_id: agentId }
  }

  async function mintToken(cred: PubCredential): Promise<TokenPair> {
    if (!cred.agent_id) {
      throw new IdentityClientError(
        'mintToken requires a registered agent_id; call registerAgent first',
      )
    }
    const ts = now().toISOString()
    const sig = signMessage(cred, composeAuthMessage(cred.agent_id, ts))
    const res = await fetchImpl(`${baseUrl}/agents/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: cred.agent_id,
        timestamp: ts,
        signature: sig,
      }),
    })
    if (!res.ok) {
      throw new IdentityClientError(
        `mintToken failed: ${String(res.status)} ${await safeText(res)}`,
        res.status,
      )
    }
    const body = await res.json()
    const r = (body as Record<string, unknown> | null) ?? {}
    const access = r['access_token']
    const tokenType = r['token_type'] ?? 'Bearer'
    const expiresIn = r['expires_in']
    if (typeof access !== 'string' || typeof expiresIn !== 'number') {
      throw new IdentityClientError(
        'mintToken response missing required fields (expected access_token + expires_in)',
      )
    }
    return {
      access_token: access,
      token_type: typeof tokenType === 'string' ? tokenType : 'Bearer',
      expires_in: expiresIn,
    }
  }

  return { baseUrl, getMe, registerAgent, mintToken }
}

/**
 * Convenience: provision an identity end-to-end. If `cred` already
 * has an `agent_id` and `getMe` confirms it, return the existing
 * record (idempotent re-boot). Otherwise register and return the
 * newly-assigned agent_id (and update the credential in place).
 *
 * `adminSecret` is required when targeting a LOCAL_TRUST pub-server
 * (it gates POST /admin/register-agent via the X-OpenPub-Admin-Secret
 * header). The supervisor reads it from the per-pub state and passes
 * it through.
 */
export async function ensureRegistered(
  client: IdentityClient,
  cred: PubCredential,
  adminSecret?: string,
  pubName?: string,
): Promise<PubCredential> {
  // Pub-server assigns a unique agent_id per (pub, keypair) tuple, so
  // a single cred file holds an entry per pub it's a member of. When
  // pubName is given (recommended; required for multi-pub installs),
  // look up the cred's view of that pub before authenticating; when
  // omitted, fall back to the legacy single-pub flow against the
  // top-level agent_id.
  // INTERIM idempotency (remove when the pub-server ships a working verify
  // route or register-by-public-key idempotency). The bundled pub-server
  // (0.3.3) has NO `GET /agents/me` route ... it returns 404 ("route not
  // found"), indistinguishable from "agent not found". So `getMe` ALWAYS
  // reports "not registered", and without this guard every Agent re-registers
  // on every boot; since the server keys uniqueness on display_name (not
  // public_key), a re-register mints a FRESH agent_id and leaves a shadow
  // entry behind ... the Studio-duplicate bug. Trust a registration already
  // recorded for THIS specific pub and skip the dead verify + re-register.
  //
  // Guard on pub_agent_ids[pubName] SPECIFICALLY, not agentIdForPub() (which
  // falls back to the legacy top-level agent_id): an OpenClaw-imported Agent
  // carries a top-level agent_id from its OLD pub but is NOT yet registered
  // here, and must register against this pub. (The legacy no-pubName flow is
  // left untouched ... every live caller passes a pubName.)
  if (pubName !== undefined && cred.pub_agent_ids?.[pubName]) return cred

  const effective = pubName ? credForPub(cred, pubName) : cred
  // Conditional flow per Poe's contract: GET /agents/me first; if 404,
  // register. Avoids the 409 from re-registering a known keypair.
  const existing = await client.getMe(effective)
  if (existing) {
    if (effective.agent_id !== existing.agent_id) {
      throw new IdentityClientError(
        `agent_id mismatch between credential file and pub-server (${effective.agent_id ?? '<null>'} vs ${existing.agent_id})`,
      )
    }
    if (pubName !== undefined) {
      return recordPubAgentId(cred, pubName, existing.agent_id)
    }
    return cred
  }
  const { agent_id } = await client.registerAgent(cred, adminSecret)
  if (pubName !== undefined) {
    return recordPubAgentId(cred, pubName, agent_id)
  }
  return { ...cred, agent_id }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function parseAgentRecord(body: unknown): AgentRecord {
  const r = (body as Record<string, unknown> | null) ?? {}
  const agent_id = r['agent_id']
  const display_name = r['display_name']
  const public_key = r['public_key']
  const key_version = r['key_version']
  if (
    typeof agent_id !== 'string' ||
    typeof display_name !== 'string' ||
    typeof public_key !== 'string' ||
    typeof key_version !== 'number'
  ) {
    throw new IdentityClientError('agent record response missing required fields')
  }
  return { agent_id, display_name, public_key, key_version }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return '<unreadable>'
  }
}
