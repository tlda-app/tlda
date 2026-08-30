// fly-edge-proxy.mjs — the front door, on a machine the app deploy does not touch.
//
// The problem it exists for: this app is one Fly machine with one volume, and
// fleet.db lives on that volume, so blue/green is not available — `fly deploy`
// stops the machine and starts it again. Until now `tailscale serve` ran INSIDE
// that machine, so the tailnet name died with it: on 2026-08-18 the box answered
// nothing from 03:11:45Z to roughly 03:12:45Z while Skip was working.
//
// So the tailnet node moves to a second, volume-less process group that the app
// deploy leaves alone (`fly deploy --process-groups app`), and this sits behind
// it. When the app machine is gone, a connection WAITS here instead of failing:
// the browser sees one slow request, not a 502 and not a dead page.
//
// It is a TCP pipe rather than an HTTP proxy on purpose. HTTP/1.1 and WebSocket
// upgrades are the same thing to it, there is no request body to buffer while
// retrying, and the Tailscale-* headers the tailnet proxy adds pass through
// untouched. The only thing it does is decide WHEN to connect.
import net from 'node:net'
import http from 'node:http'
import { readFileSync } from 'node:fs'

// No defaults. An absent value here would silently become somebody's guess about
// how long Skip should stare at a spinner, which is the shape of bug
// fly-entrypoint-live.sh already stopped taking (see its TLDA_DEPLOYMENT block).
function required(name) {
  const value = process.env[name]
  if (!value) {
    console.error(`[edge] FATAL: ${name} is not set`)
    process.exit(1)
  }
  return value
}

const listenPort = Number(required('TLDA_EDGE_LISTEN_PORT'))
const upstreamPointer = process.env.TLDA_EDGE_UPSTREAM_POINTER || null
const configuredUpstream = process.env.TLDA_EDGE_UPSTREAM || null
if (!upstreamPointer && !configuredUpstream) required('TLDA_EDGE_UPSTREAM')
const holdMs = Number(required('TLDA_EDGE_HOLD_SECONDS')) * 1000
const retryMs = Number(required('TLDA_EDGE_RETRY_MS'))
const healthPort = Number(required('TLDA_EDGE_HEALTH_PORT'))

function currentUpstream() {
  const upstream = upstreamPointer ? readFileSync(upstreamPointer, 'utf8').trim() : configuredUpstream
  if (!upstream) throw new Error(`${upstreamPointer || 'TLDA_EDGE_UPSTREAM'} names no upstream`)
  const at = upstream.lastIndexOf(':')
  const host = upstream.slice(0, at)
  const port = Number(upstream.slice(at + 1))
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`invalid edge upstream: ${upstream}`)
  return { upstream, host, port }
}

// Resolve the upstream on every attempt rather than once at boot: the app
// machine's 6PN address is what changes when it is replaced, and a cached one is
// how a proxy keeps dialling a machine that no longer exists.
function connectUpstream() {
  return new Promise((resolve, reject) => {
    let selected
    try { selected = currentUpstream() } catch (error) { reject(error); return }
    const socket = net.connect({ host: selected.host, port: selected.port })
    const fail = (err) => { socket.destroy(); reject(err) }
    socket.once('connect', () => { socket.removeListener('error', fail); resolve({ socket, upstream: selected.upstream }) })
    socket.once('error', fail)
  })
}

async function connectHolding(deadline) {
  for (;;) {
    try {
      return await connectUpstream()
    } catch (err) {
      if (Date.now() >= deadline) throw err
      await new Promise((r) => setTimeout(r, retryMs))
    }
  }
}

const server = net.createServer((client) => {
  // Nothing may be read off the client until there is somewhere to put it.
  client.pause()
  const startedAt = Date.now()

  connectHolding(startedAt + holdMs).then(({ socket: server_, upstream }) => {
    const heldMs = Date.now() - startedAt
    // Only worth a line when it actually waited. A held connection is the app
    // machine being absent, which is the event this whole file is about, so it
    // should be visible in `fly logs` without being every connection.
    if (heldMs >= retryMs) console.log(`[edge] held a connection ${heldMs}ms for ${upstream}`)

    client.pipe(server_)
    server_.pipe(client)
    client.on('error', () => server_.destroy())
    server_.on('error', () => client.destroy())
    client.on('close', () => server_.destroy())
    server_.on('close', () => client.destroy())
    client.resume()
  }).catch((err) => {
    console.error(`[edge] gave up after ${Date.now() - startedAt}ms: ${err.message}`)
    client.destroy()
  })
})

server.listen(listenPort, '127.0.0.1', () => {
  console.log(`[edge] 127.0.0.1:${listenPort} -> ${upstreamPointer || configuredUpstream}, holding up to ${holdMs}ms`)
})

// Health, on its own port and deliberately NOT on the proxied path.
//
// The data path is a TCP pipe precisely because it does not parse; carving a
// `/health` route out of it would mean reading bytes to decide whether they are
// ours, which is the thing that makes an upgrade or a chunked body go wrong.
//
// What it answers is the question you actually have during a cutover, and which
// `curl` against the tailnet name cannot answer: **which half is broken.** A
// reply at all means the edge machine is up and the tailnet reached it; `up`
// tells you whether the app machine is currently answering. Those are different
// failures with different remedies, and from outside they look identical.
const healthServer = http.createServer((_req, res) => {
  connectUpstream()
    .then(({ socket, upstream }) => { socket.destroy(); return { up: true, upstream } })
    .catch(() => ({ up: false, upstream: (() => { try { return currentUpstream().upstream } catch { return null } })() }))
    .then(({ up, upstream }) => {
      res.writeHead(up ? 200 : 503, { 'Content-Type': 'application/json' })
      res.end(`${JSON.stringify({ edge: 'up', upstream, up, holdMs })}\n`)
    })
})

healthServer.listen(healthPort, () => {
  console.log(`[edge] health on :${healthPort}`)
})
