/**
 * Best-effort detection of the machine's reachable IPv4 addresses, for
 * printing web URLs the operator can open from another device.
 *
 * `primaryLanIp` returns a same-network (LAN) address; `tailscaleIp`
 * returns the node's Tailscale address when the machine is on a tailnet
 * (reachable from anywhere, not just the local subnet). The setup flow
 * prefers Tailscale when present, then LAN, then loopback.
 */
import { networkInterfaces } from 'node:os'

/**
 * True for the Tailscale CGNAT range 100.64.0.0/10 (100.64.x – 100.127.x).
 * A local interface holding such an address is, in practice, Tailscale.
 */
function isTailscaleRange(ip: string): boolean {
  const m = /^100\.(\d+)\./.exec(ip)
  if (!m) return false
  const second = Number(m[1])
  return second >= 64 && second <= 127
}

function privateRank(ip: string): number {
  if (ip.startsWith('192.168.')) return 0
  if (ip.startsWith('10.')) return 1
  // 172.16.0.0 – 172.31.255.255
  const m = /^172\.(\d+)\./.exec(ip)
  if (m) {
    const second = Number(m[1])
    if (second >= 16 && second <= 31) return 2
  }
  return 3 // non-private but routable (e.g. a flat office /24)
}

function nonInternalV4(): string[] {
  const ifaces = networkInterfaces()
  const out: string[] = []
  for (const addrs of Object.values(ifaces)) {
    if (!addrs) continue
    for (const a of addrs) {
      // `family` is 'IPv4' on modern Node; older Node used the number 4.
      const isV4 = a.family === 'IPv4' || (a.family as unknown) === 4
      if (!isV4 || a.internal) continue
      out.push(a.address)
    }
  }
  return out
}

/** The node's Tailscale IPv4 (100.64.0.0/10), or null when not on a tailnet. */
export function tailscaleIp(): string | null {
  return nonInternalV4().find(isTailscaleRange) ?? null
}

/**
 * A same-network LAN IPv4, preferring the common home ranges. Excludes
 * the Tailscale range (that is surfaced separately) so "LAN" means the
 * physical local network.
 */
export function primaryLanIp(): string | null {
  const candidates = nonInternalV4().filter((ip) => !isTailscaleRange(ip))
  if (candidates.length === 0) return null
  candidates.sort((x, y) => privateRank(x) - privateRank(y))
  return candidates[0] ?? null
}
