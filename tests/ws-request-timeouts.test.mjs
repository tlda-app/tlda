import { WebSocketServer } from 'ws'
import crypto from 'crypto'
import { ResilientWS, rejectWsRequests, resetWsRequestIdleTimers, startWsRequest } from '../shared/fleet-transport.mjs'

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const pending = new Map()

function resetPendingActivity() {
  resetWsRequestIdleTimers(pending)
}

function sendRequest(rws, type, params = {}, opts = {}) {
  const id = crypto.randomUUID()
  const idleTimeoutMs = opts.idleTimeoutMs ?? 45_000
  const deadlineMs = opts.deadlineMs
  return startWsRequest({
    pending,
    id,
    type,
    idleTimeoutMs,
    deadlineMs,
    send: () => rws.send({ id, type, ...params }),
  })
}

const server = new WebSocketServer({ port: 0 })
const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)))

server.on('connection', ws => {
  const heartbeat = setInterval(() => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ event: 'heartbeat' }))
  }, 100)
  ws.on('close', () => clearInterval(heartbeat))
  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString())
    if (msg.type === 'slow-alive') {
      setTimeout(() => ws.send(JSON.stringify({ id: msg.id, result: { ok: true } })), 650)
    } else if (msg.type === 'never-reply') {
      // Heartbeats keep the channel alive, so only an explicit deadline should fire.
    } else if (msg.type === 'silent') {
      clearInterval(heartbeat)
      // Open socket, no progress: idle timeout should fire.
    }
  })
})

const logs = []
const rws = new ResilientWS({
  url: () => `ws://127.0.0.1:${port}`,
  label: 'probe',
  heartbeatTimeoutMs: 1_000,
  log: s => logs.push(s),
  onActivity: resetPendingActivity,
  onMessage: msg => {
    if (msg.event === 'heartbeat') return
    const p = pending.get(msg.id)
    if (!p) return
    msg.error ? p.reject(new Error(msg.error.message || msg.error)) : p.resolve(msg.result)
  },
  onClose: () => {
    rejectWsRequests(pending, ({ type }) => new Error(`WS connection closed (type=${type})`))
  },
})

rws.connect()
while (!rws.connected) await sleep(10)

const slowStart = performance.now()
const slowAlive = await sendRequest(rws, 'slow-alive', {}, { idleTimeoutMs: 200 })
const slowMs = performance.now() - slowStart

let deadlineError = null
try {
  await sendRequest(rws, 'never-reply', {}, { idleTimeoutMs: 200, deadlineMs: 350 })
} catch (e) {
  deadlineError = e.message
}

let idleError = null
try {
  await sendRequest(rws, 'silent', {}, { idleTimeoutMs: 200 })
} catch (e) {
  idleError = e.message
}

rws.close()
server.close()

console.log(JSON.stringify({
  slowAlive: { ok: slowAlive.ok, elapsedMs: Number(slowMs.toFixed(1)) },
  deadlineError,
  idleError,
}, null, 2))
