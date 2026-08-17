/**
 * Client for the 2200 tunnel broker (Epic 19).
 *
 * The broker is a Cloudflare Worker (Simon owns it) that provisions a
 * per-install Cloudflare Tunnel: it creates the tunnel, sets the ingress
 * `{name}.2200.ai → http://127.0.0.1:<web_port>`, creates the proxied DNS
 * record, and returns the tunnel token the box runs `cloudflared` with. This
 * module is the box side: it signs and sends the provision / revoke requests.
 *
 * Auth (v1): an HMAC install-token. The request is signed with a shared
 * `BROKER_INSTALL_SECRET` over a canonical string; identity- and body-bound
 * with a ±300s replay window. The canonicalization MUST match the broker's
 * `signInstallToken` byte-for-byte (see `bin/broker-smoke.mjs` on the broker
 * repo) or every request 401s ... `BROKER_CANON_VERSION` + the unit-test
 * vector guard that. At the public cutover this whole path is swapped for
 * per-box SCUT Ed25519 over the SAME canonical bytes (single swap point).
 */
import { createHmac, createHash } from 'node:crypto'

/** Canonical-string version prefix. Bump only in lockstep with the broker. */
const BROKER_CANON_VERSION = 'v1'
const PROVISION_PATH = '/v1/tunnel/provision'
const REVOKE_PATH = '/v1/tunnel/revoke'

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/**
 * The canonical string the broker HMACs. Exposed (not inlined) so the unit
 * test can pin the exact bytes against the broker's reference vector.
 */
export function brokerCanonicalString(args: {
  method: string
  path: string
  timestamp: string
  identity: string
  body: string
}): string {
  return [
    BROKER_CANON_VERSION,
    args.method.toUpperCase(),
    args.path,
    args.timestamp,
    args.identity,
    sha256Hex(args.body),
  ].join('\n')
}

/** HMAC-SHA256(secret, canonicalString) as lowercase hex. */
export function signBrokerRequest(args: {
  secret: string
  method: string
  path: string
  timestamp: string
  identity: string
  body: string
}): string {
  const canonical = brokerCanonicalString(args)
  return createHmac('sha256', args.secret).update(canonical, 'utf8').digest('hex')
}

export interface BrokerClientOptions {
  /** Broker base URL, e.g. https://2200-tunnel-broker.twentytwohundred.workers.dev */
  brokerUrl: string
  /** Shared install secret (v1). Resolved from the sealed instance store. */
  secret: string
  /** This install's SCUT URI ... the identity header + registry key. */
  scutUri: string
  /** Inject for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch
  /**
   * Inject for tests / determinism. Returns unix SECONDS as a string. Defaults
   * to the real clock. Kept as a seam so the signed timestamp is testable and
   * so nothing here depends on a bare `Date.now()`.
   */
  nowSeconds?: () => string
}

export type ProvisionResult =
  | { ok: true; hostname: string; tunnelToken: string }
  | { ok: false; reason: 'name_taken'; alternatives: string[] }
  | { ok: false; reason: 'rate_limited'; scope: string; message: string }
  | { ok: false; reason: 'invalid'; status: number; message: string }
  | { ok: false; reason: 'unavailable'; message: string }

export type RevokeResult =
  | { ok: true }
  | { ok: false; reason: 'rate_limited'; scope: string; message: string }
  | { ok: false; reason: 'error'; status: number; message: string }
  | { ok: false; reason: 'unavailable'; message: string }

function defaultNowSeconds(): string {
  return String(Math.floor(Date.now() / 1000))
}

