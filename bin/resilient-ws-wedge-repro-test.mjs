// Regression test: ResilientWS must not wedge when TCP connects but the
// WebSocket upgrade never completes.
//
// This is the shape a Fly deploy can produce: the edge accepts the socket while
// no backend answers the upgrade. There is no 'open', no 'error', and no
// 'close', so the reconnect path must have its own CONNECTING-state deadline.
import assert from 'node:assert/strict'
import net from 'node:net'

import { ResilientWS } from '../shared/resilient-ws.mjs'

const blackholeSockets = new Set()
const blackhole = net.createServer((sock) => {
  blackholeSockets.add(sock)
  sock.on('close', () => blackholeSockets.delete(sock))
  sock.on('error', () => {})
})

await new Promise((resolve) => blackhole.listen(0, '127.0.0.1', resolve))
const port = blackhole.address().port

let retries = 0
let opens = 0
const lines = []

const rws = new ResilientWS({
  url: () => `ws://127.0.0.1:${port}/ws/fleet`,
  label: 'repro',
  initialBackoffMs: 20,
  maxBackoffMs: 40,
  heartbeatTimeoutMs: 2000,
  connectAttemptTimeoutMs: 200,
  random: () => 0,
  log: (s) => lines.push(`  ${s}`),
  onMessage: () => {},
  onAttemptOpen: () => { opens += 1 },
  onRetryScheduled: () => { retries += 1 },
})

try {
  rws.connect()
  await new Promise((resolve) => setTimeout(resolve, 500))

  assert.equal(opens, 0, 'the black-hole server must never complete a WebSocket open')
  assert.ok(retries >= 1, `expected at least one retry; log:\n${lines.join('\n')}`)
  assert.equal(rws.connected, false)
  assert.notEqual(rws.attemptId, '1', 'the client should advance beyond the first wedged generation')
} finally {
  rws.close()
  for (const sock of blackholeSockets) sock.destroy()
  await new Promise((resolve) => blackhole.close(resolve))
}
