/**
 * Best-effort detection of the machine's primary LAN IPv4 address.
 *
 * Used by the setup flow to print a web URL the operator can open from
 * another device on the same network (a phone, a laptop), since most
 * 2200 installs live on a home/office LAN behind a private IP rather
 * than a public hostname.
 *
 * Selection: the first non-internal IPv4 in a private range
 * (10/8, 172.16/12, 192.168/16), preferring 192.168 (the common home
 * range) then 10, then 172. Falls back to any non-internal IPv4, then
 * null when only loopback exists (e.g. an isolated container), in which
 * case the caller shows the loopback URL.
 */
import { networkInterfaces } from 'node:os'

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

export function primaryLanIp(): string | null {
  const ifaces = networkInterfaces()
  const candidates: string[] = []
  for (const addrs of Object.values(ifaces)) {
    if (!addrs) continue
    for (const a of addrs) {
      // `family` is 'IPv4' on modern Node; older Node used the number 4.
      const isV4 = a.family === 'IPv4' || (a.family as unknown) === 4
      if (!isV4 || a.internal) continue
      candidates.push(a.address)
    }
  }
  if (candidates.length === 0) return null
  candidates.sort((x, y) => privateRank(x) - privateRank(y))
  return candidates[0] ?? null
}
