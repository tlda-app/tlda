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
const upstream = required('TLDA_EDGE_UPSTREAM')
const holdMs = Number(required('TLDA_EDGE_HOLD_SECONDS')) * 1000
const retryMs = Number(required('TLDA_EDGE_RETRY_MS'))

const [upstreamHost, upstreamPort] = (() => {
  const at = upstream.lastIndexOf(':')
  return [upstream.slice(0, at), Number(upstream.slice(at + 1))]
})()

// Resolve the upstream on every attempt rather than once at boot: the app
// machine's 6PN address is what changes when it is replaced, and a cached one is
// how a proxy keeps dialling a machine that no longer exists.
function connectUpstream() {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: upstreamHost, port: upstreamPort })
    const fail = (err) => { socket.destroy(); reject(err) }
    socket.once('connect', () => { socket.removeListener('error', fail); resolve(socket) })
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

  connectHolding(startedAt + holdMs).then((server_) => {
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
    console.error(`[edge] gave up on ${upstream} after ${Date.now() - startedAt}ms: ${err.message}`)
    client.destroy()
  })
})

server.listen(listenPort, '127.0.0.1', () => {
  console.log(`[edge] 127.0.0.1:${listenPort} -> ${upstream}, holding up to ${holdMs}ms`)
})
