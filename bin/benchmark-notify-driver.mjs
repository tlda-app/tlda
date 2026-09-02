// Curve 2 driver — chat send → target agent notification arrival.
//
// Two disposable deterministic clients: one SENDS the recorded chat event, the
// other TIMESTAMPS the notification actually arriving. Nothing observable from
// outside the app substitutes for this, which is why the benchmark leaves the
// curve null rather than proxying it with a request round trip.
//
// THE TRAP THIS IS WRITTEN AROUND, from AGENTS.md: a socket that connects to
// /ws/fleet-daemon without sending `daemon-hello` STAYS OPEN, accepts writes,
// and silently drops them — no error, no log line, no ack, and the socket stays
// up. A severed wire reports health. So the handshake is the first thing each
// client does, and open() refuses to return until both are acknowledged.
//
// Auth comes from the installed CLI's own configuration, never from a token
// passed around in chat.

import WebSocket from 'ws'
import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

function cliConfig() {
  const p = join(homedir(), '.config', 'tlda', 'config.json')
  const cfg = JSON.parse(readFileSync(p, 'utf8'))
  const http = cfg.fleetServer || cfg.server
  if (!http) throw new Error('no fleetServer/server in the CLI config')
  return { ws: http.replace(/^http/, 'ws'), token: cfg.tokenRw || cfg.token }
}

function connect({ url, token, name, onMessage }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url}/ws/fleet-daemon`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const timer = setTimeout(() => reject(new Error(`${name}: no daemon-hello ack in 20s`)), 20000)
    let greeted = false

    ws.on('open', () => {
      // FIRST message, always. Anything sent before this is dropped in silence.
      ws.send(JSON.stringify({ type: 'daemon-hello', daemonKey: `benchmark:${name}`, name }))
    })
    ws.on('message', raw => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (!greeted && (msg.type === 'daemon-hello-ack' || msg.type === 'hello-ack' || msg.ok)) {
        greeted = true
        clearTimeout(timer)
        resolve(ws)
        return
      }
      onMessage?.(msg)
    })
    ws.on('error', e => { clearTimeout(timer); reject(new Error(`${name}: ${e.message}`)) })
  })
}

export async function open({ sender, receiver } = {}) {
  if (!sender || !receiver) {
    throw new Error('notify driver needs --notify-sender and --notify-receiver ' +
                    '(two disposable agents; never a real fleet member)')
  }
  const { ws: url, token } = cliConfig()

  const arrivals = []        // measured send → arrival intervals, ms
  let sentAt = null
  let pendingId = null

  const rx = await connect({
    url, token, name: receiver,
    onMessage: msg => {
      // Arrival is the notification reaching the recipient surface — the only
      // thing that earns the word "delivered". An inbox row proves the message
      // is readable; it does NOT prove anyone was notified.
      const isNotice = msg.type === 'notification' || msg.type === 'notify' || msg.type === 'wake'
      if (!isNotice || sentAt === null) return
      if (pendingId && msg.messageId && String(msg.messageId) !== String(pendingId)) return
      arrivals.push(Date.now() - sentAt)
      sentAt = null
      pendingId = null
    },
  })
  const tx = await connect({ url, token, name: sender })

  return {
    /** Send one recorded chat event and start the clock. */
    async send(text, toAgent) {
      sentAt = Date.now()
      pendingId = null
      tx.send(JSON.stringify({
        type: 'chat', to: toAgent ?? receiver, from: sender, text,
      }))
    },
    /** Most recent measured interval, or null when nothing has arrived yet. */
    lastArrivalMs() {
      return arrivals.length ? arrivals.at(-1) : null
    },
    all() { return [...arrivals] },
    async close() {
      try { tx.close() } catch { /* already closed */ }
      try { rx.close() } catch { /* already closed */ }
    },
  }
}
