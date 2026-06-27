// Resolve a tailnet IP → device short-name, for stamping a chat sender's
// physical machine onto message metadata.
//
// On Fly the app sits behind `tailscale serve` (HTTP reverse proxy), so the
// socket peer is 127.0.0.1 and the client's real tailnet IP arrives as the
// first hop of X-Forwarded-For (see the /ws/fleet upgrade). We map that IP to
// the peer's hostname via a cached `tailscale status --json`.
//
// Fail-visible by construction: an unknown IP (LAN/localhost/dev, or before the
// first status load) returns null and the caller omits the machine — it never
// reports a wrong machine.

import { execFile } from 'node:child_process'

const TTL_MS = 60_000
// Fly runs tailscaled on a non-default socket; the dev Macs use the default.
// Try the Fly socket first, then fall back to the default socket.
const FLY_SOCKET = '/var/run/tailscale/tailscaled.sock'

let _map = new Map() // ip (string) -> short device name
let _lastLoad = 0
let _loading = false

function shortName(peer) {
  if (!peer) return null
  // DNSName: "davids-macbook-air-2.cormorant-matrix.ts.net." → first label.
  const dns = (peer.DNSName || '').split('.')[0]
  return dns || peer.HostName || null
}

function ingest(json) {
  const m = new Map()
  const add = (peer) => {
    const n = shortName(peer)
    if (!n) return
    for (const ip of peer.TailscaleIPs || []) m.set(ip, n)
  }
  add(json.Self)
  for (const k of Object.keys(json.Peer || {})) add(json.Peer[k])
  if (m.size) {
    _map = m
    _lastLoad = Date.now()
  }
}

function runStatus(socket, onDone) {
  const args = socket ? [`--socket=${socket}`, 'status', '--json'] : ['status', '--json']
  execFile('tailscale', args, { timeout: 4000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
    if (!err && stdout) {
      try { ingest(JSON.parse(stdout)); onDone(true); return } catch { /* fall through */ }
    }
    onDone(false)
  })
}

function refresh() {
  if (_loading) return
  _loading = true
  // Try the Fly socket; if that fails (dev Mac), try the default socket.
  runStatus(FLY_SOCKET, (ok) => {
    if (ok) { _loading = false; return }
    runStatus(null, () => { _loading = false })
  })
}

/**
 * Synchronous best-effort lookup. Triggers an async refresh when the cache is
 * stale, serving the previous map meanwhile. Returns null when the IP is not a
 * known tailnet peer (caller omits machine — never a wrong machine).
 * @param {string|null|undefined} ip
 * @returns {string|null}
 */
export function resolveMachine(ip) {
  if (!ip) return null
  if (Date.now() - _lastLoad > TTL_MS) refresh()
  const clean = ip.replace(/^::ffff:/, '')
  return _map.get(clean) || _map.get(ip) || null
}

// Warm the cache at startup so the first chat after boot can already resolve.
refresh()