async function readBodySnippet(res: Response): Promise<string> {
  try {
    const text = await res.text()
    return text.length > 400 ? `${text.slice(0, 400)}...` : text
  } catch {
    return '(unable to read response body)'
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * Claim (or re-claim) `{desiredName}.2200.ai` and get back the tunnel token to
 * run `cloudflared` with. `webPort` is the loopback port the web server binds;
 * the broker writes it into the tunnel ingress rule.
 */
export async function provisionTunnel(
  opts: BrokerClientOptions,
  req: { desiredName: string; webPort: number },
): Promise<ProvisionResult> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.nowSeconds ?? defaultNowSeconds
  const timestamp = now()
  // Sign and send the SAME bytes: the broker verifies sha256 of the exact body
  // it receives, so the signed body string and the sent body string must be
  // byte-identical. Build once, reuse.
  const body = JSON.stringify({
    desired_name: req.desiredName,
    web_port: req.webPort,
    scut_uri: opts.scutUri,
  })
  const signature = signBrokerRequest({
    secret: opts.secret,
    method: 'POST',
    path: PROVISION_PATH,
    timestamp,
    identity: opts.scutUri,
    body,
  })
  let res: Response
  try {
    res = await fetchImpl(`${opts.brokerUrl.replace(/\/+$/, '')}${PROVISION_PATH}`, {
      method: 'POST',
      headers: {
        'X-2200-Identity': opts.scutUri,
        'X-2200-Timestamp': timestamp,
        Authorization: `Bearer ${signature}`,
        'Content-Type': 'application/json',
      },
      body,
    })
  } catch (err) {
    return {
      ok: false,
      reason: 'unavailable',
      message: err instanceof Error ? err.message : String(err),
    }
  }
  if (res.status === 201) {
    const json = await readJson(res)
    const hostname = typeof json['hostname'] === 'string' ? json['hostname'] : ''
    const tunnelToken = typeof json['tunnel_token'] === 'string' ? json['tunnel_token'] : ''
    if (hostname.length === 0 || tunnelToken.length === 0) {
      return {
        ok: false,
        reason: 'invalid',
        status: 201,
        message: 'broker 201 missing hostname/tunnel_token',
      }
    }
    return { ok: true, hostname, tunnelToken }
  }
  if (res.status === 409) {
    const json = await readJson(res)
    const raw = json['available_alternatives']
    const alternatives = Array.isArray(raw)
      ? raw.filter((x): x is string => typeof x === 'string')
      : []
    return { ok: false, reason: 'name_taken', alternatives }
  }
  if (res.status === 429) {
    const json = await readJson(res)
    const scope = typeof json['scope'] === 'string' ? json['scope'] : 'unknown'
    return { ok: false, reason: 'rate_limited', scope, message: await readBodySnippet(res) }
  }
  return { ok: false, reason: 'invalid', status: res.status, message: await readBodySnippet(res) }
}

/** Tear down a previously-provisioned tunnel + its DNS + release the name. */
export async function revokeTunnel(
  opts: BrokerClientOptions,
  req: { hostname: string },
): Promise<RevokeResult> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.nowSeconds ?? defaultNowSeconds
  const timestamp = now()
  const body = JSON.stringify({ hostname: req.hostname })
  const signature = signBrokerRequest({
    secret: opts.secret,
    method: 'POST',
    path: REVOKE_PATH,
    timestamp,
    identity: opts.scutUri,
    body,
  })
  let res: Response
  try {
    res = await fetchImpl(`${opts.brokerUrl.replace(/\/+$/, '')}${REVOKE_PATH}`, {
      method: 'POST',
      headers: {
        'X-2200-Identity': opts.scutUri,
        'X-2200-Timestamp': timestamp,
        Authorization: `Bearer ${signature}`,
        'Content-Type': 'application/json',
      },
      body,
    })
  } catch (err) {
    return {
      ok: false,
      reason: 'unavailable',
      message: err instanceof Error ? err.message : String(err),
    }
  }
  if (res.status === 204) return { ok: true }
  if (res.status === 429) {
    const json = await readJson(res)
    const scope = typeof json['scope'] === 'string' ? json['scope'] : 'unknown'
    return { ok: false, reason: 'rate_limited', scope, message: await readBodySnippet(res) }
  }
  return { ok: false, reason: 'error', status: res.status, message: await readBodySnippet(res) }
}
